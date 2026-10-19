/**
 * Sharewall shared notes: small collaborative documents, host-authoritative.
 *
 * Star topology, like the feed: peers send *operations* (create, edit,
 * delete, soft lock) and the host alone decides. Versions are assigned by
 * the host from a single monotonic counter; anything a client claims about
 * versions is only used to detect that its edit replaced someone else's
 * (the "overwritten" toast), never to accept or refuse an edit.
 *
 * Conflicts: last writer wins, in host arrival order. Locks are soft and
 * purely informative ("X est en train d'écrire"): they expire on their own
 * after NOTE_LOCK_MS, never block an edit, and the host can take them over.
 */

export const NOTE_MAX_BYTES = 64 * 1024;
export const NOTE_TITLE_MAX = 80;
export const MAX_NOTES = 50;
export const MAX_NOTES_PER_AUTHOR = 10;
export const NOTE_LOCK_MS = 10_000;

export interface SharedNote {
  id: string;
  title: string;
  text: string;
  /** Host-assigned version (monotonic across the whole wall). */
  v: number;
  /** Creator label. */
  by: string;
  at: number;
  editedBy: string;
  editedAt: number;
  pinned: boolean;
}

export interface NoteLock {
  id: string;
  label: string;
  until: number;
}

export type NoteError = "too-many-notes" | "too-large" | "not-found" | "forbidden" | "empty";

const ID_RE = /^n-[0-9a-f]{16}$/;
const LABEL_RE = /^(host|peer:\d{1,6})$/;
export const isNoteId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);

/** Host-generated note id: "n-" + 64 random bits (crypto.getRandomValues). */
export function newNoteId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return `n-${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

const enc = new TextEncoder();
export const utf8Bytes = (s: string) => enc.encode(s).length;

/** Note body: keeps newlines and tabs, drops other control characters. Null if too large. */
export function cleanNoteText(v: unknown): string | null {
  if (typeof v !== "string" || v.length > NOTE_MAX_BYTES) return null;
  const s = v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  return utf8Bytes(s) <= NOTE_MAX_BYTES ? s : null;
}

export function cleanNoteTitle(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 400) return null;
  return v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, NOTE_TITLE_MAX);
}

const int = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;

/** Validates a note received from the host (peers never trust raw input). */
export function cleanSharedNote(n: unknown): SharedNote | null {
  const o = n as Record<string, unknown>;
  if (!o || typeof o !== "object") return null;
  if (!isNoteId(o.id) || !LABEL_RE.test(String(o.by)) || !LABEL_RE.test(String(o.editedBy))) return null;
  if (!int(o.v) || !int(o.at) || !int(o.editedAt) || typeof o.pinned !== "boolean") return null;
  const title = cleanNoteTitle(o.title);
  const text = cleanNoteText(o.text);
  if (title === null || text === null) return null;
  return { id: o.id, title, text, v: o.v as number, by: o.by as string, at: o.at as number, editedBy: o.editedBy as string, editedAt: o.editedAt as number, pinned: o.pinned };
}

export function cleanNoteLock(l: unknown): NoteLock | null {
  const o = l as Record<string, unknown>;
  if (!o || typeof o !== "object" || !isNoteId(o.id) || !LABEL_RE.test(String(o.label)) || !int(o.until)) return null;
  return { id: o.id, label: o.label as string, until: o.until as number };
}

export function sortNotes(notes: SharedNote[]): SharedNote[] {
  return [...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.editedAt - a.editedAt);
}

/** The host's authoritative note board. */
export class NoteBoard {
  private notes = new Map<string, SharedNote>();
  private locks = new Map<string, NoteLock>();
  private clock = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly makeId: () => string = newNoteId,
  ) {}

  list(): SharedNote[] {
    return sortNotes([...this.notes.values()]);
  }

  get(id: string): SharedNote | undefined {
    return this.notes.get(id);
  }

  create(by: string, title: unknown, text: unknown): SharedNote | NoteError {
    if (this.notes.size >= MAX_NOTES) return "too-many-notes";
    if (by !== "host" && [...this.notes.values()].filter((n) => n.by === by).length >= MAX_NOTES_PER_AUTHOR) return "too-many-notes";
    const t = cleanNoteTitle(title ?? "");
    const body = cleanNoteText(text ?? "");
    if (t === null || body === null) return "too-large";
    let id = this.makeId();
    while (this.notes.has(id)) id = this.makeId();
    const at = this.now();
    const note: SharedNote = { id, title: t, text: body, v: ++this.clock, by, at, editedBy: by, editedAt: at, pinned: false };
    this.notes.set(id, note);
    return note;
  }

  /**
   * Last writer wins. `base` is the version the editor last saw: used only to
   * tell whose edit got replaced without being seen (returned as `overwrote`).
   */
  edit(by: string, id: string, base: number, patch: { title?: unknown; text?: unknown }): { note: SharedNote; overwrote?: string } | NoteError {
    const cur = this.notes.get(id);
    if (!cur) return "not-found";
    const title = patch.title === undefined ? cur.title : cleanNoteTitle(patch.title);
    const text = patch.text === undefined ? cur.text : cleanNoteText(patch.text);
    if (title === null || text === null) return "too-large";
    const overwrote = base < cur.v && cur.editedBy !== by ? cur.editedBy : undefined;
    const note: SharedNote = { ...cur, title, text, v: ++this.clock, editedBy: by, editedAt: this.now() };
    this.notes.set(id, note);
    return overwrote ? { note, overwrote } : { note };
  }

  remove(by: string, id: string): true | NoteError {
    const cur = this.notes.get(id);
    if (!cur) return "not-found";
    if (by !== "host" && cur.by !== by) return "forbidden";
    this.notes.delete(id);
    this.locks.delete(id);
    return true;
  }

  /** Host only. */
  pin(id: string, on: boolean): SharedNote | NoteError {
    const cur = this.notes.get(id);
    if (!cur) return "not-found";
    const note = { ...cur, pinned: on, v: ++this.clock };
    this.notes.set(id, note);
    return note;
  }

  /**
   * Soft lock. The duration is the host's, never the client's. Another
   * member's live lock is kept (no stealing), except by the host. Returns the
   * resulting lock state of the note when it changed, undefined otherwise.
   */
  lock(by: string, id: string, on: boolean): NoteLock | null | undefined {
    if (!this.notes.has(id)) return undefined;
    const t = this.now();
    const cur = this.lockOf(id);
    if (!on) {
      if (!cur || cur.label !== by) return undefined;
      this.locks.delete(id);
      return null;
    }
    if (cur && cur.label !== by && by !== "host") return undefined;
    const next = { id, label: by, until: t + NOTE_LOCK_MS };
    this.locks.set(id, next);
    return next;
  }

  lockOf(id: string): NoteLock | null {
    const l = this.locks.get(id);
    if (!l) return null;
    if (l.until <= this.now()) {
      this.locks.delete(id);
      return null;
    }
    return l;
  }

  /** A departing member's locks go away with them. */
  releaseAll(label: string): string[] {
    const ids: string[] = [];
    for (const [id, l] of this.locks) if (l.label === label) (this.locks.delete(id), ids.push(id));
    return ids;
  }

  clear() {
    this.notes.clear();
    this.locks.clear();
  }
}
