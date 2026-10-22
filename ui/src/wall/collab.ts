/**
 * Sharewall collaboration state, host-authoritative like the feed and notes:
 *  - agent scopes (what an AI agent may do) and limited visibility ("context pack"),
 *  - a shared checklist (tasks with an owner) and a decisions log,
 *  - the whiteboard scene (Excalidraw elements), merged by element version.
 *
 * Peers only send operations; the host validates, applies and relays them over
 * the same sealed DataChannels. Nothing here is written to disk.
 */

/** Protocol feature level of this build, announced in the sealed profile. Peers
 * below 2 (older tabs and CLIs) never receive task/board messages they could not parse. */
export const WALL_FEATURES = 3;

const LABEL_RE = /^(host|peer:\d{1,6})$/;
const isLabel = (v: unknown): v is string => typeof v === "string" && LABEL_RE.test(v);
const int = (v: unknown, min = 0) => Number.isSafeInteger(v) && (v as number) >= min;
const clean = (v: string, max: number) => v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim().slice(0, max);

// ---- agent scopes ------------------------------------------------------------

export interface AgentScope {
  /** Post messages, files, polls, reactions, notes, tasks. */
  post: boolean;
  /** Fetch file items. */
  files: boolean;
  /** Reveal masked notes / secrets. */
  secrets: boolean;
  /** Limited view: only its own posts, @mentions of it, replies to it, tasks it owns, and items the host shares with it. */
  limited: boolean;
}

export const SCOPE_READ_ONLY: AgentScope = { post: false, files: false, secrets: false, limited: false };
/** Preselected in the host's approval card. */
export const SCOPE_DEFAULT: AgentScope = { post: true, files: false, secrets: false, limited: false };
export const SCOPE_FULL: AgentScope = { post: true, files: true, secrets: true, limited: false };

export function cleanScope(v: unknown): AgentScope | null {
  const o = v as Record<string, unknown>;
  if (!o || typeof o !== "object") return null;
  if (![o.post, o.files, o.secrets, o.limited].every((x) => typeof x === "boolean")) return null;
  return { post: o.post as boolean, files: o.files as boolean, secrets: o.secrets as boolean, limited: o.limited as boolean };
}

export function scopeName(s: AgentScope): "read-only" | "post" | "full" | "custom" {
  if (!s.post && !s.files && !s.secrets) return "read-only";
  if (s.post && !s.files && !s.secrets) return "post";
  if (s.post && s.files && s.secrets) return "full";
  return "custom";
}

/** Parses a CLI `--agent-scope` value: read-only | post | full | comma list (post,files,secrets,limited). */
export function parseScopeArg(raw: string | undefined): AgentScope | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === "read-only" || v === "readonly") return { ...SCOPE_READ_ONLY };
  if (v === "post") return { ...SCOPE_DEFAULT };
  if (v === "full") return { ...SCOPE_FULL };
  const parts = v.split(",").map((x) => x.trim()).filter(Boolean);
  if (!parts.length || parts.some((p) => !["post", "files", "secrets", "limited", "read-only"].includes(p))) return null;
  return { post: parts.includes("post"), files: parts.includes("files"), secrets: parts.includes("secrets"), limited: parts.includes("limited") };
}

/** What an action needs from an agent's scope (null = always allowed). */
export function scopeAllows(scope: AgentScope | undefined, need: "post" | "files" | "secrets" | null): boolean {
  if (!scope || !need) return true;
  return scope[need];
}

export interface Visible {
  id: string;
  by: string;
  mentions?: string[];
  replyTo?: string;
  owner?: string | null;
}

/**
 * Whether an agent in limited view may see an entry. `byOf` gives the author
 * of a post id (for "replies to its own posts"). Non-limited members see everything.
 */
export function visibleTo(label: string, scope: AgentScope | undefined, shared: ReadonlySet<string>, e: Visible, byOf?: (id: string) => string | undefined): boolean {
  if (!scope?.limited) return true;
  if (e.by === label || shared.has(e.id)) return true;
  if (e.mentions?.includes(label)) return true;
  if (e.owner === label) return true;
  if (e.replyTo && byOf?.(e.replyTo) === label) return true;
  return false;
}

// ---- tasks & decisions -----------------------------------------------------

export const TASK_TEXT_MAX = 500;
export const MAX_TASKS = 200;
export type TaskKind = "task" | "decision";

export interface Task {
  id: string;
  kind: TaskKind;
  text: string;
  /** Member label in charge (human or agent), null = unassigned. */
  owner: string | null;
  done: boolean;
  by: string;
  at: number;
  /** Who last changed it and when (host-assigned). */
  editedBy: string;
  editedAt: number;
  v: number;
  /** Agent-to-agent lifecycle (A2A-style) for delegated tasks; absent on plain checklist items. */
  state?: AgentTaskState;
  /** Short status message from the assignee (e.g. what input is needed). */
  note?: string;
  /** Id of the wall post holding the result (artifact). */
  result?: string;
}

