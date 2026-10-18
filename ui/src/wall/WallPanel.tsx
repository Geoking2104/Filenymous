import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import { p2pSupported } from "../p2p/config";
import { formatBytes } from "../ux-v3/types";
import { PasswordPrompt } from "../p2p/dropzone/DropOwnerPanel";
import { WALL_TTLS, buildHostLink, buildWallLink, createWall, isExpired, parseHostLink, parseWallLink, wallCode, type HostWallParams, type WallParams, type WallTtl } from "./link";
import { HOST_LABEL, WallHost, type HostState } from "./host";
import { ENDED, WallPeer, type PeerState, type PeerUpload } from "./peer";
import { MAX_TEXT_BYTES, PREVIEW_TEXT_MAX, formatRemaining, previewKind, remainingMs, type ItemMeta } from "./model";
import "./wall.css";

const baseUrl = () => `${location.origin}${location.pathname}`;
type Fetched = { meta: ItemMeta; data: Blob };

/** Every Blob URL created for this wall, revoked on close, wipe and unmount. */
function useBlobUrls() {
  const urls = useRef(new Set<string>());
  const make = useCallback((b: Blob) => {
    const u = URL.createObjectURL(b);
    urls.current.add(u);
    return u;
  }, []);
  const revoke = useCallback((u: string) => {
    URL.revokeObjectURL(u);
    urls.current.delete(u);
  }, []);
  const revokeAll = useCallback(() => {
    for (const u of urls.current) URL.revokeObjectURL(u);
    urls.current.clear();
  }, []);
  useEffect(() => revokeAll, [revokeAll]);
  return useMemo(() => ({ make, revoke, revokeAll }), [make, revoke, revokeAll]);
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function useWallCode(p: Pick<WallParams, "wallId" | "key">) {
  const [code, setCode] = useState("");
  useEffect(() => {
    void wallCode(p).then(setCode);
  }, [p.wallId, p.key]);
  return code;
}

// ---------------------------------------------------------------------------
// Host: #wall-new and #wall-host:...

export function WallHostPanel({ hash }: { hash: string }) {
  const { t } = useTranslation();
  const [params, setParams] = useState<HostWallParams | null>(null);
  const [password, setPassword] = useState<string | undefined>(undefined);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    if (hash === "#wall-new") return;
    let alive = true;
    void parseHostLink(hash).then((p) => {
      if (!alive) return;
      if (p) setParams(p);
      else setInvalid(true);
    });
    return () => {
      alive = false;
    };
  }, [hash]);

  if (!p2pSupported()) return <div className="v3-warn">{t("p2p.unsupported")}</div>;
  if (invalid) return <div className="v3-warn" data-testid="wall-invalid">{t("wall.invalidLink")}</div>;
  if (!params) {
    if (hash !== "#wall-new") return null;
    return (
      <CreateForm
        onCreate={(p, pw) => {
          history.replaceState(null, "", buildHostLink(baseUrl(), p));
          setPassword(pw);
          setParams(p);
        }}
      />
    );
  }
  if (isExpired(params)) return <Ended status="expired" />;
  if (params.password && password === undefined) return <PasswordPrompt onSubmit={setPassword} />;
  return <HostView params={params} password={password} />;
}

