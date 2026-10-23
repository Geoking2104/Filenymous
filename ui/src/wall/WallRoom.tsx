/**
 * Sharewall room UI (v2): a Discord-like live wall. Side panel (wall info,
 * members with presence), central feed (messages, files, notes, polls,
 * reactions), live stage (screen/camera) and a composer with an offline emoji
 * picker, mentions, replies, paste/drop. Shared by the host and the peers;
 * every action goes through the host (star topology), in memory only.
 */
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import { formatBytes } from "../ux-v3/types";
import { EmojiPicker } from "./EmojiPicker";
import { AgentsGuide } from "./AgentsGuide";
import { Hl, Markup } from "./Markup";
import { normalizeQuery, searchNotes, searchPosts, searchTasks } from "./search-annotations";
import { NoteEditor, NoteSearchHits, NotesList, liveLock, type NotesApi } from "./NotesUi";
import { AgentShare, PendingAgents, ScopeChips, ScopeEditor, TaskSearchHits, TasksPanel, type TasksApi } from "./CollabUi";
import type { AgentScope, BoardElement, Task } from "./collab";
import { setLocalExcalidrawAssets } from "./boardExport";

// The whiteboard (Excalidraw) is only downloaded when someone opens it.
const Whiteboard = lazy(() => {
  setLocalExcalidrawAssets();
  return import("./Whiteboard");
});
import type { NoteLock, SharedNote } from "./notes";
import { QUICK_REACTIONS } from "./emoji";
import {
  BURSTS,
  MAX_LIVE,
  MAX_MSG_CHARS,
  POLL_MAX,
  POLL_MIN,
  avatarHue,
  groupPosts,
  initials,
  pollTotals,
  type BurstKind,
  type LiveInfo,
  type LiveKind,
  type Member,
  type Post,
  type WallEvent,
} from "./feed";
import { captureMedia, mediaSupported, stopStream } from "./live";
import { plainPreview } from "./markup";
import { MAX_TEXT_BYTES, PREVIEW_TEXT_MAX, formatRemaining, previewKind, remainingMs, type ItemMeta } from "./model";
import type { PeerUpload } from "./peer";

export type Fetched = { meta: ItemMeta; data: Blob };
type T = ReturnType<typeof useTranslation>["t"];

/** Inline media is fetched automatically up to this size (non-burn walls only). */
export const INLINE_MAX = 32 * 1024 * 1024;

export interface RoomState {
  role: "host" | "peer";
  status: string;
  statusText: string;
  online: boolean;
  self?: string;
  /** Wall display name ("" = untitled). */
  title: string;
  /** 0 = no expiry (lives with the host). */
  expiresAt: number;
  burn: boolean;
  hostLeave: boolean;
  password: boolean;
  posts: Post[];
  members: Member[];
  pinned: string | null;
  live: LiveInfo[];
  media: Record<string, MediaStream>;
  typing: Record<string, number>;
  agents: boolean;
  hostMedia: boolean;
  notice?: { code: string; at: number; retryMs?: number };
  uploads?: PeerUpload[];
  /** Ids of items this tab authored. */
  mine: string[];
  notes: SharedNote[];
  noteLocks: Record<string, NoteLock>;
  noteOverwrite?: { id: string; by: string; at: number };
  tasks: Task[];
  /** Bumped on each whiteboard change. */
  boardRev: number;
  /** Host only: agents waiting for approval. */
  pendingAgents?: Array<{ label: string; name: string }>;
  /** Host only: context packs (agent label → shared ids). */
  packs?: Record<string, string[]>;
}

export interface RoomApi extends NotesApi, TasksApi {
  boardOp(els: unknown[]): void;
  boardElements(): BoardElement[];
  approveAgent?(label: string, scope: AgentScope): void;
  refuseAgent?(label: string): void;
  setAgentScope?(label: string, scope: AgentScope): void;
  shareWithAgent?(label: string, id: string, on: boolean): void;
  say(text: string, replyTo?: string): void | Promise<void>;
  react(id: string, emoji: string): void | Promise<void>;
  poll(question: string, options: string[]): void | Promise<void> | boolean;
  vote(id: string, option: number): void | Promise<void>;
  closePoll(id: string): void | Promise<void>;
  remove(id: string): void | Promise<void>;
  typing(): void;
  burst(kind: BurstKind): void;
  hand(up: boolean): void | Promise<void>;
  rename(name: string): void | Promise<void>;
  files(files: File[], replyTo?: string): Promise<string[]>;
  note(text: string): string | null;
  fetch(id: string): Promise<Fetched | null>;
  startLive(stream: MediaStream, kind: LiveKind): Promise<string | null>;
  stopLive(sid: string): void;
  on(fn: (e: WallEvent) => void): () => void;
  pin?(id: string | null): void;
  kick?(label: string): void;
  setAgents?(allowed: boolean): void;
}

export interface RoomProps {
  state: RoomState;
  api: RoomApi;
  code: string;
  invite?: { link: string };
  onDestroy?: () => void;
  onLeave?: () => void;
  /** Host only: export the wall (opens the confirmation). */
  onExport?: () => void;
  /** Host only: why export is unavailable (e.g. self-destruct wall). */
  exportBlocked?: string;
  exportNote?: string;
  testId: string;
  statusTestId: string;
  /** Host only: on-device AI tools (search model, captions), shown under the agents toggle. */
  hostTools?: ReactNode;
}

// ---------------------------------------------------------------------------

/** Every Blob URL created for this wall, revoked on close, wipe and unmount. */
export function useBlobUrls() {
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
type Blobs = ReturnType<typeof useBlobUrls>;

export function useNow(active: boolean, every = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(id);
  }, [active, every]);
  return now;
}

export function reasonText(t: T, reason: string): string {
  const known = ["too-many-items", "text-too-large", "item-too-large", "wall-full", "size", "closed", "gone", "offline", "connection-lost", "rate-limited"];
  return t(known.includes(reason) ? `wall.reason.${reason}` : "wall.reason.other");
}

function fallbackName(t: T, label: string): string {
  if (label === "host") return t("wall.byHost");
  const m = /^peer:(\d+)$/.exec(label);
  return m ? t("wall.byPeer", { n: m[1] }) : label;
}

function postPreview(t: T, p: Post): string {
  if (p.kind === "msg") return plainPreview(p.text ?? "");
  if (p.kind === "poll") return `📊 ${p.poll?.question ?? ""}`;
  if (p.kind === "note") return `🔒 ${t("wall.snippet")}`;
  return `📎 ${p.item?.name ?? ""}`;
}

function Avatar({ m, size = 36 }: { m: Pick<Member, "label" | "name" | "agent">; size?: number }) {
  const hue = avatarHue(m.label);
  return (
    <span className="sw2-avatar" aria-hidden="true" style={{ width: size, height: size, background: `hsl(${hue} 38% 40%)`, fontSize: size * 0.38 }}>
      {m.agent ? "🤖" : initials(m.name)}
    </span>
  );
}

// ---------------------------------------------------------------------------