/** Delegated-task states, named after the A2A TaskState values (lower-case, without prefix). */
export const AGENT_TASK_STATES = ["submitted", "working", "input-required", "completed", "failed", "canceled", "rejected"] as const;
export type AgentTaskState = (typeof AGENT_TASK_STATES)[number];
export const TERMINAL_STATES: ReadonlySet<AgentTaskState> = new Set(["completed", "failed", "canceled", "rejected"]);
export const TASK_NOTE_MAX = 500;
export const isAgentTaskState = (v: unknown): v is AgentTaskState => typeof v === "string" && (AGENT_TASK_STATES as readonly string[]).includes(v);
const RESULT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const isResultId = (v: unknown): v is string => typeof v === "string" && RESULT_ID_RE.test(v);
export function cleanTaskNote(v: unknown): string | null {
  if (typeof v !== "string" || v.length > TASK_NOTE_MAX * 2) return null;
  return clean(v, TASK_NOTE_MAX);
}
export type TaskPatch = { done?: boolean; owner?: string | null; text?: string; state?: AgentTaskState; note?: string; result?: string };

export type TaskError = "too-many" | "empty" | "not-found" | "forbidden";
const TASK_ID_RE = /^t-[0-9a-f]{16}$/;
export const isTaskId = (v: unknown): v is string => typeof v === "string" && TASK_ID_RE.test(v);

