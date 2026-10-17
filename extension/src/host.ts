/**
 * Share host: owns the WebRTC senders and creates Vault secrets.
 * Runs in the Chrome offscreen document (reason WEB_RTC + CLIPBOARD) or in the
 * Firefox persistent background page, so transfers survive the popup closing.
 * The P2P and Vault code is the web app's own (ui/src), bundled unchanged.
 */
import { P2PSender, type SenderState } from "../../ui/src/p2p/session";
import { buildShareLink } from "../../ui/src/p2p/protocol";
import { buildSecretLink, sealSecret } from "../../ui/src/vault/crypto";
import { VaultError, createSecret } from "../../ui/src/vault/api";
import { APP_URL, installEndpoints } from "./env";
import { copyText } from "./clipboard";
import { FetchTargetError, fetchAsFile } from "./fetchTarget";
import { FETCH_ERRORS, KEEP_OPEN, VAULT_ERRORS, errorMessage, formatBytes } from "./labels";
import {
  HOST_CHANNEL,
  type BgEvent,
  type ChannelMessage,
  type FileShareOptions,
  type HostReply,
  type HostRequest,
  type ShareSource,
  type ShareStatus,
  type ShareSummary,
  type TextShareOptions,
} from "./messages";

export const DEFAULT_FILE_OPTIONS: FileShareOptions = { ttlMinutes: 60, maxDownloads: 1 };
const ONE_READ_TTL_S = 7 * 24 * 3600;
const IDLE_CLOSE_MS = 5 * 60_000;
const MAX_HISTORY = 12;

interface Entry {
  summary: ShareSummary;
  sender?: P2PSender;
  endTimer?: ReturnType<typeof setTimeout>;
}

function mapStatus(s: SenderState, downloads: number): ShareStatus {
  switch (s.status) {
    case "starting":
      return "starting";
    case "waiting":
    case "failed":
      // A failed attempt is retried by the next recipient; the share stays up.
      return s.error === "too-many-attempts" ? "locked" : "waiting";
    case "complete":
      return downloads ? "delivered" : "waiting";
    case "connecting":
    case "connected":
      return "connecting";
    case "transferring":
      return "transferring";
    case "streaming":
      return "streaming";
    case "reconnecting":
      return "reconnecting";
    case "expired":
      return "expired";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
    default:
      return "waiting";
  }
}