export function WallRoom({ state: s, api, code, invite, onDestroy, onLeave, onExport, exportBlocked, exportNote, testId, statusTestId, hostTools }: RoomProps) {
  const { t, i18n } = useTranslation();
  const blobs = useBlobUrls();
  const [opened, setOpened] = useState<Map<string, Fetched>>(new Map());
  const [ghosts, setGhosts] = useState<Post[]>([]);
  const [drawer, setDrawer] = useState(false);
  const [sideTab, setSideTab] = useState<"members" | "notes" | "tasks">("members");
  const [boardOpen, setBoardOpen] = useState(false);
  const [agentsGuideOpen, setAgentsGuideOpen] = useState(false);
  const [openNote, setOpenNote] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ target: "composer" } | { target: "post"; id: string } | null>(null);
  const [preview, setPreview] = useState<{ meta: ItemMeta; url?: string; text?: string } | null>(null);
  const [notice, setNotice] = useState<{ text: string; at: number } | null>(null);
  const [bursts, setBursts] = useState<Array<{ id: number; e: string; x: number; d: number }>>([]);
  const composerInsert = useRef<((s: string) => void) | null>(null);
  const names = useRef(new Map<string, string>());
  const postsRef = useRef(new Map<string, Post>());
  const openedRef = useRef(opened);
  openedRef.current = opened;
  /** Items being fetched: with burn, the host announces the removal before the bytes arrive. */
  const fetching = useRef(new Set<string>());
  const now = useNow(true);
  // Search: client-only live filter of the feed (nothing is sent anywhere).
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  for (const m of s.members) names.current.set(m.label, m.name);
  for (const p of s.posts) postsRef.current.set(p.id, p);
  const nameOf = useCallback((label: string) => s.members.find((m) => m.label === label)?.name ?? names.current.get(label) ?? fallbackName(t, label), [s.members, t]);
  const memberOf = useCallback(
    (label: string): Member => s.members.find((m) => m.label === label) ?? { label, name: nameOf(label), agent: false, host: label === "host", hand: false, media: false },
    [s.members, nameOf],
  );
  const isHost = s.role === "host";
  const mine = (p: Post) => p.by === s.self || (!!p.item && s.mine.includes(p.id));

  const say = (text: string) => setNotice({ text, at: Date.now() });
  const registerInsert = useCallback((fn: (s: string) => void) => {
    composerInsert.current = fn;
  }, []);

  // Burst animations (others' bursts arrive as events; ours are spawned on click).
  const burstSeq = useRef(0);
  const spawn = useCallback((kind: BurstKind) => {
    const reduce = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const n = reduce ? 1 : 10;
    const items = Array.from({ length: n }, () => ({ id: ++burstSeq.current, e: BURSTS[kind], x: reduce ? 50 : 10 + Math.random() * 80, d: Math.random() * 0.5 }));
    setBursts((b) => [...b.slice(-40), ...items]);
    setTimeout(() => setBursts((b) => b.filter((x) => !items.includes(x))), 2200);
  }, []);

  useEffect(
    () =>
      api.on((e) => {
        if (e.type === "burst") spawn(e.kind);
        if (e.type === "unpost") {
          const p = postsRef.current.get(e.id);
          if (p && (openedRef.current.has(e.id) || fetching.current.has(e.id))) setGhosts((g) => (g.some((x) => x.id === e.id) ? g : [...g, p]));
        }
      }),
    [api, spawn],
  );

  useEffect(() => {
    if (s.notice) say(s.notice.code === "rate-limited" ? t("wall.notice.rate-limited", { s: Math.ceil((s.notice.retryMs ?? 1000) / 1000) }) : t(`wall.notice.${s.notice.code}`, { defaultValue: t("wall.reason.other") }));
  }, [s.notice, t]);

  useEffect(() => {
    if (!s.noteOverwrite) return;
    const n = s.notes.find((x) => x.id === s.noteOverwrite!.id);
    say(t("wall.notes.overwritten", { title: n?.title || t("wall.notes.untitled"), name: nameOf(s.noteOverwrite.by) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.noteOverwrite]);

  // Open the note you just created as soon as the host confirms it.
  const createdFrom = useRef<Set<string> | null>(null);
  useEffect(() => {
    const before = createdFrom.current;
    if (!before) return;
    const n = s.notes.find((x) => !before.has(x.id) && x.by === s.self);
    if (n) {
      createdFrom.current = null;
      setOpenNote(n.id);
    }
  }, [s.notes, s.self]);

  // A note deleted by someone else closes its editor.
  useEffect(() => {
    if (openNote && !s.notes.some((n) => n.id === openNote)) setOpenNote(null);
  }, [s.notes, openNote]);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice((n) => (n === notice ? null : n)), 6000);
    return () => clearTimeout(id);
  }, [notice]);

  const fetchItem = async (id: string): Promise<Fetched | null> => {
    const cached = openedRef.current.get(id);
    if (cached) return cached;
    fetching.current.add(id);
    try {
      const got = await api.fetch(id);
      if (got) {
        openedRef.current = new Map(openedRef.current).set(id, got);
        setOpened((m) => new Map(m).set(id, got));
      } else setGhosts((g) => g.filter((x) => x.id !== id));
      return got;
    } catch (e) {
      setGhosts((g) => g.filter((x) => x.id !== id));
      say(reasonText(t, String((e as Error).message || e)));
      return null;
    } finally {
      fetching.current.delete(id);
    }
  };

  const live = new Set(s.posts.map((p) => p.id));
  const feed = useMemo(() => {
    const ids = new Set(s.posts.map((p) => p.id));
    const extra = ghosts.filter((g) => !ids.has(g.id));
    return extra.length ? [...s.posts, ...extra].sort((a, b) => a.at - b.at) : s.posts;
  }, [s.posts, ghosts]);

  const searching = normalizeQuery(query) !== "";
  const shown = useMemo(() => (searching ? searchPosts(feed, query) : feed), [feed, query, searching]);
  const noteHits = useMemo(() => (searching ? searchNotes(s.notes, query) : []), [s.notes, query, searching]);
  const taskHits = useMemo(() => (searching ? searchTasks(s.tasks, query) : []), [s.tasks, query, searching]);
  const limitedAgents = s.members.filter((m) => m.agent && m.scope?.limited);
  const shareFor = isHost && api.shareWithAgent && limitedAgents.length
    ? (id: string) => <AgentShare id={id} agents={limitedAgents} packs={s.packs ?? {}} onShare={api.shareWithAgent!} />
    : undefined;
  const subscribeBoard = useCallback((fn: (els: BoardElement[]) => void) => api.on((e) => e.type === "board" && fn(e.elements)), [api]);
  const dark = typeof document !== "undefined" && document.documentElement.dataset.theme === "dark";
  const openNoteById = (id: string) => {
    setOpenNote(id);
    setSideTab("notes");
    setDrawer(false);
  };
  const editing = openNote ? s.notes.find((n) => n.id === openNote) : undefined;
  const notesWriting = s.notes.filter((n) => { const l = liveLock(s.noteLocks[n.id], now); return !!l && l.label !== s.self; }).length;
  const openSearch = () => {
    setSearchOpen(true);
    requestAnimationFrame(() => searchRef.current?.focus());
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        openSearch();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const confirmBurn = (p: Post) => !s.burn || mine(p) || !live.has(p.id) || window.confirm(t("wall.burnConfirm"));

  const openPreview = async (p: Post) => {
    if (!p.item || !confirmBurn(p)) return;
    const got = await fetchItem(p.id);
    if (!got) return;
    const kind = previewKind(got.meta);
    if (kind === "text") {
      const text = await got.data.slice(0, PREVIEW_TEXT_MAX).text();
      setPreview({ meta: got.meta, text: got.data.size > PREVIEW_TEXT_MAX ? `${text}\n…` : text });
    } else if (kind) setPreview({ meta: got.meta, url: blobs.make(got.data) });
    else setPreview({ meta: got.meta });
  };

  const download = async (p: Post) => {
    if (!p.item || !confirmBurn(p)) return;
    const got = await fetchItem(p.id);
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

  const closePreview = () => {
    if (preview?.url) blobs.revoke(preview.url);
    setPreview(null);
  };

  const react = (id: string, emoji: string) => void Promise.resolve(api.react(id, emoji)).catch(() => say(reasonText(t, "offline")));

  const onFiles = async (files: File[]) => {
    if (!files.length || !s.online) return;
    const refused = await api.files(files, replyTo ?? undefined);
    setReplyTo(null);
    if (refused.length) say(refused.join(" · "));
  };

  const goLive = async (kind: LiveKind, mic: boolean) => {
    if (!window.confirm(t(kind === "screen" ? "wall.live.consentScreen" : "wall.live.consentCamera"))) return;
    let stream: MediaStream;
    try {
      stream = await captureMedia(kind, mic);
    } catch {
      return say(t("wall.live.denied"));
    }
    const r = await api.startLive(stream, kind);
    if (r) {
      stopStream(stream);
      say(t(`wall.live.fail.${r}`, { defaultValue: t("wall.live.fail.other"), max: MAX_LIVE }));
    }
  };

  const agentsHere = s.members.filter((m) => m.agent);
  const typingNames = Object.entries(s.typing)
    .filter(([l, at]) => l !== s.self && now - at < 4000 && s.members.some((m) => m.label === l))
    .map(([l]) => nameOf(l));
  const pinned = s.pinned ? s.posts.find((p) => p.id === s.pinned) : undefined;
  const me = s.self ? s.members.find((m) => m.label === s.self) : undefined;
  const myLive = s.live.find((l) => l.by === s.self);
  const left = remainingMs(s.expiresAt, now);
  const canLive = mediaSupported() && s.hostMedia;

  return (
    <div className={`v3-result sw sw2${drawer ? " is-drawer" : ""}`} data-testid={testId} data-status={s.status} data-peers={Math.max(0, s.members.length - 1)}>
      <header className="sw2-top">
        <button type="button" className="sw2-iconbtn sw2-drawer-btn" data-testid="wall-members-toggle" aria-expanded={drawer} aria-label={t("wall.members")} onClick={() => setDrawer((d) => !d)}>
          ☰ <span className="sw2-count">{s.members.length}</span>
        </button>
        <div className="sw2-title">
          <strong className="sw2-name" data-testid="wall-title" title={s.title || t("wall.untitled")}>{s.title || t("wall.untitled")}</strong>
          <span className="v3-status sw2-status" data-testid={statusTestId} data-status={s.status}>
            <span className="v3-pulse" />
            {s.statusText}
          </span>
        </div>
        {code && (
          <span className="sw2-codechip" data-testid="wall-code" title={t("wall.codeHint")}>
            <span className="sw2-codechip-k">{t("wall.code")}</span> <strong>{code}</strong>
          </span>
        )}
        <button type="button" className="sw2-people" data-testid="wall-people" aria-label={t("wall.membersCount", { count: s.members.length })} title={t("wall.membersCount", { count: s.members.length })} onClick={() => { setSideTab("members"); setDrawer(true); }}>
          <span className="sw2-people-stack" aria-hidden="true">
            {s.members.slice(0, 3).map((m) => (
              <Avatar key={m.label} m={m} size={22} />
            ))}
          </span>
          <span className="sw2-people-n">{s.members.length}</span>
        </button>
        <div className={`sw2-search${searchOpen || query ? " is-open" : ""}`} role="search">
          <button type="button" className="sw2-iconbtn sw2-search-btn" data-testid="wall-search-toggle" aria-label={t("wall.search.open")} title={t("wall.search.open")} onClick={openSearch}>
            🔍
          </button>
          <input
            ref={searchRef}
            type="search"
            data-testid="wall-search"
            maxLength={100}
            placeholder={t("wall.search.placeholder")}
            aria-label={t("wall.search.label")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                setSearchOpen(false);
              }
            }}
          />
          {query && (
            <button type="button" className="sw2-search-clear" data-testid="wall-search-clear" aria-label={t("wall.search.clear")} title={t("wall.search.clear")} onClick={() => { setQuery(""); searchRef.current?.focus(); }}>
              ✕
            </button>
          )}
        </div>
        <button type="button" className={`sw2-iconbtn sw-board-btn${boardOpen ? " is-on" : ""}`} data-testid="wall-board-toggle" aria-pressed={boardOpen} title={t("wall.board.toggle")} onClick={() => setBoardOpen((o) => !o)}>
          🎨 <span className="sw-board-btn-label">{t("wall.board.title")}</span>
        </button>
        {s.expiresAt > 0 && (
          <span className={`sw-timer${left < 60_000 ? " is-low" : ""}`} data-testid="wall-countdown" title={t("wall.expiresAt", { date: new Date(s.expiresAt).toLocaleString() })}>
            ⏳ {formatRemaining(left)}
          </span>
        )}
        {(onExport || exportBlocked || onDestroy || onLeave) && (
          <HostMenu label={t("wall.hostMenu")}>
            {isHost && (onExport || exportBlocked) && (
              <>
                <button type="button" role="menuitem" className="sw2-menu-item" data-testid="wall-export" disabled={!!exportBlocked} onClick={onExport} title={exportBlocked}>
                  {t("wall.export.button")}
                </button>
                {exportBlocked && <p className="sw2-menu-note" data-testid="wall-export-blocked">{exportBlocked}</p>}
              </>
            )}
            {onLeave && (
              <button type="button" role="menuitem" className="sw2-menu-item" data-testid="wall-leave" onClick={onLeave}>
                {t("wall.leave")}
              </button>
            )}
            {onDestroy && (
              <button type="button" role="menuitem" className="sw2-menu-item is-danger" data-testid="wall-destroy" onClick={onDestroy}>
                {t("wall.destroy")}
              </button>
            )}
          </HostMenu>
        )}
      </header>

      <div className="sw2-body">
        <aside className="sw2-side" aria-label={t("wall.panel")}>
          <div className="sw2-sheet-head">
            <span className="sw2-sheet-grip" aria-hidden="true" />
            <button type="button" className="sw2-iconbtn" data-testid="wall-sheet-close" aria-label={t("common.close")} onClick={() => setDrawer(false)}>✕</button>
          </div>
          <WallInfo s={s} code={code} invite={invite} />
          <div className="sw2-tabs" role="tablist">
            <button type="button" role="tab" className="sw2-tab" data-testid="wall-tab-members" aria-selected={sideTab === "members"} onClick={() => setSideTab("members")}>
              <span>{t("wall.members")}</span><span className="sw2-tab-n">{s.members.length}</span>
            </button>
            <button type="button" role="tab" className="sw2-tab" data-testid="wall-tab-notes" aria-selected={sideTab === "notes"} onClick={() => setSideTab("notes")}>
              <span>{t("wall.notes.title")}</span><span className="sw2-tab-n">{s.notes.length}</span>
              {notesWriting > 0 && <span className="sw2-tab-dot" aria-label={t("wall.notes.someoneWriting")} />}
            </button>
            <button type="button" role="tab" className="sw2-tab" data-testid="wall-tab-tasks" aria-selected={sideTab === "tasks"} onClick={() => setSideTab("tasks")}>
              <span>{t("wall.tasks.title")}</span><span className="sw2-tab-n" data-testid="wall-tasks-count">{s.tasks.length}</span>
            </button>
          </div>
          {sideTab === "tasks" && (
            <TasksPanel tasks={s.tasks} members={s.members} self={s.self} isHost={isHost} nameOf={nameOf} api={api} canWrite={s.online} share={shareFor} />
          )}
          {sideTab === "members" && isHost && api.approveAgent && api.refuseAgent && (
            <PendingAgents pending={s.pendingAgents ?? []} onApprove={api.approveAgent} onRefuse={(l) => api.refuseAgent!(l)} />
          )}
          {sideTab === "notes" && (
            <NotesList
              notes={s.notes}
              locks={s.noteLocks}
              self={s.self}
              now={now}
              nameOf={nameOf}
              openId={openNote}
              onOpen={openNoteById}
              onCreate={() => {
                createdFrom.current = new Set(s.notes.map((n) => n.id));
                setDrawer(false);
                void Promise.resolve(api.createNote("")).catch(() => undefined);
              }}
            />
          )}
          {sideTab === "members" && isHost && api.setAgents && <AgentsToggle on={s.agents} onChange={api.setAgents} onOpenGuide={() => setAgentsGuideOpen(true)} />}
          {sideTab === "members" && isHost && hostTools}
          {sideTab === "members" && <section className="sw2-section">
            <h3 className="sw2-h">{t("wall.membersCount", { count: s.members.length })}</h3>
            <ul className="sw2-members" data-testid="wall-members">
              {s.members.map((m) => (
                <MemberRow
                  key={m.label}
                  m={m}
                  self={m.label === s.self}
                  typing={typingNames.includes(m.name) && m.label !== s.self}
                  live={s.live.some((l) => l.by === m.label)}
                  onRename={m.label === s.self ? (n) => void Promise.resolve(api.rename(n)).catch(() => undefined) : undefined}
                  onKick={isHost && !m.host && api.kick ? () => window.confirm(t("wall.kickConfirm", { name: m.name })) && api.kick!(m.label) : undefined}
                  onScope={isHost && m.agent && !m.host && api.setAgentScope ? (sc) => api.setAgentScope!(m.label, sc) : undefined}
                />
              ))}
            </ul>
          </section>}
          {exportNote && <p className="sw-small" role="status" data-testid="wall-export-note">{exportNote}</p>}
          <PrivacyNote />
        </aside>
        {drawer && <div className="sw2-scrim" onClick={() => setDrawer(false)} aria-hidden="true" />}

        <main
          className="sw2-main"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) e.preventDefault();
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            void onFiles(Array.from(e.dataTransfer.files));
          }}
        >
          {isHost && (
            <div className="sw2-banner is-warn" role="alert" data-testid="wall-keep-open">
              ⚠ {t("wall.keepTabOpen")}
            </div>
          )}
          {agentsHere.length > 0 && (
            <div className="sw2-banner is-ai" role="note" data-testid="wall-agent-warning">
              🤖 {t("wall.agents.present", { count: agentsHere.length, names: agentsHere.map((a) => a.name).join(", ") })}
            </div>
          )}
          {pinned && (
            <div className="sw2-pinned" data-testid="wall-pinned">
              <span aria-hidden="true">📌</span>
              <button type="button" className="sw2-link" onClick={() => document.getElementById(`post-${pinned.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}>
                <strong>{nameOf(pinned.by)}</strong> · {postPreview(t, pinned)}
              </button>
              {isHost && api.pin && (
                <button type="button" className="sw-x" aria-label={t("wall.unpin")} title={t("wall.unpin")} onClick={() => api.pin!(null)}>
                  ✕
                </button>
              )}
            </div>
          )}
          {s.live.length > 0 && (
            <LiveStage
              live={s.live}
              media={s.media}
              self={s.self}
              nameOf={nameOf}
              onStop={(sid, by) => (by === s.self || isHost) && api.stopLive(sid)}
              canStopAll={isHost}
            />
          )}

          {boardOpen && (
            <section className="sw-board" data-testid="wall-board" aria-label={t("wall.board.title")}>
              <div className="sw-board-head">
                <strong>🎨 {t("wall.board.title")}</strong>
                <small>{t("wall.board.note")}</small>
                <button type="button" className="sw-x" data-testid="wall-board-close" aria-label={t("wall.board.close")} title={t("wall.board.close")} onClick={() => setBoardOpen(false)}>
                  ✕
                </button>
              </div>
              <Suspense fallback={<p className="sw-small" data-testid="wall-board-loading">{t("wall.board.loading")}</p>}>
                <Whiteboard initial={api.boardElements()} subscribe={subscribeBoard} send={(els) => api.boardOp(els)} dark={dark} lang={i18n.language} />
              </Suspense>
            </section>
          )}
          {editing && (
            <NoteEditor
              key={editing.id}
              note={editing}
              lock={s.noteLocks[editing.id]}
              self={s.self}
              isHost={isHost}
              now={now}
              nameOf={nameOf}
              members={s.members}
              api={api}
              onClose={() => setOpenNote(null)}
            />
          )}
          {searching && (
            <p className="sw2-search-count" data-testid="wall-search-count" data-count={shown.length + noteHits.length + taskHits.length} aria-live="polite">
              {t("wall.search.count", { count: shown.length + noteHits.length + taskHits.length })}
            </p>
          )}
          {searching && <NoteSearchHits notes={noteHits} query={query} onOpen={openNoteById} />}
          {searching && <TaskSearchHits tasks={taskHits} query={query} onOpen={() => { setSideTab("tasks"); setDrawer(true); }} />}
          <Feed
            posts={shown}
            highlight={searching ? query : undefined}
            live={live}
            s={s}
            nameOf={nameOf}
            memberOf={memberOf}
            mine={mine}
            lang={i18n.language}
            opened={opened}
            blobs={blobs}
            fetchItem={fetchItem}
            onPreview={(p) => void openPreview(p)}
            onDownload={(p) => void download(p)}
            onReact={react}
            onMoreReact={(id) => setPicker({ target: "post", id })}
            onReply={(id) => setReplyTo(id)}
            onPin={isHost && api.pin ? (id) => api.pin!(s.pinned === id ? null : id) : undefined}
            onRemove={(id) => void Promise.resolve(api.remove(id)).catch(() => undefined)}
            onVote={(id, i) => void Promise.resolve(api.vote(id, i)).catch(() => undefined)}
            onClosePoll={(id) => void Promise.resolve(api.closePoll(id)).catch(() => undefined)}
            confirmBurn={confirmBurn}
            share={shareFor}
          />

          <div className="sw2-typing" data-testid="wall-typing" aria-live="polite">
            {typingNames.length > 0 && t("wall.typing", { count: typingNames.length, names: typingNames.slice(0, 3).join(", ") })}
          </div>

          {s.uploads && <Uploads uploads={s.uploads} />}
          {notice && (
            <p className="pz-err sw2-notice" role="alert" data-testid="wall-notice">
              {notice.text}
            </p>
          )}

          <Composer
            s={s}
            api={api}
            me={me}
            replyTo={replyTo ? feed.find((p) => p.id === replyTo) : undefined}
            nameOf={nameOf}
            onCancelReply={() => setReplyTo(null)}
            onSent={() => setReplyTo(null)}
            onFiles={(f) => void onFiles(f)}
            onNotice={say}
            onEmoji={() => setPicker((p) => (p?.target === "composer" ? null : { target: "composer" }))}
            registerInsert={registerInsert}
            onBurst={(k) => {
              spawn(k);
              api.burst(k);
            }}
            canLive={canLive && !myLive}
            myLive={myLive?.sid}
            onLive={(k, mic) => void goLive(k, mic)}
            onStopLive={() => myLive && api.stopLive(myLive.sid)}
          />
          {picker && (
            <EmojiPicker
              title={picker.target === "post" ? t("wall.emoji.react") : undefined}
              onClose={() => setPicker(null)}
              onPick={(e) => {
                if (picker.target === "post") {
                  react(picker.id, e);
                  setPicker(null);
                } else composerInsert.current?.(e);
              }}
            />
          )}
          <div className="sw2-bursts" data-testid="wall-burst-layer" aria-hidden="true">
            {bursts.map((b) => (
              <span key={b.id} className="sw2-burst-p" style={{ left: `${b.x}%`, animationDelay: `${b.d}s` }}>
                {b.e}
              </span>
            ))}
          </div>
        </main>
      </div>
      {preview && <Previewer {...preview} onClose={closePreview} />}
      <AgentsGuide open={agentsGuideOpen} onClose={() => setAgentsGuideOpen(false)} inviteLink={invite?.link} agentsAllowed={s.agents} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function HostMenu({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div className="sw2-menu" ref={ref}>
      <button type="button" className="sw2-iconbtn sw2-menu-btn" data-testid="wall-actions" aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen((o) => !o)}>
        ⋯
      </button>
      {open && (
        <div className="sw2-menu-pop" role="menu" onClick={(e) => (e.target as HTMLElement).closest("button") && setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

function WallInfo({ s, code, invite }: { s: RoomState; code: string; invite?: { link: string } }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };
  return (
    <section className="sw2-section sw2-info">
      <h2 className="sw2-wallname" data-testid="wall-info-title">{s.title || t("wall.untitled")}</h2>
      <div className="sw-flags">
        <span className="sw-flag">🔐 {t("wall.flagE2ee")}</span>
        {s.burn && <span className="sw-flag" data-testid="wall-flag-burn">🔥 {t("wall.flagBurn")}</span>}
        {s.hostLeave && <span className="sw-flag">🔌 {t("wall.flagHostLeave")}</span>}
        {s.password && <span className="sw-flag">🔑 {t("wall.flagPassword")}</span>}
        {s.agents && <span className="sw-flag sw-flag-ai">🤖 {t("wall.flagAgents")}</span>}
      </div>
      {code && (
        <span className="sw2-codechip sw2-code-m">
          <span className="sw2-codechip-k">{t("wall.code")}</span> <strong>{code}</strong>
        </span>
      )}
      {code && <p className="sw-small">{t("wall.codeHint")}</p>}
      {invite && (
        <details className="sw2-invite" open={s.members.length <= 1}>
          <summary>{t("wall.invite")}</summary>
          <div className="v3-qr">
            <QRCodeSVG value={invite.link} size={132} level="M" marginSize={2} bgColor="#ffffff" fgColor="#0f172a" title={t("wall.qrTitle")} />
          </div>
          <p className="sw-small">{t("wall.inviteLead")}</p>
          <div className="v3-link-row">
            <input readOnly data-testid="wall-link" value={invite.link} onFocus={(e) => e.currentTarget.select()} aria-label={t("wall.inviteLink")} />
            <button type="button" className="v3-copy-btn" data-testid="wall-copy-link" onClick={copy}>
              {copied ? "✓" : t("common.copy")}
            </button>
          </div>
          {s.password && <p className="sw-small">{t("wall.passwordShareApart")}</p>}
        </details>
      )}
    </section>
  );
}

function AgentsToggle({ on, onChange, onOpenGuide }: { on: boolean; onChange: (b: boolean) => void; onOpenGuide?: () => void }) {
  const { t } = useTranslation();
  return (
    <section className="sw2-section">
      <label className="sw-check sw2-agents">
        <input
          type="checkbox"
          data-testid="wall-agents-toggle"
          checked={on}
          onChange={(e) => {
            const v = e.target.checked;
            if (v && !window.confirm(t("wall.agents.enableConfirm"))) return;
            onChange(v);
          }}
        />
        <span>
          <strong>🤖 {t("wall.agents.allow")}</strong>
          <small>{t(on ? "wall.agents.hintOn" : "wall.agents.hintOff")}</small>
        </span>
      </label>
      {onOpenGuide && (
        <button type="button" className="pz-btn pz-btn-ghost sw-guide-btn" data-testid="wall-agents-guide-open" onClick={onOpenGuide}>
          🤖 {t("wall.agents.guide.open")}
        </button>
      )}
    </section>
  );
}

function MemberRow({ m, self, typing, live, onRename, onKick, onScope }: { m: Member; self: boolean; typing: boolean; live: boolean; onRename?: (n: string) => void; onKick?: () => void; onScope?: (s: AgentScope) => void }) {
  const { t } = useTranslation();
  const [edit, setEdit] = useState(false);
  const [scopeEdit, setScopeEdit] = useState<AgentScope | null>(null);
  const [name, setName] = useState(m.name);
  return (
    <li className="sw2-member" data-testid="wall-member" data-label={m.label} data-agent={m.agent} data-host={m.host} data-hand={m.hand}>
      <span className="sw2-member-av">
        <Avatar m={m} size={30} />
        <span className="sw2-presence" title={t("wall.online")} />
      </span>
      <span className="sw2-member-main">
        {edit ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) onRename?.(name.trim());
              setEdit(false);
            }}
          >
            <input className="sw2-name-input" data-testid="wall-name-input" value={name} maxLength={32} autoFocus onChange={(e) => setName(e.target.value)} onBlur={() => setEdit(false)} aria-label={t("wall.yourName")} />
          </form>
        ) : (
          <span className="sw2-member-name">
            {m.name}
            {self && <span className="sw2-you"> ({t("wall.you")})</span>}
          </span>
        )}
        <span className="sw2-badges">
          {m.host && <span className="sw2-badge is-host">{t("wall.badgeHost")}</span>}
          {m.agent && (
            <span className="sw2-badge is-ai" data-testid="wall-badge-ai" title={t("wall.agents.badgeHint")}>
              {t("wall.badgeAi")}
            </span>
          )}
          {m.agent && <ScopeChips scope={m.scope} />}
          {live && <span className="sw2-badge is-live">● {t("wall.live.badge")}</span>}
          {typing && <span className="sw2-member-typing">{t("wall.typingShort")}</span>}
        </span>
      </span>
      {m.hand && (
        <span className="sw2-hand" title={t("wall.handRaised")} data-testid="wall-hand-indicator">
          ✋
        </span>
      )}
      {onRename && !edit && (
        <button type="button" className="sw2-iconbtn" data-testid="wall-name-edit" aria-label={t("wall.rename")} title={t("wall.rename")} onClick={() => (setName(m.name), setEdit(true))}>
          ✏️
        </button>
      )}
      {onScope && m.scope && (
        <button type="button" className="sw2-iconbtn" data-testid="wall-scope-edit" aria-label={t("wall.scope.edit")} title={t("wall.scope.edit")} onClick={() => setScopeEdit((x) => (x ? null : { ...m.scope! }))}>
          ⚙️
        </button>
      )}
      {onKick && (
        <button type="button" className="sw2-iconbtn" data-testid="wall-kick" aria-label={t("wall.kick")} title={t("wall.kick")} onClick={onKick}>
          🚪
        </button>
      )}
      {scopeEdit && onScope && (
        <div className="sw-scope-pop">
          <ScopeEditor value={scopeEdit} onChange={setScopeEdit} />
          <button type="button" className="pz-btn" data-testid="wall-scope-save" onClick={() => (onScope(scopeEdit), setScopeEdit(null))}>
            {t("wall.scope.save")}
          </button>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------

function LiveStage({ live, media, self, nameOf, onStop, canStopAll }: { live: LiveInfo[]; media: Record<string, MediaStream>; self?: string; nameOf: (l: string) => string; onStop: (sid: string, by: string) => void; canStopAll: boolean }) {
  return (
    <div className={`sw2-stage n${live.length}`} data-testid="wall-live-stage">
      {live.map((l) => (
        <LiveTile key={l.sid} l={l} stream={media[l.sid]} own={l.by === self} name={nameOf(l.by)} onStop={l.by === self || canStopAll ? () => onStop(l.sid, l.by) : undefined} />
      ))}
    </div>
  );
}

function LiveTile({ l, stream, own, name, onStop }: { l: LiveInfo; stream?: MediaStream; own: boolean; name: string; onStop?: () => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (v.srcObject !== (stream ?? null)) v.srcObject = stream ?? null;
    if (stream) void v.play().catch(() => undefined);
  }, [stream]);
  const hasAudio = !!stream?.getAudioTracks().length;
  return (
    <figure className="sw2-tile" data-testid="wall-live-tile" data-sid={l.sid} data-own={own} data-playing={playing}>
      <video ref={ref} autoPlay playsInline muted={own || muted} data-testid="wall-live-video" onPlaying={() => setPlaying(true)} />
      {!stream && <div className="sw2-tile-wait">{t("wall.live.connecting")}</div>}
      <figcaption>
        <span className="sw2-live-badge" data-testid="wall-live-badge">● {t("wall.live.badge")}</span>
        <span className="sw2-tile-name">
          {l.kind === "screen" ? "🖥️" : "📷"} {name}
        </span>
        {!own && hasAudio && (
          <button type="button" className="sw2-iconbtn" aria-label={muted ? t("wall.live.unmute") : t("wall.live.mute")} onClick={() => setMuted((m) => !m)}>
            {muted ? "🔇" : "🔊"}
          </button>
        )}
        {onStop && (
          <button type="button" className="sw2-stop" data-testid="wall-live-stop" onClick={onStop}>
            ■ {t("wall.live.stop")}
          </button>
        )}
      </figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------------------

interface FeedProps {
  posts: Post[];
  live: Set<string>;
  s: RoomState;
  nameOf: (l: string) => string;
  memberOf: (l: string) => Member;
  mine: (p: Post) => boolean;
  lang: string;
  opened: Map<string, Fetched>;
  blobs: Blobs;
  fetchItem: (id: string) => Promise<Fetched | null>;
  onPreview: (p: Post) => void;
  onDownload: (p: Post) => void;
  onReact: (id: string, e: string) => void;
  onMoreReact: (id: string) => void;
  onReply: (id: string) => void;
  onPin?: (id: string) => void;
  onRemove: (id: string) => void;
  onVote: (id: string, i: number) => void;
  onClosePoll: (id: string) => void;
  confirmBurn: (p: Post) => boolean;
  /** Active search ("" = none): matches are highlighted. */
  highlight?: string;
  /** Host only: share a post with agents in limited view. */
  share?: (id: string) => ReactNode;
}

function Feed(props: FeedProps) {
  const { t } = useTranslation();
  const { posts } = props;
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [posts]);
  const rows = groupPosts(posts);
  return (
    <div
      className="sw2-feed"
      ref={ref}
      data-testid="wall-grid"
      role="log"
      aria-live="polite"
      aria-label={t("wall.feed")}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {!posts.length && (
        <p className="sw-empty" data-testid="wall-empty">
          {t("wall.empty")}
        </p>
      )}
      {rows.map(({ post, first }) => (
        <PostRow key={post.id} post={post} first={first} {...props} />
      ))}
    </div>
  );
}

function PostRow({ post: p, first, ...f }: FeedProps & { post: Post; first: boolean }) {
  const { t } = useTranslation();
  if (p.system === "exported") {
    const at = new Date(p.at).toLocaleTimeString(f.lang, { hour: "2-digit", minute: "2-digit" });
    return (
      <div className="sw2-system" role="status" data-testid="wall-system" data-system={p.system} data-id={p.id}>
        📦 {t("wall.system.exported")} <time>{at}</time>
      </div>
    );
  }
  const author = f.memberOf(p.by);
  const gone = !f.live.has(p.id);
  const replied = p.replyTo ? f.posts.find((x) => x.id === p.replyTo) : undefined;
  const mentionsMe = !!f.s.self && !!p.mentions?.includes(f.s.self);
  const time = new Date(p.at).toLocaleTimeString(f.lang, { hour: "2-digit", minute: "2-digit" });
  const isItem = p.kind === "file" || p.kind === "note";
  const canRemove = !gone && !p.system && (f.mine(p) || f.s.role === "host");
  return (
    <article
      id={`post-${p.id}`}
      className={`sw2-post${first ? " is-first" : ""}${mentionsMe ? " is-mention" : ""}${f.s.pinned === p.id ? " is-pinned" : ""}${gone ? " is-local" : ""}`}
      data-testid={isItem ? "wall-item" : p.kind === "poll" ? "wall-poll" : "wall-msg"}
      data-kind={p.kind === "note" ? "text" : p.kind === "file" ? "file" : p.kind}
      data-name={p.item?.name}
      data-id={p.id}
      data-by={p.by}
    >
      <div className="sw2-post-gutter">{first ? <Avatar m={author} /> : <time className="sw2-post-time-h">{time}</time>}</div>
      <div className="sw2-post-body">
        {replied && (
          <button type="button" className="sw2-replyref" onClick={() => document.getElementById(`post-${replied.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}>
            ↪ <strong>{f.nameOf(replied.by)}</strong> {postPreview(t, replied)}
          </button>
        )}
        {first && (
          <div className="sw2-post-head">
            <span className="sw2-post-author">
              {author.name}
            </span>
            {author.host && <span className="sw2-badge is-host">{t("wall.badgeHost")}</span>}
            {author.agent && (
              <span className="sw2-badge is-ai" title={t("wall.agents.badgeHint")}>
                {t("wall.badgeAi")}
              </span>
            )}
            <time className="sw2-post-time">{time}</time>
            {gone && (
              <span className="sw-chip" title={t("wall.localCopyHint")}>
                {t("wall.localCopy")}
              </span>
            )}
          </div>
        )}
        {!first && gone && (
          <span className="sw-chip" title={t("wall.localCopyHint")}>
            {t("wall.localCopy")}
          </span>
        )}
        {p.kind === "msg" && <Markup text={p.text ?? ""} members={f.s.members} self={f.s.self} highlight={f.highlight} />}
        {p.kind === "file" && p.item && <FileBody p={p} item={p.item} gone={gone} {...f} />}
        {p.kind === "note" && p.item && <NoteBody p={p} {...f} />}
        {p.kind === "poll" && p.poll && <PollBody p={p} {...f} />}
        <Reactions p={p} {...f} />
      </div>
      {!gone && (
        <div className="sw2-post-tools" role="toolbar" aria-label={t("wall.actions")}>
          {QUICK_REACTIONS.slice(0, 4).map((e) => (
            <button key={e} type="button" data-testid="wall-quick-react" data-emoji={e} title={t("wall.reactWith", { emoji: e })} onClick={() => f.onReact(p.id, e)}>
              {e}
            </button>
          ))}
          <button type="button" data-testid="wall-react-more" data-emoji-trigger aria-label={t("wall.emoji.react")} title={t("wall.emoji.react")} onClick={() => f.onMoreReact(p.id)}>
            😀+
          </button>
          <button type="button" data-testid="wall-reply" aria-label={t("wall.reply")} title={t("wall.reply")} onClick={() => f.onReply(p.id)}>
            ↩
          </button>
          {f.onPin && (
            <button type="button" data-testid="wall-pin" aria-label={t(f.s.pinned === p.id ? "wall.unpin" : "wall.pin")} title={t(f.s.pinned === p.id ? "wall.unpin" : "wall.pin")} onClick={() => f.onPin!(p.id)}>
              📌
            </button>
          )}
          {f.share?.(p.id)}
          {canRemove && (
            <button type="button" data-testid="wall-remove" aria-label={t("wall.remove")} title={t("wall.remove")} onClick={() => f.onRemove(p.id)}>
              🗑
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function Reactions({ p, s, nameOf, onReact, onMoreReact, live }: FeedProps & { p: Post }) {
  const { t } = useTranslation();
  const entries = Object.entries(p.reactions);
  if (!entries.length) return null;
  return (
    <div className="sw2-reactions">
      {entries.map(([e, who]) => {
        const me = !!s.self && who.includes(s.self);
        return (
          <button
            key={e}
            type="button"
            className={`sw2-reaction${me ? " is-me" : ""}`}
            aria-pressed={me}
            data-testid="wall-reaction"
            data-emoji={e}
            data-count={who.length}
            title={t("wall.reactedBy", { names: who.map(nameOf).join(", ") })}
            disabled={!live.has(p.id)}
            onClick={() => onReact(p.id, e)}
          >
            <span>{e}</span> <span className="sw2-reaction-n">{who.length}</span>
          </button>
        );
      })}
      {live.has(p.id) && (
        <button type="button" className="sw2-reaction is-add" data-emoji-trigger aria-label={t("wall.emoji.react")} onClick={() => onMoreReact(p.id)}>
          ＋
        </button>
      )}
    </div>
  );
}

function FileBody({ p, item, gone, s, opened, blobs, fetchItem, onPreview, onDownload, highlight }: FeedProps & { p: Post; item: ItemMeta; gone: boolean }) {
  const { t } = useTranslation();
  const kind = previewKind(item);
  const inline = !s.burn && (kind === "image" || kind === "video" || kind === "audio") && item.size <= INLINE_MAX;
  const [url, setUrl] = useState<string | null>(null);
  const got = opened.get(p.id);
  useEffect(() => {
    if (!inline || gone) return;
    if (!got) {
      void fetchItem(p.id);
      return;
    }
    const u = blobs.make(got.data);
    setUrl(u);
    return () => {
      blobs.revoke(u);
      setUrl(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inline, got, gone]);
  const viewOnce = s.burn && !gone && kind !== null && kind !== "text";
  return (
    <div className={`sw2-file${viewOnce ? " is-once" : ""}`}>
      {inline && url && kind === "image" && (
        <button type="button" className="sw2-inline" onClick={() => onPreview(p)} aria-label={t("wall.preview")}>
          <img src={url} alt={item.name} data-testid="wall-inline-img" referrerPolicy="no-referrer" loading="lazy" />
        </button>
      )}
      {inline && url && kind === "video" && <video className="sw2-inline" src={url} controls playsInline preload="metadata" data-testid="wall-inline-video" />}
      {inline && url && kind === "audio" && <audio className="sw2-inline" src={url} controls preload="metadata" data-testid="wall-inline-audio" />}
      {inline && !url && !gone && <div className="sw2-inline sw2-inline-wait">{t("wall.loadingMedia")}</div>}
      {viewOnce && (
        <div className="sw2-once" data-testid="wall-view-once-card">
          <span className="sw2-once-icon" aria-hidden="true">👁️‍🗨️</span>
          <span>
            <strong>{t("wall.viewOnce")}</strong>
            <small>{t("wall.viewOnceHint")}</small>
          </span>
          <button type="button" className="pz-btn" data-testid="wall-view-once" onClick={() => onPreview(p)}>
            {t("wall.viewOnceButton")}
          </button>
        </div>
      )}
      <div className="sw2-file-row">
        <span className="sw-item-icon" aria-hidden="true">{iconFor(kind)}</span>
        <span className="sw2-file-meta">
          <span className="sw-item-name" title={item.name}><Hl text={item.name} q={highlight} /></span>
          <span className="sw-item-size">{formatBytes(item.size)}</span>
        </span>
        <span className="sw-item-actions">
          {kind && !viewOnce && (
            <button type="button" data-testid="wall-preview" onClick={() => onPreview(p)}>
              {t("wall.preview")}
            </button>
          )}
          <button type="button" data-testid="wall-download" onClick={() => onDownload(p)}>
            {t("wall.download")}
          </button>
        </span>
      </div>
    </div>
  );
}

function NoteBody({ p, fetchItem, confirmBurn }: FeedProps & { p: Post }) {
  const { t } = useTranslation();
  const [text, setText] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const get = async () => {
    if (!confirmBurn(p)) return null;
    setBusy(true);
    try {
      const got = await fetchItem(p.id);
      return got ? await got.data.text() : null;
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sw2-note">
      <div className="sw2-note-title">🔒 {p.item?.name || t("wall.snippet")}</div>
      {text !== undefined ? (
        <pre className="sw-secret" data-testid="wall-secret-text">{text}</pre>
      ) : (
        <div className="sw-secret is-masked" aria-label={t("wall.masked")}>•••••••• •••• ••••••</div>
      )}
      <div className="sw-item-actions">
        {text !== undefined ? (
          <button type="button" data-testid="wall-hide" onClick={() => setText(undefined)}>{t("wall.hide")}</button>
        ) : (
          <button type="button" data-testid="wall-reveal" disabled={busy} onClick={async () => { const v = await get(); if (v !== null) setText(v); }}>{t("wall.reveal")}</button>
        )}
        <button
          type="button"
          data-testid="wall-copy"
          disabled={busy}
          onClick={async () => {
            const v = text ?? (await get());
            if (v === null) return;
            try { await navigator.clipboard.writeText(v); } catch { /* ignore */ }
          }}
        >
          {t("common.copy")}
        </button>
      </div>
    </div>
  );
}

function PollBody({ p, s, nameOf, onVote, onClosePoll, mine, live, highlight }: FeedProps & { p: Post }) {
  const { t } = useTranslation();
  const poll = p.poll!;
  const { counts, total } = pollTotals(poll);
  const canVote = !poll.closed && live.has(p.id) && s.online;
  return (
    <div className={`sw2-poll${poll.closed ? " is-closed" : ""}`}>
      <div className="sw2-poll-q">📊 <Hl text={poll.question} q={highlight} /></div>
      <ul>
        {poll.options.map((o, i) => {
          const n = counts[i] ?? 0;
          const pct = total ? Math.round((n / total) * 100) : 0;
          const voted = !!s.self && !!poll.votes[i]?.includes(s.self);
          return (
            <li key={i}>
              <button
                type="button"
                className={`sw2-poll-opt${voted ? " is-me" : ""}`}
                data-testid="wall-poll-vote"
                data-index={i}
                data-count={n}
                aria-pressed={voted}
                disabled={!canVote}
                title={poll.votes[i]?.map(nameOf).join(", ")}
                onClick={() => onVote(p.id, i)}
              >
                <span className="sw2-poll-bar" style={{ width: `${pct}%` }} />
                <span className="sw2-poll-label">
                  {voted ? "✓ " : ""}
                  <Hl text={o} q={highlight} />
                </span>
                <span className="sw2-poll-n">
                  {n} · {pct} %
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="sw2-poll-foot">
        <span data-testid="wall-poll-total">{t("wall.poll.votes", { count: total })}</span>
        {poll.closed ? <span className="sw-chip">{t("wall.poll.closed")}</span> : (mine(p) || s.role === "host") && live.has(p.id) && (
          <button type="button" className="sw2-link" data-testid="wall-poll-close" onClick={() => onClosePoll(p.id)}>
            {t("wall.poll.close")}
          </button>
        )}
      </div>
    </div>
  );
}

function iconFor(kind: ReturnType<typeof previewKind>) {
  return kind === "image" ? "🖼️" : kind === "video" ? "🎬" : kind === "audio" ? "🎵" : kind === "text" ? "📄" : "📦";
}

// ---------------------------------------------------------------------------

interface ComposerProps {
  s: RoomState;
  api: RoomApi;
  me?: Member;
  replyTo?: Post;
  nameOf: (l: string) => string;
  onCancelReply: () => void;
  onSent: () => void;
  onFiles: (f: File[]) => void;
  onNotice: (text: string) => void;
  onEmoji: () => void;
  registerInsert: (fn: (s: string) => void) => void;
  onBurst: (k: BurstKind) => void;
  canLive: boolean;
  myLive?: string;
  onLive: (k: LiveKind, mic: boolean) => void;
  onStopLive: () => void;
}

function Composer(c: ComposerProps) {
  const { t } = useTranslation();
  const { s } = c;
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [sel, setSel] = useState(0);
  const [panel, setPanel] = useState<null | "poll" | "note" | "live">(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastTyping = useRef(0);
  const disabled = !s.online;

  // Caret to restore right after the next render (synchronously, so typing
  // that follows can never be overtaken by a late animation frame).
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const pos = pendingCaret.current;
    const el = area.current;
    if (pos === null || !el) return;
    pendingCaret.current = null;
    el.focus();
    el.selectionStart = el.selectionEnd = pos;
    setCaret(pos);
  }, [text]);
  const textRef = useRef(text);
  textRef.current = text;
  const insert = useCallback((str: string) => {
    const el = area.current;
    const cur = textRef.current;
    const at = el ? el.selectionStart : cur.length;
    const end = el ? el.selectionEnd : cur.length;
    pendingCaret.current = at + str.length;
    setText(cur.slice(0, at) + str + cur.slice(end));
  }, []);
  const { registerInsert } = c;
  useEffect(() => {
    registerInsert(insert);
  }, [registerInsert, insert]);

  // @mention autocomplete
  const mq = /(?:^|\s)@([^\s@]{0,24})$/u.exec(text.slice(0, caret));
  const suggestions = mq ? s.members.filter((m) => m.label !== s.self && m.name.toLowerCase().includes(mq[1]!.toLowerCase())).slice(0, 6) : [];
  const pickMention = (m: Member) => {
    if (!mq) return;
    const start = caret - mq[1]!.length - 1;
    const next = `${text.slice(0, start)}@${m.name} ${text.slice(caret)}`;
    pendingCaret.current = start + m.name.length + 2;
    setText(next);
  };

  const send = () => {
    const v = text.trim();
    if (!v || disabled || v.length > MAX_MSG_CHARS) return;
    void Promise.resolve(c.api.say(v, c.replyTo?.id)).catch(() => c.onNotice(reasonText(t, "offline")));
    setText("");
    setCaret(0);
    c.onSent();
  };

  return (
    <div className="sw2-composer" data-testid="wall-composer">
      {c.replyTo && (
        <div className="sw2-replying" data-testid="wall-replying">
          ↪ {t("wall.replyingTo", { name: c.nameOf(c.replyTo.by) })} · <span className="sw2-muted">{postPreview(t, c.replyTo)}</span>
          <button type="button" className="sw-x" aria-label={t("common.close")} onClick={c.onCancelReply}>✕</button>
        </div>
      )}
      {panel === "poll" && <PollForm disabled={disabled} onCancel={() => setPanel(null)} onSubmit={(q, o) => { void Promise.resolve(c.api.poll(q, o)).catch(() => undefined); setPanel(null); }} />}
      {panel === "note" && (
        <NoteForm
          disabled={disabled}
          onCancel={() => setPanel(null)}
          onSubmit={(v) => {
            const r = c.api.note(v);
            if (r) c.onNotice(reasonText(t, r));
            else setPanel(null);
            return !r;
          }}
        />
      )}
      {panel === "live" && (
        <LiveMenu
          canLive={c.canLive}
          onCancel={() => setPanel(null)}
          onStart={(k, mic) => {
            setPanel(null);
            c.onLive(k, mic);
          }}
        />
      )}
      {suggestions.length > 0 && (
        <ul className="sw2-mentions" role="listbox" data-testid="wall-mention-list">
          {suggestions.map((m, i) => (
            <li key={m.label}>
              <button type="button" role="option" aria-selected={i === sel} className={i === sel ? "is-sel" : ""} onMouseDown={(e) => (e.preventDefault(), pickMention(m))}>
                <Avatar m={m} size={20} /> {m.name}
                {m.agent && <span className="sw2-badge is-ai">{t("wall.badgeAi")}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="sw2-compose-row">
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          disabled={disabled}
          data-testid="wall-file-input"
          onChange={(e) => {
            const files = Array.from(e.currentTarget.files ?? []);
            e.currentTarget.value = "";
            if (files.length) c.onFiles(files);
          }}
        />
        <button type="button" className="sw2-iconbtn" data-testid="wall-attach" disabled={disabled} aria-label={t("wall.attach")} title={t("wall.attach")} onClick={() => fileInput.current?.click()}>
          📎
        </button>
        <textarea
          ref={area}
          data-testid="wall-msg-input"
          value={text}
          rows={1}
          disabled={disabled}
          maxLength={MAX_MSG_CHARS}
          placeholder={t("wall.msgPlaceholder")}
          title={t("wall.msgHint")}
          aria-label={t("wall.msgLabel")}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
            setSel(0);
            const now = Date.now();
            if (e.target.value && now - lastTyping.current > 2000) {
              lastTyping.current = now;
              c.api.typing();
            }
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (files.length) {
              e.preventDefault();
              c.onFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (suggestions.length) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setSel((x) => (x + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pickMention(suggestions[sel] ?? suggestions[0]!);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button type="button" className="sw2-iconbtn" data-testid="wall-emoji-toggle" data-emoji-trigger disabled={disabled} aria-label={t("wall.emoji.title")} title={t("wall.emoji.title")} onClick={c.onEmoji}>
          😀
        </button>
        <button type="button" className="pz-btn sw2-send" data-testid="wall-msg-send" aria-label={t("wall.send")} disabled={disabled || !text.trim()} onClick={send}>
          <span className="sw2-send-label">{t("wall.send")}</span>
          <span className="sw2-send-icon" aria-hidden="true">➤</span>
        </button>
      </div>
      <div className="sw2-tools">
        <button type="button" data-testid="wall-poll-toggle" disabled={disabled} aria-pressed={panel === "poll"} onClick={() => setPanel((p) => (p === "poll" ? null : "poll"))}>
          📊 {t("wall.poll.button")}
        </button>
        <button type="button" data-testid="wall-note-toggle" disabled={disabled} aria-pressed={panel === "note"} onClick={() => setPanel((p) => (p === "note" ? null : "note"))}>
          🔒 {t("wall.noteButton")}
        </button>
        {c.myLive ? (
          <button type="button" className="is-live" data-testid="wall-live-stop-mine" onClick={c.onStopLive}>
            ■ {t("wall.live.stop")}
          </button>
        ) : (
          <button type="button" data-testid="wall-live-toggle" disabled={disabled || !c.canLive} title={c.canLive ? undefined : t("wall.live.unavailable")} aria-pressed={panel === "live"} onClick={() => setPanel((p) => (p === "live" ? null : "live"))}>
            🔴 {t("wall.live.button")}
          </button>
        )}
        <span className="sw2-tools-sep" />
        <button type="button" data-testid="wall-burst-applause" disabled={disabled} title={t("wall.burst.applause")} aria-label={t("wall.burst.applause")} onClick={() => c.onBurst("applause")}>👏</button>
        <button type="button" data-testid="wall-burst-party" disabled={disabled} title={t("wall.burst.party")} aria-label={t("wall.burst.party")} onClick={() => c.onBurst("party")}>🎉</button>
        <button type="button" data-testid="wall-burst-heart" disabled={disabled} title={t("wall.burst.heart")} aria-label={t("wall.burst.heart")} onClick={() => c.onBurst("heart")}>❤️</button>
        <button
          type="button"
          data-testid="wall-hand"
          disabled={disabled}
          aria-pressed={!!c.me?.hand}
          className={c.me?.hand ? "is-on" : ""}
          title={t(c.me?.hand ? "wall.handLower" : "wall.handRaise")}
          onClick={() => void Promise.resolve(c.api.hand(!c.me?.hand)).catch(() => undefined)}
        >
          ✋ {t(c.me?.hand ? "wall.handLower" : "wall.handRaise")}
        </button>
      </div>
    </div>
  );
}

function PollForm({ onSubmit, onCancel, disabled }: { onSubmit: (q: string, o: string[]) => void; onCancel: () => void; disabled: boolean }) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [opts, setOpts] = useState(["", ""]);
  const clean = opts.map((o) => o.trim()).filter(Boolean);
  const valid = q.trim() && clean.length >= POLL_MIN && new Set(clean.map((o) => o.toLowerCase())).size === clean.length;
  return (
    <form
      className="sw2-panel"
      data-testid="wall-poll-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSubmit(q.trim(), clean);
      }}
    >
      <div className="sw2-panel-head">
        <strong>📊 {t("wall.poll.new")}</strong>
        <button type="button" className="sw-x" aria-label={t("common.close")} onClick={onCancel}>✕</button>
      </div>
      <input data-testid="wall-poll-question" value={q} maxLength={200} placeholder={t("wall.poll.question")} aria-label={t("wall.poll.question")} onChange={(e) => setQ(e.target.value)} autoFocus />
      {opts.map((o, i) => (
        <input
          key={i}
          data-testid="wall-poll-option"
          value={o}
          maxLength={80}
          placeholder={t("wall.poll.option", { n: i + 1 })}
          aria-label={t("wall.poll.option", { n: i + 1 })}
          onChange={(e) => setOpts((x) => x.map((y, j) => (j === i ? e.target.value : y)))}
        />
      ))}
      <div className="sw2-panel-actions">
        {opts.length < POLL_MAX && (
          <button type="button" className="v3-btn-ghost" data-testid="wall-poll-add" onClick={() => setOpts((x) => [...x, ""])}>
            ＋ {t("wall.poll.addOption")}
          </button>
        )}
        <button type="submit" className="pz-btn" data-testid="wall-poll-submit" disabled={disabled || !valid}>
          {t("wall.poll.create")}
        </button>
      </div>
    </form>
  );
}

function NoteForm({ onSubmit, onCancel, disabled }: { onSubmit: (v: string) => boolean; onCancel: () => void; disabled: boolean }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const tooLong = new Blob([text]).size > MAX_TEXT_BYTES;
  return (
    <form
      className="sw2-panel"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim() && !tooLong && onSubmit(text)) setText("");
      }}
    >
      <div className="sw2-panel-head">
        <strong>🔒 {t("wall.textLabel")}</strong>
        <button type="button" className="sw-x" aria-label={t("common.close")} onClick={onCancel}>✕</button>
      </div>
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
        autoFocus
      />
      <div className="sw2-panel-actions">
        {tooLong && <span className="pz-err">{t("wall.reason.text-too-large")}</span>}
        <button type="submit" className="pz-btn" data-testid="wall-text-submit" disabled={disabled || !text.trim() || tooLong}>
          {t("wall.textSubmit")}
        </button>
      </div>
    </form>
  );
}

function LiveMenu({ onStart, onCancel, canLive }: { onStart: (k: LiveKind, mic: boolean) => void; onCancel: () => void; canLive: boolean }) {
  const { t } = useTranslation();
  const [mic, setMic] = useState(false);
  const screenOk = typeof navigator !== "undefined" && !!navigator.mediaDevices && "getDisplayMedia" in navigator.mediaDevices;
  return (
    <div className="sw2-panel" data-testid="wall-live-menu">
      <div className="sw2-panel-head">
        <strong>🔴 {t("wall.live.title")}</strong>
        <button type="button" className="sw-x" aria-label={t("common.close")} onClick={onCancel}>✕</button>
      </div>
      <p className="sw-small">{t("wall.live.explain", { max: MAX_LIVE })}</p>
      <label className="sw2-inline-check">
        <input type="checkbox" data-testid="wall-live-mic" checked={mic} onChange={(e) => setMic(e.target.checked)} /> 🎙️ {t("wall.live.mic")}
      </label>
      <div className="sw2-panel-actions">
        {screenOk && (
          <button type="button" className="pz-btn" data-testid="wall-live-screen" disabled={!canLive} onClick={() => onStart("screen", mic)}>
            🖥️ {t("wall.live.screen")}
          </button>
        )}
        <button type="button" className="pz-btn" data-testid="wall-live-camera" disabled={!canLive} onClick={() => onStart("camera", mic)}>
          📷 {t("wall.live.camera")}
        </button>
      </div>
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
          {u.kind === "text" ? t("wall.snippet") : u.name} · {u.status === "sending" ? `${Math.round((u.sent / Math.max(1, u.size)) * 100)} %` : reasonText(t, u.reason ?? "other")}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------

/**
 * In-memory previews only: <img>/<video>/<audio> from Blob URLs (no script
 * runs there, SVG included) and plain text through textContent. Nothing is
 * rendered as a document (no iframe, no PDF viewer, no HTML).
 */
export function Previewer({ meta, url, text, onClose }: { meta: ItemMeta; url?: string; text?: string; onClose: () => void }) {
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

export function PrivacyNote({ children }: { children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <details className="sw-privacy" data-testid="wall-privacy">
      <summary>{t("wall.privacy.title")}</summary>
      <ul>
        <li>{t("wall.privacy.e2ee")}</li>
        <li>{t("wall.privacy.ram")}</li>
        <li>{t("wall.privacy.relay")}</li>
        <li>{t("wall.privacy.live")}</li>
        <li>{t("wall.privacy.agents")}</li>
        <li>{t("wall.privacy.ip")}</li>
        <li>{t("wall.privacy.tor")}</li>
        <li>
          {t("wall.privacy.whistle")} <a href="#report-new">{t("wall.privacy.whistleLink")}</a>
        </li>
        <li>{t("wall.privacy.screens")}</li>
      </ul>
      {children}
    </details>
  );
}