function newTaskId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return `t-${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

export function cleanTaskText(v: unknown): string | null {
  if (typeof v !== "string" || v.length > TASK_TEXT_MAX * 2) return null;
  const s = clean(v, TASK_TEXT_MAX);
  return s ? s : null;
}

export function cleanTask(v: unknown): Task | null {
  const o = v as Record<string, unknown>;
  if (!o || typeof o !== "object" || !isTaskId(o.id) || (o.kind !== "task" && o.kind !== "decision")) return null;
  const text = cleanTaskText(o.text);
  if (!text || !(o.owner === null || isLabel(o.owner)) || typeof o.done !== "boolean") return null;
  if (!isLabel(o.by) || !isLabel(o.editedBy) || !int(o.at) || !int(o.editedAt) || !int(o.v, 1)) return null;
  const t: Task = { id: o.id, kind: o.kind, text, owner: o.owner as string | null, done: o.kind === "task" ? o.done : false, by: o.by, at: o.at as number, editedBy: o.editedBy, editedAt: o.editedAt as number, v: o.v as number };
  if (o.kind === "task" && isAgentTaskState(o.state)) t.state = o.state;
  const note = o.note === undefined ? null : cleanTaskNote(o.note);
  if (t.state && note) t.note = note;
  if (t.state && isResultId(o.result)) t.result = o.result;
  return t;
}

/** Open tasks first, then done tasks; decisions are listed separately, oldest first. */
export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => (a.kind === b.kind ? (a.kind === "task" && a.done !== b.done ? (a.done ? 1 : -1) : a.at - b.at) : a.kind === "task" ? -1 : 1));
}

/** Host-side checklist + decisions log. Anyone may tick a task or (re)assign it; only the author or the host edits text or deletes. */
export class TaskBoard {
  private tasks = new Map<string, Task>();
  private v = 0;

  list(): Task[] {
    return sortTasks([...this.tasks.values()]);
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  create(by: string, kind: TaskKind, text: string, owner: string | null, now = Date.now(), state?: AgentTaskState): Task | TaskError {
    if (this.tasks.size >= MAX_TASKS) return "too-many";
    const t = cleanTaskText(text);
    if (!t) return "empty";
    const task: Task = { id: newTaskId(), kind, text: t, owner: kind === "task" ? owner : null, done: false, by, at: now, editedBy: by, editedAt: now, v: ++this.v };
    if (kind === "task" && state) task.state = state;
    this.tasks.set(task.id, task);
    return task;
  }

  /** Agent state/note/result: only the assignee, the author or the host. Completing marks it done. */
  update(by: string, id: string, patch: TaskPatch, isHost = by === "host", now = Date.now()): Task | TaskError {
    const cur = this.tasks.get(id);
    if (!cur) return "not-found";
    const next: Task = { ...cur };
    if (patch.text !== undefined) {
      if (cur.by !== by && !isHost) return "forbidden";
      const t = cleanTaskText(patch.text);
      if (!t) return "empty";
      next.text = t;
    }
    if (cur.kind === "task") {
      if (patch.done !== undefined) next.done = patch.done;
      if (patch.owner !== undefined) next.owner = patch.owner;
      if (patch.state !== undefined || patch.note !== undefined || patch.result !== undefined) {
        if (!isHost && cur.by !== by && cur.owner !== by) return "forbidden";
        if (patch.state !== undefined && !isAgentTaskState(patch.state)) return "empty";
        if (patch.result !== undefined && !isResultId(patch.result)) return "empty";
        if (patch.state !== undefined) {
          next.state = patch.state;
          if (patch.state === "completed") next.done = true;
        }
        if (!next.state) next.state = "working";
        if (patch.note !== undefined) {
          const n = cleanTaskNote(patch.note);
          if (n) next.note = n;
          else delete next.note;
        }
        if (patch.result !== undefined) next.result = patch.result;
      }
    }
    next.editedBy = by;
    next.editedAt = now;
    next.v = ++this.v;
    this.tasks.set(id, next);
    return next;
  }

  remove(by: string, id: string, isHost = by === "host"): true | TaskError {
    const cur = this.tasks.get(id);
    if (!cur) return "not-found";
    if (cur.by !== by && !isHost) return "forbidden";
    this.tasks.delete(id);
    return true;
  }

  clear() {
    this.tasks.clear();
  }
}

// ---- whiteboard --------------------------------------------------------------

/** An Excalidraw element as relayed by the host: validated, size-capped, no images, http(s) links only. */
export type BoardElement = Record<string, unknown> & { id: string; type: string; version: number; versionNonce: number; isDeleted: boolean };

export const BOARD_TYPES = new Set(["rectangle", "ellipse", "diamond", "arrow", "line", "freedraw", "text", "frame", "selection"]);
export const MAX_BOARD_ELEMENTS = 3000;
export const MAX_ELEMENT_CHARS = 48 * 1024;
export const MAX_BOARD_CHARS = 6 * 1024 * 1024;
/** Max JSON characters of elements in one sealed board message. */
export const BOARD_BATCH_CHARS = 56 * 1024;
const EL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DROP_KEYS = new Set(["fileId", "customData", "status", "scale", "crop"]);

function plainJson(v: unknown, depth = 0): boolean {
  if (v === null || typeof v === "boolean" || typeof v === "string") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (depth > 6) return false;
  if (Array.isArray(v)) return v.length <= 20_000 && v.every((x) => plainJson(x, depth + 1));
  if (typeof v === "object") return Object.entries(v as object).length <= 64 && Object.values(v as object).every((x) => plainJson(x, depth + 1));
  return false;
}

export function cleanBoardElement(v: unknown): BoardElement | null {
  const o = v as Record<string, unknown>;
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  if (typeof o.id !== "string" || !EL_ID_RE.test(o.id) || typeof o.type !== "string" || !BOARD_TYPES.has(o.type)) return null;
  if (!int(o.version, 1) || !Number.isSafeInteger(o.versionNonce) || typeof o.isDeleted !== "boolean") return null;
  if (!plainJson(o)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(o)) {
    if (DROP_KEYS.has(k) || k === "__proto__" || k === "constructor" || k === "prototype") continue;
    if (k === "link") {
      out.link = typeof val === "string" && /^https?:\/\/[^\s]{1,2000}$/i.test(val) ? val : null;
      continue;
    }
    out[k] = val;
  }
  if (JSON.stringify(out).length > MAX_ELEMENT_CHARS) return null;
  return out as BoardElement;
}

/** Excalidraw's rule: higher version wins; on a tie, the lower versionNonce wins (every client converges). */
export function newerElement(a: Pick<BoardElement, "version" | "versionNonce">, b: Pick<BoardElement, "version" | "versionNonce"> | undefined): boolean {
  if (!b) return true;
  return a.version > b.version || (a.version === b.version && a.versionNonce < b.versionNonce);
}

/** Host-side whiteboard: merges element updates, returns the ones that changed the scene. */
export class BoardStore {
  private els = new Map<string, BoardElement>();
  private chars = 0;

  list(): BoardElement[] {
    return [...this.els.values()];
  }

  get size() {
    return this.els.size;
  }

  merge(incoming: unknown[]): BoardElement[] {
    const accepted: BoardElement[] = [];
    for (const raw of incoming.slice(0, 500)) {
      const el = cleanBoardElement(raw);
      if (!el) continue;
      const cur = this.els.get(el.id);
      if (!newerElement(el, cur)) continue;
      if (!cur && this.els.size >= MAX_BOARD_ELEMENTS) continue;
      const len = JSON.stringify(el).length;
      const prev = cur ? JSON.stringify(cur).length : 0;
      if (this.chars - prev + len > MAX_BOARD_CHARS) continue;
      this.chars += len - prev;
      this.els.set(el.id, el);
      accepted.push(el);
    }
    return accepted;
  }

  clear() {
    this.els.clear();
    this.chars = 0;
  }
}

/** Splits elements into batches that fit one sealed control message. */
export function boardBatches(els: BoardElement[], max = BOARD_BATCH_CHARS): BoardElement[][] {
  const out: BoardElement[][] = [];
  let cur: BoardElement[] = [];
  let size = 0;
  for (const el of els) {
    const n = JSON.stringify(el).length + 1;
    if (cur.length && (size + n > max || cur.length >= 200)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(el);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Client-side merge of remote elements into the local scene (same rule as the host). */
export function mergeScene(local: readonly BoardElement[], remote: readonly BoardElement[]): BoardElement[] {
  const byId = new Map(local.map((e) => [e.id, e] as const));
  let changed = false;
  for (const r of remote) {
    if (newerElement(r, byId.get(r.id))) {
      byId.set(r.id, r);
      changed = true;
    }
  }
  if (!changed) return local as BoardElement[];
  const all = [...byId.values()];
  // Excalidraw ≥ 0.18 orders elements by their fractional `index`.
  return all.sort((a, b) => {
    const ia = typeof a.index === "string" ? a.index : "";
    const ib = typeof b.index === "string" ? b.index : "";
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}