function CreateForm({ onCreate }: { onCreate: (p: HostWallParams, password?: string) => void }) {
  const { t } = useTranslation();
  const [ttl, setTtl] = useState<WallTtl>("h1");
  const [burn, setBurn] = useState(false);
  const [hostLeave, setHostLeave] = useState(true);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const p = await createWall({ ttl, burn, hostLeave, password: pw.length > 0 });
    onCreate(p, pw || undefined);
  };

  return (
    <form className="v3-result sw" data-testid="wall-create" onSubmit={submit}>
      <div className="v3-step">{t("wall.createTitle")}</div>
      <p className="v3-muted">{t("wall.createIntro")}</p>
      <fieldset className="sw-field">
        <legend>{t("wall.ttl")}</legend>
        <div className="pz-expiry-choices" role="radiogroup" aria-label={t("wall.ttl")}>
          {(Object.keys(WALL_TTLS) as WallTtl[]).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={ttl === k} className={ttl === k ? "on" : ""} data-testid={`wall-ttl-${k}`} onClick={() => setTtl(k)}>
              {t(`wall.ttlChoice.${k}`)}
            </button>
          ))}
        </div>
      </fieldset>
      <label className="sw-check">
        <input type="checkbox" data-testid="wall-burn" checked={burn} onChange={(e) => setBurn(e.target.checked)} />
        <span>
          <strong>🔥 {t("wall.burn")}</strong>
          <small>{t("wall.burnHint")}</small>
        </span>
      </label>
      <label className="sw-check">
        <input type="checkbox" data-testid="wall-host-leave" checked={hostLeave} onChange={(e) => setHostLeave(e.target.checked)} />
        <span>
          <strong>🔌 {t("wall.hostLeave")}</strong>
          <small>{t("wall.hostLeaveHint")}</small>
        </span>
      </label>
      <label className="v3-field sw-field">
        <span>{t("wall.passwordOptional")}</span>
        <input data-testid="wall-password" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </label>
      <button type="submit" className="pz-btn pz-btn-block" data-testid="wall-create-submit" disabled={busy}>
        {t("wall.createButton")}
      </button>
      <PrivacyNote />
    </form>
  );
}