export class ShareHost {
  private entries = new Map<string, Entry>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private lastBadge = "";
  private stateTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly bg: (ev: BgEvent) => void,
    private readonly publish: (shares: ShareSummary[]) => void,
    private readonly copy: (text: string) => Promise<boolean> = copyText,
  ) {}

  list(): ShareSummary[] {
    return [...this.entries.values()].map((e) => e.summary).sort((a, b) => b.createdAt - a.createdAt);
  }

  private active(): ShareSummary[] {
    return this.list().filter((s) => s.kind === "p2p" && !s.ended);
  }

  private changed(immediate = false) {
    const flush = () => {
      this.stateTimer = undefined;
      this.publish(this.list());
      this.updateBadge();
    };
    if (immediate) {
      clearTimeout(this.stateTimer);
      flush();
    } else this.stateTimer ??= setTimeout(flush, 250);
  }

  private updateBadge() {
    const act = this.active();
    const sending = act.find((s) => s.status === "transferring");
    const text = sending
      ? `${Math.min(99, Math.floor((sending.confirmedBytes / Math.max(1, sending.totalBytes)) * 100))}%`
      : act.length ? String(act.length) : "";
    if (text !== this.lastBadge) {
      this.lastBadge = text;
      this.bg({ type: "badge", text, color: sending ? "#16a34a" : "#2563eb" });
    }
    clearTimeout(this.idleTimer);
    if (!act.length) this.idleTimer = setTimeout(() => !this.active().length && this.bg({ type: "idle" }), IDLE_CLOSE_MS);
  }

  private notify(source: ShareSource, title: string, message: string, always = false) {
    if (source === "menu" || always) this.bg({ type: "notify", title, message });
  }

  private remember(entry: Entry) {
    this.entries.set(entry.summary.id, entry);
    const ended = this.list().filter((s) => s.ended);
    for (const s of ended.slice(MAX_HISTORY)) this.entries.delete(s.id);
  }

  async handle(req: HostRequest): Promise<HostReply> {
    switch (req.type) {
      case "ping":
        return { ok: true };
      case "list":
        this.changed(true);
        return { ok: true };
      case "share-text":
        return this.shareText(req.text, req.opts ?? { mode: "once" }, req.source);
      case "share-files":
        return this.shareFiles(req.files, req.opts, req.source);
      case "share-url":
        return this.shareUrl(req.url, req.kind, req.source);
      case "stop":
        this.stop(req.id, "stopped");
        return { ok: true };
      case "clear":
        for (const s of this.list()) if (s.ended) this.entries.delete(s.id);
        this.changed(true);
        return { ok: true };
      default:
        return { ok: false, error: "unknown", message: "Requête inconnue." };
    }
  }

  async shareText(text: string, opts: TextShareOptions, source: ShareSource): Promise<HostReply> {
    if (!text || !text.trim()) {
      this.notify(source, "Rien à partager", VAULT_ERRORS.empty!);
      return { ok: false, error: "empty", message: VAULT_ERRORS.empty! };
    }
    try {
      const sealed = await sealSecret(text, opts.password || undefined);
      const once = opts.mode !== "ttl";
      const hours = Math.max(1, Math.min(168, Math.round(opts.hours ?? 24)));
      const ttl = once ? ONE_READ_TTL_S : hours * 3600;
      const { id, expiresAt } = await createSecret(sealed, { ttlSeconds: ttl, reads: once ? 1 : 0 });
      const link = buildSecretLink(APP_URL, id, sealed.key);
      const copied = await this.copy(link);
      const summary: ShareSummary = {
        id: `s-${id}`, kind: "secret", link, names: [`Texte (${formatBytes(new TextEncoder().encode(text).byteLength)})`],
        totalBytes: 0, confirmedBytes: 0, status: "secret", downloads: 0, maxDownloads: once ? 1 : 0,
        expiresAt, createdAt: Date.now(), protected: !!opts.password, ended: true, once,
      };
      this.remember({ summary });
      this.changed(true);
      this.notify(
        source,
        copied ? "Lien secret copié" : "Lien secret créé",
        copied
          ? once ? "Collez-le où vous voulez : le secret s'autodétruit dès sa première lecture." : `Collez-le où vous voulez : lisible pendant ${hours} h.`
          : "Copie automatique impossible : ouvrez la fenêtre Filenymous pour copier le lien.",
      );
      return { ok: true, link, copied, share: summary };
    } catch (e) {
      const code = e instanceof VaultError ? e.code : (e as Error)?.message === "too-large" ? "too-large" : "network";
      const message = VAULT_ERRORS[code] ?? VAULT_ERRORS.network!;
      this.notify(source, "Échec du partage", message);
      return { ok: false, error: code, message };
    }
  }

  async shareFiles(files: File[], opts: FileShareOptions, source: ShareSource): Promise<HostReply> {
    if (!files?.length) return { ok: false, error: "empty", message: "Aucun fichier sélectionné." };
    const ttlMinutes = Math.max(1, Math.min(7 * 24 * 60, Math.round(opts.ttlMinutes || DEFAULT_FILE_OPTIONS.ttlMinutes)));
    const maxDownloads = Math.max(1, Math.floor(opts.maxDownloads || 1));
    const expires = Math.floor((Date.now() + ttlMinutes * 60_000) / 1000);
    const summary: ShareSummary = {
      id: "", kind: "p2p", link: "", names: files.map((f) => f.name), totalBytes: files.reduce((n, f) => n + f.size, 0),
      confirmedBytes: 0, status: "starting", downloads: 0, maxDownloads, expiresAt: expires * 1000, createdAt: Date.now(),
      protected: !!opts.password, ended: false,
    };
    const entry: Entry = { summary };
    const sender = new P2PSender(files, (s) => this.onSender(entry, s), { password: opts.password || undefined, stream: !!opts.stream, expires });
    entry.sender = sender;
    summary.id = `p-${sender.code}`;
    summary.link = buildShareLink(APP_URL, sender.code, sender.secret, expires);
    try {
      await sender.start();
    } catch (e) {
      sender.stop();
      const message = `Impossible de démarrer le partage : ${errorMessage(String((e as Error)?.message || e))}`;
      this.notify(source, "Échec du partage", message);
      return { ok: false, error: "signal", message };
    }
    this.remember(entry);
    const copied = await this.copy(summary.link);
    this.changed(true);
    const label = files.length === 1 ? files[0]!.name : `${files.length} fichiers`;
    this.notify(source, copied ? "Lien copié : gardez le navigateur ouvert" : "Lien créé : gardez le navigateur ouvert", `${label} (${formatBytes(summary.totalBytes)}). ${KEEP_OPEN}`);
    return { ok: true, link: summary.link, copied, share: { ...summary } };
  }

  async shareUrl(url: string, kind: "image" | "media" | "link", source: ShareSource): Promise<HostReply> {
    let file: File;
    try {
      file = await fetchAsFile(url, kind);
    } catch (e) {
      const err = e instanceof FetchTargetError ? e : new FetchTargetError("blocked");
      if (err.code === "blocked" && err.origin) {
        // The background checks whether access to this site was already granted, otherwise asks for it.
        this.bg({ type: "need-permission", origin: err.origin, url, kind });
        return { ok: false, error: "blocked", origin: err.origin, message: FETCH_ERRORS.blocked! };
      }
      const message = FETCH_ERRORS[err.code] + (err.status ? ` (HTTP ${err.status})` : "");
      this.notify(source, "Échec du partage", message);
      return { ok: false, error: err.code, message };
    }
    return this.shareFiles([file], { ...DEFAULT_FILE_OPTIONS, stream: kind === "media" }, source);
  }

  private onSender(entry: Entry, s: SenderState) {
    const sum = entry.summary;
    if (sum.ended) return;
    sum.confirmedBytes = s.status === "transferring" ? s.confirmedBytes : sum.confirmedBytes;
    sum.peerDevice = s.peerDevice ?? sum.peerDevice;
    if (s.downloads > sum.downloads) {
      sum.downloads = s.downloads;
      sum.confirmedBytes = sum.totalBytes;
      const name = sum.names.length === 1 ? sum.names[0] : `${sum.names.length} fichiers`;
      this.notify("menu", "Téléchargement terminé", `${name} a été reçu par le destinataire${sum.peerDevice ? ` (${sum.peerDevice})` : ""}.`);
      if (sum.downloads >= sum.maxDownloads) {
        sum.status = "delivered";
        // Let the completion ack settle before leaving the room (same delay as the CLI).
        entry.endTimer = setTimeout(() => this.stop(sum.id, "complete"), 1600);
        this.changed(true);
        return;
      }
    }
    const status = mapStatus(s, sum.downloads);
    if (status === "locked") {
      this.notify("menu", "Partage bloqué", "Trop de mots de passe erronés : le partage a été arrêté.");
      this.stop(sum.id, "locked");
      return;
    }
    if (status === "expired") {
      this.stop(sum.id, "expired");
      return;
    }
    if (status === "error") sum.error = s.error;
    if (status !== "stopped") sum.status = status;
    this.changed(status !== "transferring");
  }

  stop(id: string, final: ShareStatus) {
    const e = this.entries.get(id);
    if (!e || e.summary.ended) return;
    clearTimeout(e.endTimer);
    e.summary.ended = true;
    e.summary.status = final;
    try {
      e.sender?.stop();
    } catch {
      /* ignore */
    }
    e.sender = undefined;
    this.changed(true);
  }
}

/** Wires a ShareHost to the extension's BroadcastChannel. */
export function startHost(bg: (ev: BgEvent) => void): ShareHost {
  installEndpoints();
  const ch = new BroadcastChannel(HOST_CHANNEL);
  const host = new ShareHost(bg, (shares) => ch.postMessage({ kind: "state", shares } satisfies ChannelMessage));
  ch.onmessage = async (e: MessageEvent<ChannelMessage>) => {
    const m = e.data;
    if (m?.kind !== "req") return;
    let res: HostReply;
    try {
      res = await host.handle(m.req);
    } catch (err) {
      res = { ok: false, error: "internal", message: `Erreur interne : ${String((err as Error)?.message || err)}` };
    }
    ch.postMessage({ kind: "res", id: m.id, res } satisfies ChannelMessage);
  };
  return host;
}
