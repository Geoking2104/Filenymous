/**
 * Private agent-to-agent threads (feature 4). A thread links exactly two
 * agents of the wall, optionally with a goal and a linked task. It is still a
 * star: every message goes agent → host → agent over each peer's own sealed
 * channel, so the HOST TAB SEES EVERY MESSAGE (it decrypts and re-seals). The
 * host approves a thread before any message flows and can close it. Other
 * participants receive nothing (no feed noise).
 */
export type ThreadState = "pending" | "open" | "closed";

export interface Thread {
  id: string;
  /** Opener (agent label) and the other agent. */
  a: string;
  b: string;
  goal?: string;
  /** Linked task (e.g. a delegated task) on the wall checklist. */
  task?: string;
  state: ThreadState;
  at: number;
  closedBy?: string;
  /** Number of messages so far. */
  n: number;
}

export interface ThreadMsg {
  n: number;
  by: string;
  at: number;
  text: string;
}

export type ThreadRequest =
  | { t: "thread-open"; to: string; goal?: string; task?: string }
  | { t: "thread-say"; id: string; text: string }
  | { t: "thread-close"; id: string };

export type ThreadUpdate = { t: "thread"; thread: Thread } | { t: "thread-msg"; id: string; msg: ThreadMsg };

export const THREAD_GOAL_MAX = 500;
export const THREAD_TEXT_MAX = 4000;
export const THREAD_KEEP = 500;
export const THREADS_PER_AGENT = 8;

const LABEL_RE = /^(host|peer:\d{1,6})$/;
const THREAD_ID_RE = /^th-[0-9a-f]{16}$/;
const TASK_ID_RE = /^t-[0-9a-f]{16}$/;
const clean = (s: string, max: number) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim().slice(0, max);
const int = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= Number.MAX_SAFE_INTEGER;

export const isThreadId = (s: unknown): s is string => typeof s === "string" && THREAD_ID_RE.test(s);

export function cleanThread(o: unknown): Thread | null {
  if (!o || typeof o !== "object") return null;
  const t = o as Record<string, unknown>;
  if (!isThreadId(t.id) || typeof t.a !== "string" || !LABEL_RE.test(t.a) || typeof t.b !== "string" || !LABEL_RE.test(t.b) || t.a === t.b) return null;
  if (t.state !== "pending" && t.state !== "open" && t.state !== "closed") return null;
  if (!int(t.at) || !int(t.n)) return null;
  if (t.goal !== undefined && (typeof t.goal !== "string" || t.goal.length > THREAD_GOAL_MAX)) return null;
  if (t.task !== undefined && (typeof t.task !== "string" || !TASK_ID_RE.test(t.task))) return null;
  if (t.closedBy !== undefined && (typeof t.closedBy !== "string" || !LABEL_RE.test(t.closedBy))) return null;
  return {
    id: t.id, a: t.a, b: t.b, state: t.state, at: t.at as number, n: t.n as number,
    ...(t.goal ? { goal: t.goal as string } : {}), ...(t.task ? { task: t.task as string } : {}), ...(t.closedBy ? { closedBy: t.closedBy as string } : {}),
  };
}

export function parseThreadMessage(o: Record<string, unknown>): ThreadRequest | ThreadUpdate | null {
  switch (o.t) {
    case "thread-open": {
      if (typeof o.to !== "string" || !LABEL_RE.test(o.to)) return null;
      if (o.goal !== undefined && typeof o.goal !== "string") return null;
      if (o.task !== undefined && (typeof o.task !== "string" || !TASK_ID_RE.test(o.task))) return null;
      const goal = typeof o.goal === "string" ? clean(o.goal, THREAD_GOAL_MAX) : "";
      return { t: "thread-open", to: o.to, ...(goal ? { goal } : {}), ...(o.task ? { task: o.task as string } : {}) };
    }
    case "thread-say": {
      if (!isThreadId(o.id) || typeof o.text !== "string") return null;
      const text = clean(o.text, THREAD_TEXT_MAX);
      return text ? { t: "thread-say", id: o.id, text } : null;
    }
    case "thread-close":
      return isThreadId(o.id) ? { t: "thread-close", id: o.id } : null;
    case "thread": {
      const thread = cleanThread(o.thread);
      return thread ? { t: "thread", thread } : null;
    }
    case "thread-msg": {
      const m = o.msg as Record<string, unknown> | undefined;
      if (!isThreadId(o.id) || !m || typeof m !== "object" || !int(m.n) || !int(m.at) || typeof m.by !== "string" || !LABEL_RE.test(m.by)) return null;
      if (typeof m.text !== "string" || !m.text || m.text.length > THREAD_TEXT_MAX) return null;
      return { t: "thread-msg", id: o.id, msg: { n: m.n as number, by: m.by, at: m.at as number, text: m.text } };
    }
    default:
      return null;
  }
}

export function newThreadId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return `th-${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** Host-side store. */
export class ThreadBoard {
  private threads = new Map<string, Thread>();
  private msgs = new Map<string, ThreadMsg[]>();

  constructor(private newId: () => string = newThreadId) {}

  list(): Thread[] {
    return [...this.threads.values()];
  }
  get(id: string): Thread | undefined {
    return this.threads.get(id);
  }
  messages(id: string): ThreadMsg[] {
    return this.msgs.get(id) ?? [];
  }
  involves(t: Thread, label: string) {
    return t.a === label || t.b === label;
  }

  open(a: string, b: string, goal?: string, task?: string): Thread | "limit" | "self" {
    if (a === b) return "self";
    const live = (l: string) => this.list().filter((t) => t.state !== "closed" && this.involves(t, l)).length;
    if (live(a) >= THREADS_PER_AGENT || live(b) >= THREADS_PER_AGENT) return "limit";
    const t: Thread = { id: this.newId(), a, b, state: "pending", at: Date.now(), n: 0, ...(goal ? { goal } : {}), ...(task ? { task } : {}) };
    this.threads.set(t.id, t);
    this.msgs.set(t.id, []);
    return t;
  }

  setState(id: string, state: ThreadState, by?: string): Thread | null {
    const t = this.threads.get(id);
    if (!t || t.state === "closed" || t.state === state) return null;
    const next: Thread = { ...t, state, ...(state === "closed" && by ? { closedBy: by } : {}) };
    this.threads.set(id, next);
    return next;
  }

  say(id: string, by: string, text: string): { thread: Thread; msg: ThreadMsg } | null {
    const t = this.threads.get(id);
    if (!t || t.state !== "open" || !this.involves(t, by)) return null;
    const msg: ThreadMsg = { n: t.n + 1, by, at: Date.now(), text };
    const list = this.msgs.get(id)!;
    list.push(msg);
    if (list.length > THREAD_KEEP) list.splice(0, list.length - THREAD_KEEP);
    const thread = { ...t, n: msg.n };
    this.threads.set(id, thread);
    return { thread, msg };
  }

  /** Closes every thread of a participant who left. */
  closeAllOf(label: string): Thread[] {
    const out: Thread[] = [];
    for (const t of this.list()) if (t.state !== "closed" && this.involves(t, label)) out.push(this.setState(t.id, "closed", "host")!);
    return out;
  }
}
