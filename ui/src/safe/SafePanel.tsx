import { createPortal } from "react-dom";
/**
 * Coffre-fort (persistent personal vault) — distinct from the one-time
 * "Envoyer un secret" service (src/vault/). Local-first: everything is
 * encrypted in the browser and stored in this browser's private storage
 * (SQLite on OPFS); items are shared peer-to-peer over WebRTC.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { EMBED_MODEL, modelAvailable } from "../wall/ai/models";
import { SafeClient } from "./client";
import { clearNow } from "./clipboard";
import { SafeEmbedder } from "./embed";
import { ConflictView } from "./SafeConflict";
import { Onboarding, SetNewPassword, Unlock } from "./SafeGate";
import { ItemDetail, ItemEditor, ItemList } from "./SafeItems";
import { Palette } from "./SafePalette";
import { Security } from "./SafeSecurity";
import { ImportBackup, Settings, exportBackupFile } from "./SafeSettings";
import { needsBackupReminder } from "./persist";
import { parseContactInvite, type ContactInvite } from "./invite";
import { Contacts, PendingShares, ShareDialog, deliveryText } from "./SafeShare";
import { SafeInbox, deliver, type DeliveryResult, type InboxState } from "./transport";
import { CAT_ICON, ClipboardPill, Ctx, overlayRoot, type SafeCtx, type Toast } from "./ui";
import { CATEGORIES, type Category, type Envelope, type ItemSummary, type Peer, type VaultStatus } from "./types";
import { confirmDialog } from "../home/confirmLeave";
import "./safe.css";

type Phase = "loading" | "busy" | "error" | "onboard" | "import" | "locked" | "newpw" | "open";
type Tab = "items" | "contacts" | "security" | "settings";
type Pane = { mode: "empty" } | { mode: "view"; id: string } | { mode: "edit"; id: string } | { mode: "new"; cat: Category } | { mode: "conflict"; id: string };

async function inboxIdOf(secret: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)));
  return `wall-${Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24)}`;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export default function SafePanel() {
  const { t } = useTranslation();
  const [client, setClient] = useState<SafeClient | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [error, setError] = useState("");
  // A contact invite (#safe-contact:<public card>) is read once, then the URL goes back to #safe.
  const [invite, setInvite] = useState<ContactInvite | null>(() => parseContactInvite(location.hash));
  useEffect(() => {
    if (invite && location.hash !== "#safe") history.replaceState(null, "", `${location.pathname}${location.search}#safe`);
    const onHash = () => {
      const inv = parseContactInvite(location.hash);
      if (inv) {
        setInvite(inv);
        history.replaceState(null, "", `${location.pathname}${location.search}#safe`);
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const c = new SafeClient();
    setClient(c);
    c.status()
      .then((s) => {
        setStatus(s);
        setPhase(s.exists ? (s.unlocked ? "open" : "locked") : "onboard");
      })
      .catch((e: Error) => {
        setPhase(e.message === "busy" ? "busy" : "error");
        setError(e.message);
      });
    return () => {
      c.dispose();
    };
  }, []);

  const reload = useCallback(async () => {
    if (!client) return;
    const s = await client.status();
    setStatus(s);
    setPhase(!s.exists ? "onboard" : !s.unlocked ? "locked" : s.needsNewPassword ? "newpw" : "open");
  }, [client]);

  if (phase === "loading" || !client || (!status && phase !== "busy" && phase !== "error")) {
    return (
      <div className="v3-result sw cf-center" data-testid="cf-loading">
        <span className="cf-spinner" aria-hidden="true" /> {t("safe.loading")}
      </div>
    );
  }
  if (phase === "busy") return <div className="v3-warn" data-testid="cf-busy">{t("safe.busy")}</div>;
  if (phase === "error")
    return (
      <div className="v3-warn" data-testid="cf-error">
        {t("safe.unsupported")}
        <small className="cf-block sw-small">{error.slice(0, 160)}</small>
      </div>
    );

  const inviteNote = invite && (
    <p className="v3-warn cf-invite-wait" role="status" data-testid="cf-invite-pending">👤 {t("safe.invite.pendingUnlock")}</p>
  );
  if (phase === "onboard")
    return (
      <>
        {inviteNote}
        <Onboarding client={client} onDone={() => void reload()} onImport={() => setPhase("import")} />
      </>
    );
  if (phase === "import")
    return (
      <div className="v3-result sw cf-onb" data-testid="cf-import-screen">
        <div className="v3-step">{t("safe.backup.importTitle")}</div>
        <p className="v3-muted">{t("safe.backup.importLead")}</p>
        <div className="cf-row cf-row-end">
          <button type="button" className="pz-btn pz-btn-ghost" onClick={() => void reload()}>{t("safe.back")}</button>
          <ImportBackup client={client} hasVault={!!status?.exists} onDone={() => void reload()} label={t("safe.backup.chooseFile")} />
        </div>
      </div>
    );
  if (phase === "locked")
    return (
      <>
      {inviteNote}
      <Unlock
        client={client}
        status={status!}
        onUnlocked={() => void reload()}
        onImport={() => setPhase("import")}
        onDestroy={async () => {
          if (!(await confirmDialog({ title: t("safe.settings.destroyTitle"), message: t("safe.settings.destroyMsg"), confirmLabel: t("safe.settings.destroy"), cancelLabel: t("safe.cancel"), danger: true }))) return;
          await client.destroyVault();
          await reload();
        }}
      />
      </>
    );
  if (phase === "newpw") return <SetNewPassword client={client} onDone={() => void reload()} />;
  return <OpenVault client={client} status={status!} onLocked={() => void reload()} setStatus={setStatus} invite={invite} onInviteDone={() => setInvite(null)} />;
}

function OpenVault({ client, status, onLocked: onLockedProp, setStatus: setStatusProp, invite, onInviteDone }: { client: SafeClient; status: VaultStatus; onLocked: () => void; setStatus: (s: VaultStatus) => void; invite: ContactInvite | null; onInviteDone: () => void }) {
  const { t } = useTranslation();
  // Parent callbacks may change identity on every render: keep stable wrappers so
  // effects (initial load, inbox) don't re-run in a loop.
  const parentRef = useRef({ onLocked: onLockedProp, setStatus: setStatusProp });
  parentRef.current = { onLocked: onLockedProp, setStatus: setStatusProp };
  const onLocked = useCallback(() => parentRef.current.onLocked(), []);
  const setStatus = useCallback((s: VaultStatus) => parentRef.current.setStatus(s), []);
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [tab, setTab] = useState<Tab>(invite ? "contacts" : "items");
  // An invite opened while the vault is already open: show it in Contacts.
  useEffect(() => {
    if (invite) setTab("contacts");
  }, [invite]);
  const [pane, setPane] = useState<Pane>({ mode: "empty" });
  const [filter, setFilter] = useState<Category | "all" | "shared">("all");
  const [palette, setPalette] = useState(false);
  /** "Plus tard" hides the backup reminder for this session only. */
  const [backupDismissed, setBackupDismissed] = useState(false);
  const [shareId, setShareId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pending, setPending] = useState<{ pendingId: string; from: string; title: string; card: string }[]>([]);
  const [inbox, setInbox] = useState<InboxState>("offline");
  const [syncFail, setSyncFail] = useState<Record<string, string[]>>({});
  const [semantic, setSemantic] = useState<"off" | "loading" | "on" | "unavailable">("off");
  const embedder = useRef<SafeEmbedder | null>(null);
  const lastActive = useRef(Date.now());
  const toastSeq = useRef(0);

  const toast = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = ++toastSeq.current;
    setToasts((x) => [...x.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), kind === "err" || kind === "warn" ? 7000 : 4000);
  }, []);

  const refresh = useCallback(async () => {
    const [s, list] = await Promise.all([client.status(), client.list()]);
    setStatus(s);
    setItems(list);
    if (!s.unlocked) onLocked();
  }, [client, onLocked, setStatus]);

  const reloadPeers = useCallback(async () => setPeers(await client.peers()), [client]);

  const lock = useCallback(() => {
    clearNow();
    void client.lock().then(onLocked);
  }, [client, onLocked]);

  /* initial load */
  useEffect(() => {
    void refresh();
    void reloadPeers();
    void client.pendingShares().then(setPending);
  }, [client, refresh, reloadPeers]);

  /* auto-lock on inactivity */
  useEffect(() => {
    const bump = () => (lastActive.current = Date.now());
    const evs = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    evs.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const iv = setInterval(() => {
      if (Date.now() - lastActive.current > status.settings.autoLockMin * 60_000) lock();
    }, 5_000);
    return () => {
      evs.forEach((e) => window.removeEventListener(e, bump));
      clearInterval(iv);
    };
  }, [lock, status.settings.autoLockMin]);

  /* expired shares are purged by list(); re-check every minute */
  useEffect(() => {
    const iv = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(iv);
  }, [refresh]);

  /* Cmd/Ctrl+K */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* P2P inbox: receive shares while the vault is open */
  const onEnvelope = useCallback(
    async (env: Envelope): Promise<DeliveryResult> => {
      const r = await client.receive(env);
      const alias = "alias" in r && r.alias ? r.alias : "from" in r && r.from ? r.from : "?";
      if (r.status === "new") toast(t("safe.inbox.new", { who: alias, title: r.title }), "ok");
      else if (r.status === "updated") toast(t("safe.inbox.updated", { who: alias, title: r.title }), "info");
      else if (r.status === "conflict") toast(t("safe.inbox.conflict", { title: r.title }), "warn");
      else if (r.status === "pending") setPending(await client.pendingShares());
      if (r.status !== "rejected" && r.status !== "stale") await refresh();
      return r.status === "rejected" ? { status: "rejected", reason: r.reason } : { status: r.status };
    },
    [client, refresh, t, toast],
  );

  // The inbox lives as long as the vault is open: always call the latest handler.
  const onEnvelopeRef = useRef(onEnvelope);
  onEnvelopeRef.current = onEnvelope;
  useEffect(() => {
    if (typeof RTCPeerConnection === "undefined") return;
    let box: SafeInbox | null = null;
    let live = true;
    void client.identity().then(async (id) => {
      if (!live) return;
      box = new SafeInbox(await inboxIdOf(id.inboxSecret), id.inboxSecret, (env) => onEnvelopeRef.current(env), setInbox);
      if (live) void box.start();
    });
    return () => {
      live = false;
      box?.stop();
    };
  }, [client]);

  /* local semantic search (opt-in) */
  const indexVectors = useCallback(async () => {
    const e = embedder.current;
    if (!e) return;
    const todo = await client.embeddingTodo();
    for (let i = 0; i < todo.length; i += 16) {
      const batch = todo.slice(i, i + 16);
      const vecs = await e.embed(batch.map((x) => x.text));
      for (let j = 0; j < batch.length; j++) await client.setEmbedding(batch[j]!.id, vecs[j]!);
    }
  }, [client]);

  const startSemantic = useCallback(async () => {
    setSemantic("loading");
    if (!(await modelAvailable(EMBED_MODEL.id))) return setSemantic("unavailable");
    try {
      embedder.current ??= new SafeEmbedder();
      await embedder.current.warm();
      setSemantic("on");
      void indexVectors().catch(() => undefined);
    } catch {
      setSemantic("unavailable");
    }
  }, [indexVectors]);

  useEffect(() => {
    if (status.settings.semantic && semantic === "off") void startSemantic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => embedder.current?.dispose(), []);

  const toggleSemantic = async () => {
    if (semantic === "on") {
      await client.setSettings({ semantic: false });
      embedder.current?.dispose();
      embedder.current = null;
      setSemantic("off");
    } else {
      await client.setSettings({ semantic: true });
      await startSemantic();
    }
    await refresh();
  };

  /* push edits of shared items to the other vaults */
  const pushUpdates = useCallback(
    async (id: string) => {
      const outs = await client.buildUpdates(id).catch(() => []);
      if (!outs.length) return;
      const failed: string[] = [];
      await Promise.all(
        outs.map(async (o) => {
          const r = await deliver(o, { timeoutMs: 30_000 });
          const m = deliveryText(t, r, o.alias);
          if (!m.ok) failed.push(o.peerId);
        }),
      );
      setSyncFail((s) => ({ ...s, [id]: failed }));
      if (failed.length < outs.length) toast(failed.length ? t("safe.sync.partial", { n: outs.length - failed.length, total: outs.length }) : t("safe.sync.done", { n: outs.length }), failed.length ? "warn" : "ok");
    },
    [client, t, toast],
  );

  const ctx: SafeCtx = useMemo(() => ({ client, status, refresh, toast, lock, peers, reloadPeers }), [client, status, refresh, toast, lock, peers, reloadPeers]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const open = (id: string) => {
    setTab("items");
    setPane(byId.get(id)?.hasConflict ? { mode: "conflict", id } : { mode: "view", id });
    setPalette(false);
  };
  const shareItem = shareId ? byId.get(shareId) : undefined;
  const conflicts = items.filter((i) => i.hasConflict).length;

  let paneEl: JSX.Element;
  if (pane.mode === "new" || pane.mode === "edit")
    paneEl = (
      <ItemEditor
        key={pane.mode === "edit" ? pane.id : `new-${pane.cat}`}
        id={pane.mode === "edit" ? pane.id : null}
        category={pane.mode === "new" ? pane.cat : byId.get(pane.id)?.category ?? "note"}
        onSaved={async (id) => {
          await refresh();
          setPane({ mode: "view", id });
          toast(t("safe.saved"), "ok");
          void indexVectors().catch(() => undefined);
          void pushUpdates(id);
        }}
        onCancel={() => setPane(pane.mode === "edit" ? { mode: "view", id: pane.id } : { mode: "empty" })}
      />
    );
  else if (pane.mode === "conflict") paneEl = <ConflictView key={pane.id} id={pane.id} onDone={() => { setPane({ mode: "view", id: pane.id }); void pushUpdates(pane.id); }} />;
  else if (pane.mode === "view" && byId.get(pane.id))
    paneEl = (
      <ItemDetail
        id={pane.id}
        summary={byId.get(pane.id)!}
        onEdit={() => setPane({ mode: "edit", id: pane.id })}
        onShare={() => setShareId(pane.id)}
        onConflicts={() => setPane({ mode: "conflict", id: pane.id })}
        onDeleted={() => setPane({ mode: "empty" })}
        syncState={syncFail[pane.id] ? { failed: syncFail[pane.id]! } : undefined}
        onRetrySync={() => void pushUpdates(pane.id)}
      />
    );
  else
    paneEl = (
      <div className="cf-detail cf-detail--empty" data-testid="cf-pane-empty">
        <div className="cf-empty-art" aria-hidden="true">🗝️</div>
        <p>{items.length ? t("safe.pane.pick") : t("safe.pane.first")}</p>
        <p className="sw-small">{t("safe.pane.kbd", { k: isMac ? "⌘K" : "Ctrl+K" })}</p>
      </div>
    );

  return (
    <Ctx.Provider value={ctx}>
      <div className="cf" data-testid="cf-vault">
        <div className="cf-top">
          <button type="button" className="cf-search" onClick={() => setPalette(true)} data-testid="cf-open-palette">
            <span aria-hidden="true">⌕</span>
            <span>{t("safe.searchCta")}</span>
            <kbd>{isMac ? "⌘K" : "Ctrl K"}</kbd>
          </button>
          <div className="cf-top-actions">
            <span className={`cf-inbox is-${inbox}`} title={t(`safe.inbox.state.${inbox}Hint`)} data-testid="cf-inbox" data-state={inbox}>
              <span className="cf-dot" aria-hidden="true" /> {t(`safe.inbox.state.${inbox}`)}
            </span>
            <details className="cf-new">
              <summary className="pz-btn" data-testid="cf-new">＋ {t("safe.new")}</summary>
              <div className="cf-new-menu">
                {CATEGORIES.map((c) => (
                  <button key={c} type="button" onClick={(e) => { (e.currentTarget.closest("details") as HTMLDetailsElement).open = false; setTab("items"); setPane({ mode: "new", cat: c }); }} data-testid={`cf-new-${c}`}>
                    <span aria-hidden="true">{CAT_ICON[c]}</span> {t(`safe.cat.${c}`)}
                  </button>
                ))}
              </div>
            </details>
            <button type="button" className="pz-btn pz-btn-ghost" onClick={lock} data-testid="cf-lock" aria-label={t("safe.lock")} title={t("safe.lock")}>
              <span aria-hidden="true">🔒</span> <span className="cf-lock-label">{t("safe.lock")}</span>
            </button>
          </div>
        </div>
        {needsBackupReminder(items.length, status.settings.lastBackupAt, backupDismissed) && (
          <div className="v3-warn cf-backup-banner" role="status" data-testid="cf-backup-banner">
            <span>💾 {t("safe.backup.banner")}</span>
            <span className="cf-row">
              <button
                type="button"
                className="pz-btn"
                data-testid="cf-backup-banner-export"
                onClick={async () => {
                  await exportBackupFile(client);
                  await refresh();
                  toast(t("safe.backup.exported"), "ok");
                }}
              >
                ⬇︎ {t("safe.backup.export")}
              </button>
              <button type="button" className="cf-link" data-testid="cf-backup-banner-later" onClick={() => setBackupDismissed(true)}>
                {t("safe.backup.later")}
              </button>
            </span>
          </div>
        )}
        <PendingShares list={pending} onDone={async (id) => { setPending(await client.pendingShares()); if (id) open(id); }} />
        <nav className="cf-tabs" role="tablist">
          {(["items", "contacts", "security", "settings"] as const).map((x) => (
            <button key={x} type="button" role="tab" aria-selected={tab === x} className={tab === x ? "is-on" : ""} onClick={() => setTab(x)} data-testid={`cf-tab-${x}`}>
              {t(`safe.tabs.${x}`)}
              {x === "items" && conflicts > 0 && <span className="cf-badge cf-badge--warn">{conflicts}</span>}
            </button>
          ))}
        </nav>
        {tab === "items" && (
          <div className="cf-split">
            <ItemList items={items} selected={"id" in pane ? pane.id : null} onSelect={open} filter={filter} setFilter={setFilter} />
            {paneEl}
          </div>
        )}
        {tab === "contacts" && <Contacts invite={invite} onInviteDone={onInviteDone} />}
        {tab === "security" && <Security onOpen={open} />}
        {tab === "settings" && <Settings onReset={onLocked} />}
        <details className="sw-privacy cf-privacy">
          <summary>{t("safe.privacy.title")}</summary>
          <ul>
            {["local", "keys", "p2p", "rights", "memory", "storage"].map((k) => (
              <li key={k}>{t(`safe.privacy.${k}`)}</li>
            ))}
          </ul>
        </details>
        <ClipboardPill />
        {createPortal(
          <div className="cf-toasts" aria-live="polite">
            {toasts.map((x) => (
              <div key={x.id} className={`cf-toast is-${x.kind}`} data-testid="cf-toast">{x.text}</div>
            ))}
          </div>,
          overlayRoot(),
        )}
        {palette && <Palette items={items} onClose={() => setPalette(false)} onOpen={open} embedder={embedder.current} semanticReady={semantic === "on"} onToggleSemantic={() => void toggleSemantic()} semanticState={semantic} />}
        {shareItem && <ShareDialog item={shareItem} onClose={() => setShareId(null)} />}
      </div>
    </Ctx.Provider>
  );
}
