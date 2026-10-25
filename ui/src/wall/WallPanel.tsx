import { AgentThreads } from "./AgentThreads";
import { LocalAiTools } from "./LocalAiTools";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { p2pSupported } from "../p2p/config";
import { PasswordPrompt } from "../p2p/dropzone/DropOwnerPanel";
import { pseudonym } from "./feed";
import { WALL_TITLE_MAX, buildHostLink, buildWallLink, createWall, isExpired, parseHostLink, parseWallLink, sanitizeWallTitle, wallCode, type HostWallParams, type WallParams } from "./link";
import { confirmDialog, confirmLeave, useLeaveGuard } from "../home/confirmLeave";
import { WallHost, type HostState } from "./host";
import { mediaSupported } from "./live";
import { ENDED, WallPeer, type PeerState } from "./peer";
import { PrivacyNote, WallRoom, reasonText, type RoomApi, type RoomState } from "./WallRoom";
import { ExportBlockedError, buildSnapshot, buildTranscript, downloadBlob, snapshotBlob, snapshotFilename } from "./snapshot";
import "./wall.css";

const baseUrl = () => `${location.origin}${location.pathname}`;
const wallUrl = () => (window as { __FILENYMOUS_WALL_URL__?: string }).__FILENYMOUS_WALL_URL__;

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
  const [allowAgents, setAllowAgents] = useState(false);
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
        onCreate={(p, pw, agents) => {
          history.replaceState(null, "", buildHostLink(baseUrl(), p));
          setPassword(pw);
          setAllowAgents(agents);
          setParams(p);
        }}
      />
    );
  }
  if (isExpired(params)) return <Ended status="expired" />;
  if (params.password && password === undefined) return <PasswordPrompt onSubmit={setPassword} />;
  return <HostView params={params} password={password} allowAgents={allowAgents} />;
}

function CreateForm({ onCreate }: { onCreate: (p: HostWallParams, password: string | undefined, agents: boolean) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [burn, setBurn] = useState(false);
  const [agents, setAgents] = useState(false);
  const [pw, setPw] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ack || busy) return;
    setBusy(true);
    // No expiry: the wall lives as long as the host keeps it open, and is
    // destroyed when the host leaves.
    const p = await createWall({ title: sanitizeWallTitle(name), burn, hostLeave: true, password: pw.length > 0 });
    onCreate(p, pw || undefined, agents);
  };

  return (
    <form className="v3-result sw" data-testid="wall-create" onSubmit={submit}>
      <div className="v3-step">{t("wall.createTitle")}</div>
      <p className="v3-muted">{t("wall.createIntro")}</p>
      <label className="v3-field sw-field">
        <span>{t("wall.nameLabel")}</span>
        <input
          data-testid="wall-name"
          type="text"
          maxLength={WALL_TITLE_MAX}
          autoComplete="off"
          placeholder={t("wall.namePlaceholder")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <small className="sw-small">{t("wall.nameHint")}</small>
      </label>
      <label className="sw-check">
        <input type="checkbox" data-testid="wall-burn" checked={burn} onChange={(e) => setBurn(e.target.checked)} />
        <span>
          <strong>🔥 {t("wall.burn")}</strong>
          <small>{t("wall.burnHint")}</small>
        </span>
      </label>
      <label className="sw-check">
        <input type="checkbox" data-testid="wall-agents" checked={agents} onChange={(e) => setAgents(e.target.checked)} />
        <span>
          <strong>🤖 {t("wall.agents.allow")}</strong>
          <small>{t("wall.agents.createHint")}</small>
        </span>
      </label>
      <label className="v3-field sw-field">
        <span>{t("wall.passwordOptional")}</span>
        <input data-testid="wall-password" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </label>
      <p className="sw-small" data-testid="wall-lifecycle">🔌 {t("wall.lifecycle")}</p>
      <label className="sw-check sw-ack">
        <input type="checkbox" data-testid="wall-ack-leave" required checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>
          <strong>{t("wall.ackLeave")}</strong>
        </span>
      </label>
      <button type="submit" className="pz-btn pz-btn-block" data-testid="wall-create-submit" disabled={busy || !ack}>
        {t("wall.createButton")}
      </button>
      <PrivacyNote />
    </form>
  );
}

