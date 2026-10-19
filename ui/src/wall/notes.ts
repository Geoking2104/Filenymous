/**
 * Collaborative notes for ShareWall.
 * Simple last-write-wins shared text, host-authoritative.
 *
 * New control messages (add to WallMessage in model.ts):
 *   | { t: "note-set"; id: string; text: string; version: number }
 *   | { t: "note-update"; id: string; text: string; version: number }  // host → peers
 *
 * Host keeps Map<id, { text: string; version: number; by: string }>
 * On "note-set": if version > current, accept, broadcast "note-update".
 */

export interface CollabNote {
  id: string;
  text: string;
  version: number;
  by: string;
  at: number;
}

export class NoteBoard {
  private notes = new Map<string, CollabNote>();

  list(): CollabNote[] {
    return [...this.notes.values()].sort((a, b) => b.at - a.at);
  }

  get(id: string): CollabNote | undefined {
    return this.notes.get(id);
  }

  /** Host applies a peer's proposed update. Returns true if accepted. */
  apply(id: string, text: string, version: number, by: string): CollabNote | null {
    const cur = this.notes.get(id);
    if (cur && version <= cur.version) return null;
    const next: CollabNote = { id, text: text.slice(0, 64 * 1024), version, by, at: Date.now() };
    this.notes.set(id, next);
    return next;
  }

  create(by: string, initial = ""): CollabNote {
    const id = `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const note: CollabNote = { id, text: initial, version: 1, by, at: Date.now() };
    this.notes.set(id, note);
    return note;
  }

  remove(id: string) {
    this.notes.delete(id);
  }

  clear() {
    this.notes.clear();
  }
}