function HostView({ params, password }: { params: HostWallParams; password?: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<HostState>({ status: "starting", items: [], peers: [], expiresAt: params.expiresAt });
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const hostRef = useRef<WallHost | null>(null);
  const link = useMemo(() => buildWallLink(baseUrl(), params), [params]);
  const code = useWallCode(params);
  const blobs = useBlobUrls();
  const [opened, setOpened] = useState<Map<string, Fetched>>(new Map());

  useEffect(() => {
    const h: WallHost = new WallHost(params, (st) => hostRef.current === h && setState(st), { password, signalUrl: (window as { __FILENYMOUS_WALL_URL__?: string }).__FILENYMOUS_WALL_URL__ });
    hostRef.current = h;
    void h.start();
    return () => {
      hostRef.current = null;
      h.stop();
    };
  }, [params, password]);

  const ended = state.status === "destroyed" || state.status === "expired";
  useEffect(() => {
    if (ended) {
      blobs.revokeAll();
      setOpened(new Map());
    }
  }, [ended, blobs]);

  if (ended) return <Ended status={state.status as "destroyed" | "expired"} host />;

  const fetchItem = async (id: string): Promise<Fetched | null> => {
    const cached = opened.get(id);
    if (cached) return cached;
    const got = hostRef.current?.fetch(id) ?? null;
    if (got) setOpened((m) => new Map(m).set(id, got));
    return got;
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  const destroy = () => {
    if (!window.confirm(t("wall.destroyConfirm"))) return;
    void hostRef.current?.destroy("destroyed");
  };

  const statusText =
    state.status === "starting" ? t("wall.hostStarting")
    : state.status === "reconnecting" ? t("p2p.reconnecting")
    : state.status === "error" ? t("p2p.errorSignal", { message: state.error ?? "" })
    : state.peers.length ? t("wall.peersOnline", { count: state.peers.length })
    : t("wall.waitingPeers");

  return (
    <div className="v3-result sw" data-testid="wall-host" data-status={state.status} data-peers={state.peers.length}>
      <WallHeader expiresAt={params.expiresAt} code={code} burn={params.burn} hostLeave={params.hostLeave} password={params.password} />
      <div className="v3-warn sw-keep" role="alert" data-testid="wall-keep-open">⚠ {t("wall.keepTabOpen")}</div>
      <div className="sw-invite">
        <div className="v3-qr">
          <QRCodeSVG value={link} size={150} level="M" marginSize={2} bgColor="#ffffff" fgColor="#0f172a" title={t("wall.qrTitle")} />
        </div>
        <div className="sw-invite-side">
          <p className="sw-invite-lead">{t("wall.inviteLead")}</p>
          <div className="v3-link-row">
            <input readOnly data-testid="wall-link" value={link} onFocus={(e) => e.currentTarget.select()} aria-label={t("wall.inviteLink")} />
            <button type="button" className="v3-copy-btn" onClick={copyLink}>
              {copied ? `✓ ${t("common.copied")}` : t("common.copy")}
            </button>
          </div>
          {params.password && <p className="sw-small">{t("wall.passwordShareApart")}</p>}
        </div>
      </div>
      <div className="v3-status sw-status" data-testid="wall-host-status" data-status={state.status}>
        <span className="v3-pulse" />
        {statusText}
        {state.peers.length > 0 && (
          <span className="sw-peers" data-testid="wall-peers">
            {state.peers.map((p) => (
              <span key={p.id} className="sw-chip">{labelOf(t, p.label)}</span>
            ))}
          </span>
        )}
      </div>
      <Composer
        onFiles={async (files) => {
          const refused = (await hostRef.current?.addFiles(files)) ?? [];
          setNotice(refused.map((r) => `${r.name} : ${reasonText(t, r.reason)}`).join(" · "));
        }}
        onText={(text) => {
          const r = hostRef.current?.addText(text) ?? null;
          setNotice(r ? reasonText(t, r) : "");
          return !r;
        }}
      />
      {notice && <p className="pz-err" role="alert">{notice}</p>}
      <Grid
        items={mergeItems(state.items, opened)}
        mine={(m) => m.by === HOST_LABEL}
        burn={params.burn}
        live={new Set(state.items.map((i) => i.id))}
        fetchItem={fetchItem}
        blobs={blobs}
        onRemove={(id) => hostRef.current?.removeItem(id)}
      />
      <div className="sw-actions">
        <button type="button" className="sw-danger" data-testid="wall-destroy" onClick={destroy}>
          💥 {t("wall.destroy")}
        </button>
      </div>
      <PrivacyNote />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Peer: #wall:...

export function WallPeerPanel({ hash }: { hash: string }) {
  const { t } = useTranslation();
  const params = useMemo(() => parseWallLink(hash), [hash]);
  if (!p2pSupported()) return <div className="v3-warn">{t("p2p.unsupported")}</div>;
  if (!params) return <div className="v3-warn" data-testid="wall-invalid">{t("wall.invalidLink")}</div>;
  if (isExpired(params)) return <Ended status="expired" />;
  return <PeerView params={params} />;
}

function PeerView({ params }: { params: WallParams }) {
  const { t } = useTranslation();
  const [state, setState] = useState<PeerState | null>(null);
  const [password, setPassword] = useState<string | undefined>(params.password ? undefined : "");
  const [notice, setNotice] = useState("");
  const peerRef = useRef<WallPeer | null>(null);
  const code = useWallCode(params);
  const blobs = useBlobUrls();
  const [opened, setOpened] = useState<Map<string, Fetched>>(new Map());

  useEffect(() => {
    const p: WallPeer = new WallPeer(params, (st) => peerRef.current === p && setState(st), { signalUrl: (window as { __FILENYMOUS_WALL_URL__?: string }).__FILENYMOUS_WALL_URL__ });
    peerRef.current = p;
    const off = p.onWipe(() => {
      blobs.revokeAll();
      setOpened(new Map());
    });
    return () => {
      off();
      peerRef.current = null;
      p.stop();
    };
  }, [params, blobs]);

  useEffect(() => {
    if (password !== undefined) void peerRef.current?.start(password);
  }, [password]);

  if (state && ENDED.includes(state.status)) return <Ended status={state.status as "destroyed" | "expired" | "host-left" | "left"} />;
  if (password === undefined || state?.status === "bad-password") {
    return (
      <PasswordPrompt
        error={state?.status === "bad-password"}
        onSubmit={(pw) => {
          if (pw === password) void peerRef.current?.start(pw);
          setPassword(pw);
        }}
      />
    );
  }

  const s = state;
  const online = s?.status === "online";
  const statusText = !s || s.status === "connecting" || s.status === "handshake" ? t("wall.peerConnecting")
    : s.status === "waiting-host" ? t("wall.peerWaitingHost")
    : s.status === "full" ? t("wall.full")
    : s.status === "error" ? t("p2p.errorSignal", { message: s.error ?? "" })
    : t("wall.peerOnline", { count: s.peers });

  const fetchItem = async (id: string): Promise<Fetched | null> => {
    const cached = opened.get(id);
    if (cached) return cached;
    try {
      const got = await peerRef.current!.fetch(id);
      setOpened((m) => new Map(m).set(id, got));
      return got;
    } catch (e) {
      setNotice(reasonText(t, String((e as Error).message || e)));
      return null;
    }
  };

  const leave = () => {
    if (!window.confirm(t("wall.leaveConfirm"))) return;
    void peerRef.current?.leave();
  };

  return (
    <div className="v3-result sw" data-testid="wall-peer" data-status={s?.status ?? "connecting"}>
      <WallHeader expiresAt={s?.expiresAt ?? params.expiresAt} code={code} burn={params.burn} hostLeave={params.hostLeave} password={params.password} />
      <div className="v3-status sw-status" data-testid="wall-peer-status" data-status={s?.status ?? "connecting"}>
        <span className="v3-pulse" />
        {statusText}
        {s?.label && <span className="sw-chip">{t("wall.youAre", { label: labelOf(t, s.label) })}</span>}
      </div>
      <Composer
        disabled={!online}
        onFiles={async (files) => {
          setNotice("");
          await peerRef.current?.addFiles(files);
        }}
        onText={(text) => {
          const r = peerRef.current?.addText(text);
          if (typeof r === "string") {
            setNotice(reasonText(t, r));
            return false;
          }
          setNotice("");
          return true;
        }}
      />
      {s && <Uploads uploads={s.uploads} />}
      {notice && <p className="pz-err" role="alert">{notice}</p>}
      <Grid
        items={mergeItems(s?.items ?? [], opened)}
        mine={(m) => !!s && (s.mine.includes(m.id) || (!!s.label && m.by === s.label))}
        burn={params.burn}
        live={new Set((s?.items ?? []).map((i) => i.id))}
        fetchItem={online ? fetchItem : async (id) => opened.get(id) ?? null}
        blobs={blobs}
      />
      <div className="sw-actions">
        <button type="button" className="v3-btn-ghost" data-testid="wall-leave" onClick={leave}>
          {t("wall.leave")}
        </button>
      </div>
      <PrivacyNote />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared pieces

type T = ReturnType<typeof useTranslation>["t"];

function labelOf(t: T, by: string): string {
  if (by === HOST_LABEL) return t("wall.byHost");
  const m = /^peer:(\d+)$/.exec(by);
  return m ? t("wall.byPeer", { n: m[1] }) : by;
}

function reasonText(t: T, reason: string): string {
  const known = ["too-many-items", "text-too-large", "item-too-large", "wall-full", "size", "closed", "gone", "offline", "connection-lost"];
  return t(known.includes(reason) ? `wall.reason.${reason}` : "wall.reason.other");
}

function mergeItems(live: ItemMeta[], opened: Map<string, Fetched>): ItemMeta[] {
  const ids = new Set(live.map((i) => i.id));
  return [...live, ...Array.from(opened.values(), (o) => o.meta).filter((m) => !ids.has(m.id))];
}

function WallHeader(props: { expiresAt: number; code: string; burn: boolean; hostLeave: boolean; password: boolean }) {
  const { t } = useTranslation();
  const now = useNow(true);
  const left = remainingMs(props.expiresAt, now);
  return (
    <div className="sw-head">
      <div className="v3-step">{t("wall.title")}</div>
      <div className="sw-meta">
        <span className={`sw-timer${left < 60_000 ? " is-low" : ""}`} data-testid="wall-countdown" title={t("wall.expiresAt", { date: new Date(props.expiresAt).toLocaleString() })}>
          ⏳ {formatRemaining(left)}
        </span>
        {props.code && (
          <span className="sw-code" data-testid="wall-code" title={t("wall.codeHint")}>
            {t("wall.code")} <strong>{props.code}</strong>
          </span>
        )}
      </div>
      <div className="sw-flags">
        <span className="sw-flag">🔐 {t("wall.flagE2ee")}</span>
        {props.burn && <span className="sw-flag" data-testid="wall-flag-burn">🔥 {t("wall.flagBurn")}</span>}
        {props.hostLeave && <span className="sw-flag">🔌 {t("wall.flagHostLeave")}</span>}
        {props.password && <span className="sw-flag">🔑 {t("wall.flagPassword")}</span>}
      </div>
      <p className="sw-small">{t("wall.codeHint")}</p>
    </div>
  );
}

function Composer({ onFiles, onText, disabled }: { onFiles: (f: File[]) => void | Promise<void>; onText: (text: string) => boolean; disabled?: boolean }) {
  const { t } = useTranslation();
  const [drag, setDrag] = useState(false);
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const tooLong = new Blob([text]).size > MAX_TEXT_BYTES;
  return (
    <div className="sw-composer">
      <label
        className={`pz-drop sw-drop${drag ? " is-drag" : ""}${disabled ? " is-disabled" : ""}`}
        data-testid="wall-drop"
        tabIndex={0}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), input.current?.click())}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDrag(true);
        }}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (!disabled && e.dataTransfer.files.length) void onFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <input
          ref={input}
          type="file"
          multiple
          hidden
          disabled={disabled}
          data-testid="wall-file-input"
          onChange={(e) => {
            const files = Array.from(e.currentTarget.files ?? []);
            e.currentTarget.value = "";
            if (files.length) void onFiles(files);
          }}
        />
        <span className="pz-drop-title">{t("wall.dropTitle")}</span>
        <span className="pz-drop-sub">{t("wall.dropSub")}</span>
      </label>
      <form
        className="sw-snippet-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim() && !tooLong && onText(text)) setText("");
        }}
      >
        <textarea
          data-testid="wall-text"
          value={text}
          disabled={disabled}
          rows={3}
          spellCheck={false}
          autoComplete="off"
          placeholder={t("wall.textPlaceholder")}
          aria-label={t("wall.textLabel")}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="pz-btn" data-testid="wall-text-submit" disabled={disabled || !text.trim() || tooLong}>
          {t("wall.textSubmit")}
        </button>
        {tooLong && <span className="pz-err">{t("wall.reason.text-too-large")}</span>}
      </form>
    </div>
  );
}