function HostView({ params, password, allowAgents }: { params: HostWallParams; password?: string; allowAgents: boolean }) {
  const { t, i18n } = useTranslation();
  const hostRef = useRef<WallHost | null>(null);
  const [host, setHost] = useState<WallHost | null>(null);
  const [state, setState] = useState<HostState | null>(null);
  const link = useMemo(() => buildWallLink(baseUrl(), params), [params]);
  const code = useWallCode(params);

  useEffect(() => {
    const h: WallHost = new WallHost(params, (st) => hostRef.current === h && setState(st), {
      password,
      signalUrl: wallUrl(),
      name: pseudonym(i18n.language),
      media: mediaSupported(),
      allowAgents,
    });
    hostRef.current = h;
    setHost(h);
    setState(h.state);
    void h.start();
    return () => {
      hostRef.current = null;
      h.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, password]);

  const api = useMemo<RoomApi | null>(
    () =>
      host && {
        say: (x, r) => host.say(x, r),
        react: (id, e) => host.react(id, e),
        poll: (q, o) => host.createPoll(q, o),
        vote: (id, i) => host.vote(id, i),
        closePoll: (id) => host.closePoll(id),
        remove: (id) => host.removeItem(id),
        typing: () => host.typing(),
        burst: (k) => host.burst(k),
        hand: (up) => host.setHand(up),
        rename: (n) => host.rename(n),
        files: async (files, r) => (await host.addFiles(files, r)).map((x) => `${x.name} : ${reasonText(t, x.reason)}`),
        note: (v) => host.addText(v),
        fetch: async (id) => host.fetch(id),
        startLive: async (s, k) => host.startLive(s, k),
        stopLive: (sid) => host.stopAnyLive(sid),
        on: (fn) => host.on(fn),
        pin: (id) => host.pin(id),
        kick: (l) => host.kick(l),
        setAgents: (b) => host.setAgentsAllowed(b),
        createNote: (title, text) => host.createNote(title, text),
        editNote: (id, base, patch) => host.editNote(id, base, patch),
        deleteNote: (id) => host.deleteNote(id),
        lockNote: (id, on) => host.lockNote(id, on),
        pinNote: (id, on) => host.pinNote(id, on),
        addTask: (k, x, o) => host.addTask(k, x, o),
        updateTask: (id, patch) => host.updateTask(id, patch),
        deleteTask: (id) => host.deleteTask(id),
        boardOp: (els) => host.boardOp(els),
        boardElements: () => host.boardElements(),
        approveAgent: (l, sc) => host.approveAgent(l, sc),
        refuseAgent: (l) => host.refuseAgent(l),
        setAgentScope: (l, sc) => host.setAgentScope(l, sc),
        shareWithAgent: (l, id, on) => host.shareWithAgent(l, id, on),
      },
    [host, t],
  );

  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState("");

  async function runExport(format: ExportFormat) {
    const h = hostRef.current;
    if (!h || params.burn) return;
    const st = h.state;
    const lang = i18n.language.startsWith("en") ? "en" : "fr";
    try {
      if (format === "board-json" || format === "board-png") {
        const els = h.boardElements();
        if (!els.some((e) => !e.isDeleted)) return setExportNote(t("wall.board.exportEmpty"));
        const { boardToExcalidrawFile, boardToPng } = await import("./boardExport");
        const blob = format === "board-png" ? await boardToPng(els) : await boardToExcalidrawFile(els);
        downloadBlob(blob, snapshotFilename(params.title, format === "board-png" ? "png" : "excalidraw"));
        h.announceExport();
        return setExportNote(t("wall.export.done"));
      }
      const snap = await buildSnapshot({ title: params.title, burn: params.burn, members: st.members, posts: st.posts, notes: st.notes, tasks: st.tasks, board: h.boardElements(), getItem: (id) => h.exportItem(id) });
      if (format === "json") downloadBlob(snapshotBlob(snap), snapshotFilename(params.title, "json"));
      else downloadBlob(new Blob([buildTranscript(snap, lang)], { type: "text/markdown;charset=utf-8" }), snapshotFilename(params.title, "md"));
      h.announceExport();
      const sk = format === "json" ? snap.skipped : [];
      setExportNote(sk.length ? t("wall.export.skipped", { count: sk.length, names: sk.map((x) => x.name).join(", ") }) : t("wall.export.done"));
    } catch (e) {
      setExportNote(e instanceof ExportBlockedError ? t("wall.export.blockedBurn") : t("wall.export.error"));
    }
  }

  const live = !!state && state.status !== "destroyed" && state.status !== "expired";
  // Closing the window destroys the wall for everyone: same confirmation as
  // every service; on "Quitter" the wall is killed right away.
  useLeaveGuard(live, { onLeave: () => hostRef.current?.destroyNow(), detail: "leave.wallHost" });

  if (state && (state.status === "destroyed" || state.status === "expired")) return <Ended status={state.status} host />;
  if (!state || !api) return null;

  const peers = state.members.length - 1;
  const statusText =
    state.status === "starting" ? t("wall.hostStarting")
    : state.status === "reconnecting" ? t("p2p.reconnecting")
    : state.status === "error" ? t("p2p.errorSignal", { message: state.error ?? "" })
    : peers ? t("wall.peersOnline", { count: peers })
    : t("wall.waitingPeers");

  const room: RoomState = {
    role: "host",
    status: state.status,
    statusText,
    online: true,
    self: "host",
    title: params.title ?? "",
    expiresAt: params.expiresAt,
    burn: params.burn,
    hostLeave: params.hostLeave,
    password: params.password,
    posts: state.posts,
    members: state.members,
    pinned: state.pinned,
    live: state.live,
    media: state.media,
    typing: state.typing,
    agents: state.agents,
    hostMedia: mediaSupported(),
    notice: state.notice,
    mine: [],
    notes: state.notes,
    noteLocks: state.noteLocks,
    noteOverwrite: state.noteOverwrite,
    tasks: state.tasks,
    boardRev: state.boardRev,
    pendingAgents: state.pendingAgents,
    packs: state.packs,
  };
  return (
    <>
    <WallRoom
      state={room}
      api={api}
      code={code}
      invite={{ link }}
      testId="wall-host"
      statusTestId="wall-host-status"
      hostTools={
        host ? (
          <>
            <AgentThreads threads={state.threads} msgs={state.threadMsgs} members={state.members} onApprove={(id) => host.approveThread(id)} onClose={(id) => host.closeThread(id)} />
            <LocalAiTools host={host} />
          </>
        ) : null
      }
      onExport={params.burn ? undefined : () => setExporting(true)}
      exportBlocked={params.burn ? t("wall.export.blockedBurn") : undefined}
      exportNote={exportNote}
      onDestroy={() =>
        void confirmDialog({
          title: t("leave.title"),
          message: t("leave.message"),
          detail: t("leave.wallHost"),
          confirmLabel: t("leave.confirm"),
          cancelLabel: t("leave.cancel"),
          danger: true,
        }).then((ok) => ok && void hostRef.current?.destroy("destroyed"))
      }
    />
    {exporting && <ExportDialog onCancel={() => setExporting(false)} onConfirm={(f) => { setExporting(false); void runExport(f); }} />}
    </>
  );
}

type ExportFormat = "json" | "md" | "board-json" | "board-png";

function ExportDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: (format: ExportFormat) => void }) {
  const { t } = useTranslation();
  const [format, setFormat] = useState<ExportFormat>("json");
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="pz-modal-backdrop" onClick={onCancel}>
      <div className="pz-modal pz-confirm" role="alertdialog" aria-modal="true" aria-labelledby="sw-export-title" aria-describedby="sw-export-warn" data-testid="wall-export-dialog" onClick={(e) => e.stopPropagation()}>
        <h2 id="sw-export-title">📦 {t("wall.export.title")}</h2>
        <p id="sw-export-warn" data-testid="wall-export-warning">⚠️ {t("wall.export.warning")}</p>
        <p className="pz-confirm-detail" lang={t("wall.export.warningEn").startsWith("Export") ? "en" : "fr"}>{t("wall.export.warningEn")}</p>
        <fieldset className="sw-export-formats">
          <legend>{t("wall.export.format")}</legend>
          <label><input type="radio" name="sw-export-format" data-testid="wall-export-format-json" checked={format === "json"} onChange={() => setFormat("json")} /> {t("wall.export.json")}</label>
          <label><input type="radio" name="sw-export-format" data-testid="wall-export-format-md" checked={format === "md"} onChange={() => setFormat("md")} /> {t("wall.export.md")}</label>
          <label><input type="radio" name="sw-export-format" data-testid="wall-export-format-board-json" checked={format === "board-json"} onChange={() => setFormat("board-json")} /> {t("wall.export.boardJson")}</label>
          <label><input type="radio" name="sw-export-format" data-testid="wall-export-format-board-png" checked={format === "board-png"} onChange={() => setFormat("board-png")} /> {t("wall.export.boardPng")}</label>
        </fieldset>
        <div className="pz-confirm-actions">
          <button ref={cancelRef} type="button" className="pz-btn pz-btn-ghost" data-testid="wall-export-cancel" onClick={onCancel}>{t("wall.export.cancel")}</button>
          <button type="button" className="pz-btn" data-testid="wall-export-confirm" onClick={() => onConfirm(format)}>{t("wall.export.confirm")}</button>
        </div>
      </div>
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
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<PeerState | null>(null);
  const [password, setPassword] = useState<string | undefined>(params.password ? undefined : "");
  const peerRef = useRef<WallPeer | null>(null);
  const [peer, setPeer] = useState<WallPeer | null>(null);
  const code = useWallCode(params);

  useEffect(() => {
    const p: WallPeer = new WallPeer(params, (st) => peerRef.current === p && setState(st), {
      signalUrl: wallUrl(),
      name: pseudonym(i18n.language),
      media: mediaSupported(),
    });
    peerRef.current = p;
    setPeer(p);
    return () => {
      peerRef.current = null;
      p.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  useEffect(() => {
    if (password !== undefined) void peerRef.current?.start(password);
  }, [password, peer]);

  // Leaving drops everything this tab shows (the wall itself stays for others).
  useLeaveGuard(state?.status === "online", { onLeave: () => void peerRef.current?.leave() });

  const api = useMemo<RoomApi | null>(
    () =>
      peer && {
        say: (x, r) => peer.say(x, r),
        react: (id, e) => peer.react(id, e),
        poll: (q, o) => peer.createPoll(q, o),
        vote: (id, i) => peer.vote(id, i),
        closePoll: (id) => peer.closePoll(id),
        remove: (id) => peer.removeItem(id),
        typing: () => peer.typing(),
        burst: (k) => peer.burst(k),
        hand: (up) => peer.setHand(up),
        rename: (n) => peer.rename(n),
        files: async (files, r) => {
          await peer.addFiles(files, r);
          return [];
        },
        note: (v) => {
          const r = peer.addText(v);
          return typeof r === "string" ? r : null;
        },
        fetch: (id) => peer.fetch(id),
        startLive: (s, k) => peer.startLive(s, k),
        stopLive: () => peer.stopLive(),
        on: (fn) => peer.on(fn),
        createNote: (title, text) => peer.createNote(title, text),
        editNote: (id, base, patch) => peer.editNote(id, base, patch),
        deleteNote: (id) => peer.deleteNote(id),
        lockNote: (id, on) => peer.lockNote(id, on),
        addTask: (k, x, o) => peer.addTask(k, x, o),
        updateTask: (id, patch) => peer.updateTask(id, patch),
        deleteTask: (id) => peer.deleteTask(id),
        boardOp: (els) => peer.boardOp(els),
        boardElements: () => peer.boardElements(),
      },
    [peer],
  );

  if (state && ENDED.includes(state.status)) return <Ended status={state.status as EndedStatus} />;
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
  if (!api) return null;

  const s = state;
  const statusText = !s || s.status === "connecting" || s.status === "handshake" ? t("wall.peerConnecting")
    : s.status === "waiting-host" ? t("wall.peerWaitingHost")
    : s.status === "full" ? t("wall.full")
    : s.status === "error" ? t("p2p.errorSignal", { message: s.error ?? "" })
    : t("wall.peerOnline", { count: s.members.length });

  const room: RoomState = {
    role: "peer",
    status: s?.status ?? "connecting",
    statusText,
    online: s?.status === "online",
    self: s?.label,
    title: s?.title ?? "",
    expiresAt: s?.expiresAt ?? params.expiresAt,
    burn: params.burn,
    hostLeave: params.hostLeave,
    password: params.password,
    posts: s?.posts ?? [],
    members: s?.members ?? [],
    pinned: s?.pinned ?? null,
    live: s?.live ?? [],
    media: s?.media ?? {},
    typing: s?.typing ?? {},
    agents: s?.agents ?? false,
    hostMedia: s?.hostMedia ?? false,
    notice: s?.notice,
    uploads: s?.uploads,
    mine: s?.mine ?? [],
    notes: s?.notes ?? [],
    noteLocks: s?.noteLocks ?? {},
    noteOverwrite: s?.noteOverwrite,
    tasks: s?.tasks ?? [],
    boardRev: s?.boardRev ?? 0,
  };
  return (
    <WallRoom
      state={room}
      api={api}
      code={code}
      testId="wall-peer"
      statusTestId="wall-peer-status"
      onLeave={() => void confirmLeave().then((ok) => ok && void peerRef.current?.leave())}
    />
  );
}

type EndedStatus = "destroyed" | "expired" | "host-left" | "left" | "kicked" | "agents-off";

function Ended({ status, host }: { status: EndedStatus; host?: boolean }) {
  const { t } = useTranslation();
  const icon = status === "expired" ? "⌛" : status === "left" ? "👋" : status === "kicked" ? "🚪" : status === "agents-off" ? "🤖" : "💥";
  return (
    <div className="v3-result sw sw-ended" data-testid="wall-ended" data-reason={status}>
      <div className="sw-ended-icon" aria-hidden="true">{icon}</div>
      <div className="v3-step">{t(`wall.ended.${status}`)}</div>
      <p className="v3-muted">{host ? t("wall.ended.wipedHost") : t("wall.ended.wiped")}</p>
      <a className="pz-btn" href="#wall-new">{t("wall.ended.newWall")}</a>
    </div>
  );
}