function Uploads({ uploads }: { uploads: PeerUpload[] }) {
  const { t } = useTranslation();
  const visible = uploads.filter((u) => u.status !== "done").slice(-5);
  if (!visible.length) return null;
  return (
    <ul className="sw-uploads" data-testid="wall-uploads">
      {visible.map((u) => (
        <li key={u.uid} data-status={u.status}>
          {u.kind === "text" ? t("wall.snippet") : u.name} ·{" "}
          {u.status === "sending" ? `${Math.round((u.sent / Math.max(1, u.size)) * 100)} %` : reasonText(t, u.reason ?? "other")}
        </li>
      ))}
    </ul>
  );
}

interface GridProps {
  items: ItemMeta[];
  live: Set<string>;
  mine: (m: ItemMeta) => boolean;
  burn: boolean;
  fetchItem: (id: string) => Promise<Fetched | null>;
  blobs: ReturnType<typeof useBlobUrls>;
  onRemove?: (id: string) => void;
}

function Grid({ items, live, mine, burn, fetchItem, blobs, onRemove }: GridProps) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<{ meta: ItemMeta; url?: string; text?: string } | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const confirmBurn = (m: ItemMeta) => !burn || mine(m) || !live.has(m.id) || window.confirm(t("wall.burnConfirm"));

  const get = async (m: ItemMeta) => {
    if (!confirmBurn(m)) return null;
    setBusy(m.id);
    try {
      return await fetchItem(m.id);
    } finally {
      setBusy(null);
    }
  };

  const download = async (m: ItemMeta) => {
    const got = await get(m);
    if (!got) return;
    const url = blobs.make(got.data);
    const a = document.createElement("a");
    a.href = url;
    a.download = got.meta.name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => blobs.revoke(url), 30_000);
  };

  const open = async (m: ItemMeta) => {
    const got = await get(m);
    if (!got) return;
    const kind = previewKind(got.meta);
    if (kind === "text") {
      const text = await got.data.slice(0, PREVIEW_TEXT_MAX).text();
      setPreview({ meta: got.meta, text: got.data.size > PREVIEW_TEXT_MAX ? `${text}\n…` : text });
    } else if (kind) {
      setPreview({ meta: got.meta, url: blobs.make(got.data) });
    } else {
      setPreview({ meta: got.meta });
    }
  };

  const reveal = async (m: ItemMeta) => {
    const got = await get(m);
    if (got) setRevealed((r) => ({ ...r, [m.id]: "" }));
    if (got) {
      const text = await got.data.text();
      setRevealed((r) => ({ ...r, [m.id]: text }));
    }
  };

  const copyText = async (m: ItemMeta) => {
    let text = revealed[m.id];
    if (text === undefined) {
      const got = await get(m);
      if (!got) return;
      text = await got.data.text();
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  };

  const close = () => {
    if (preview?.url) blobs.revoke(preview.url);
    setPreview(null);
  };

  if (!items.length) return <p className="sw-empty" data-testid="wall-empty">{t("wall.empty")}</p>;

  return (
    <>
      <ul className="sw-grid" data-testid="wall-grid">
        {items.map((m) => {
          const kind = previewKind(m);
          const gone = !live.has(m.id);
          return (
            <li key={m.id} className={`sw-item sw-item--${m.kind}${gone ? " is-local" : ""}`} data-testid="wall-item" data-kind={m.kind} data-name={m.name} data-id={m.id}>
              <div className="sw-item-top">
                <span className="sw-item-icon" aria-hidden="true">{m.kind === "text" ? "📝" : iconFor(kind)}</span>
                <span className="sw-item-by">{labelOf(t, m.by)}</span>
                {gone && <span className="sw-chip" title={t("wall.localCopyHint")}>{t("wall.localCopy")}</span>}
              </div>
              {m.kind === "text" ? (
                revealed[m.id] !== undefined ? (
                  <pre className="sw-secret" data-testid="wall-secret-text">{revealed[m.id]}</pre>
                ) : (
                  <div className="sw-secret is-masked" aria-label={t("wall.masked")}>•••••••• •••• ••••••</div>
                )
              ) : (
                <div className="sw-item-name" title={m.name}>{m.name}</div>
              )}
              <div className="sw-item-size">{formatBytes(m.size)}</div>
              <div className="sw-item-actions">
                {m.kind === "text" ? (
                  <>
                    {revealed[m.id] !== undefined ? (
                      <button type="button" data-testid="wall-hide" onClick={() => setRevealed((r) => { const n = { ...r }; delete n[m.id]; return n; })}>{t("wall.hide")}</button>
                    ) : (
                      <button type="button" data-testid="wall-reveal" disabled={busy === m.id} onClick={() => void reveal(m)}>{t("wall.reveal")}</button>
                    )}
                    <button type="button" data-testid="wall-copy" disabled={busy === m.id} onClick={() => void copyText(m)}>{t("common.copy")}</button>
                  </>
                ) : (
                  <>
                    {kind && <button type="button" data-testid="wall-preview" disabled={busy === m.id} onClick={() => void open(m)}>{t("wall.preview")}</button>}
                    <button type="button" data-testid="wall-download" disabled={busy === m.id} onClick={() => void download(m)}>{t("wall.download")}</button>
                  </>
                )}
                {onRemove && !gone && mine(m) && (
                  <button type="button" className="sw-x" aria-label={t("wall.remove")} title={t("wall.remove")} onClick={() => onRemove(m.id)}>✕</button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {burn && <p className="sw-small">🔥 {t("wall.burnNote")}</p>}
      {preview && <Previewer {...preview} onClose={close} />}
    </>
  );
}

function iconFor(kind: ReturnType<typeof previewKind>) {
  return kind === "image" ? "🖼️" : kind === "video" ? "🎬" : kind === "audio" ? "🎵" : kind === "text" ? "📄" : "📦";
}

/**
 * In-memory previews only: <img>/<video>/<audio> from Blob URLs (no script
 * runs there, SVG included) and plain text through textContent. Nothing is
 * rendered as a document (no iframe, no PDF viewer, no HTML).
 */
function Previewer({ meta, url, text, onClose }: { meta: ItemMeta; url?: string; text?: string; onClose: () => void }) {
  const { t } = useTranslation();
  const kind = previewKind(meta);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Portal into the app root (theme variables) but outside the card, whose
  // backdrop-filter would otherwise trap the fixed overlay.
  return createPortal(
    <div className="sw-modal" role="dialog" aria-modal="true" aria-label={meta.name} data-testid="wall-previewer" data-kind={kind ?? "none"} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sw-modal-card">
        <div className="sw-modal-head">
          <strong>{meta.kind === "text" ? t("wall.snippet") : meta.name}</strong>
          <button type="button" className="sw-x" data-testid="wall-preview-close" aria-label={t("common.close")} onClick={onClose}>✕</button>
        </div>
        <div className="sw-modal-body">
          {kind === "image" && url && <img src={url} alt={meta.name} data-testid="wall-preview-img" referrerPolicy="no-referrer" />}
          {kind === "video" && url && <video src={url} controls playsInline data-testid="wall-preview-video" />}
          {kind === "audio" && url && <audio src={url} controls data-testid="wall-preview-audio" />}
          {kind === "text" && text !== undefined && <pre data-testid="wall-preview-text">{text}</pre>}
          {!kind && <p className="v3-muted">{/\.pdf$/i.test(meta.name) || meta.mime === "application/pdf" ? t("wall.noPdfPreview") : t("wall.noPreview")}</p>}
        </div>
        <p className="sw-small">{t("wall.previewNote")}</p>
      </div>
    </div>,
    document.querySelector(".pz-app") ?? document.body,
  );
}

function PrivacyNote() {
  const { t } = useTranslation();
  return (
    <details className="sw-privacy" data-testid="wall-privacy">
      <summary>{t("wall.privacy.title")}</summary>
      <ul>
        <li>{t("wall.privacy.e2ee")}</li>
        <li>{t("wall.privacy.ram")}</li>
        <li>{t("wall.privacy.relay")}</li>
        <li>{t("wall.privacy.ip")}</li>
        <li>{t("wall.privacy.tor")}</li>
        <li>
          {t("wall.privacy.whistle")} <a href="#report-new">{t("wall.privacy.whistleLink")}</a>
        </li>
        <li>{t("wall.privacy.screens")}</li>
      </ul>
    </details>
  );
}

function Ended({ status, host }: { status: "destroyed" | "expired" | "host-left" | "left"; host?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="v3-result sw sw-ended" data-testid="wall-ended" data-reason={status}>
      <div className="sw-ended-icon" aria-hidden="true">{status === "expired" ? "⌛" : status === "left" ? "👋" : "💥"}</div>
      <div className="v3-step">{t(`wall.ended.${status}`)}</div>
      <p className="v3-muted">{host ? t("wall.ended.wipedHost") : t("wall.ended.wiped")}</p>
      <a className="pz-btn" href="#wall-new">{t("wall.ended.newWall")}</a>
    </div>
  );
}
