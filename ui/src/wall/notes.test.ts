// @vitest-environment node
import { describe, expect, it } from "vitest";
import { LIMITS } from "./feed";
import { WallHost } from "./host";
import { createWall } from "./link";
import { parseWallMessage } from "./model";
import { MAX_NOTES, MAX_NOTES_PER_AUTHOR, NOTE_LOCK_MS, NOTE_MAX_BYTES, NoteBoard, cleanSharedNote, isNoteId, newNoteId, type SharedNote } from "./notes";
import { searchNotes } from "./search-annotations";
import { buildSnapshot, buildTranscript, parseSnapshot } from "./snapshot";

const clock = () => {
  let t = 1_000;
  return { now: () => t, tick: (ms: number) => (t += ms) };
};
const ok = (r: SharedNote | string): SharedNote => {
  if (typeof r === "string") throw new Error(r);
  return r;
};

describe("NoteBoard (host authority)", () => {
  it("assigns host versions from one monotonic counter and ignores client versions", () => {
    const b = new NoteBoard();
    const a = ok(b.create("peer:1", "A", "x"));
    const c = ok(b.create("peer:2", "B", ""));
    expect(a.v).toBe(1);
    expect(c.v).toBe(2);
    const e = b.edit("peer:1", a.id, Number.MAX_SAFE_INTEGER, { text: "y" });
    expect(typeof e).toBe("object");
    expect((e as { note: SharedNote }).note.v).toBe(3);
    // A malicious "huge version" cannot lock the note: the next edit from anyone still applies.
    const f = b.edit("peer:2", a.id, 0, { text: "z" }) as { note: SharedNote; overwrote?: string };
    expect(f.note).toMatchObject({ text: "z", v: 4, editedBy: "peer:2" });
    expect(f.overwrote).toBe("peer:1");
  });

  it("is last-writer-wins in host order and reports blind overwrites only", () => {
    const b = new NoteBoard();
    const n = ok(b.create("host", "", ""));
    const one = b.edit("peer:1", n.id, n.v, { text: "un" }) as { note: SharedNote; overwrote?: string };
    expect(one.overwrote).toBeUndefined();
    // peer:2 edits from the old base → wins, and peer:1 is told.
    const two = b.edit("peer:2", n.id, n.v, { text: "deux" }) as { note: SharedNote; overwrote?: string };
    expect(two.note.text).toBe("deux");
    expect(two.overwrote).toBe("peer:1");
    // peer:1 saw v of "deux" → no overwrite flag; same author never flags itself.
    expect((b.edit("peer:1", n.id, two.note.v, { text: "trois" }) as { overwrote?: string }).overwrote).toBeUndefined();
    expect((b.edit("peer:1", n.id, 0, { text: "quatre" }) as { overwrote?: string }).overwrote).toBeUndefined();
    expect(b.get(n.id)!.text).toBe("quatre");
  });

  it("generates random host ids and rejects bad ids", () => {
    const ids = new Set(Array.from({ length: 200 }, newNoteId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(isNoteId(id)).toBe(true);
    for (const bad of ["", "n-123", "../etc", "n-ZZZZZZZZZZZZZZZZ", "note-1", 5, null]) expect(isNoteId(bad)).toBe(false);
    const b = new NoteBoard();
    expect(b.edit("peer:1", "n-0000000000000000", 0, { text: "x" })).toBe("not-found");
  });

  it("enforces size, count and per-author limits", () => {
    const b = new NoteBoard();
    expect(b.create("peer:1", "t", "x".repeat(NOTE_MAX_BYTES + 1))).toBe("too-large");
    expect(b.create("peer:1", "t", "é".repeat(NOTE_MAX_BYTES / 2 + 1))).toBe("too-large"); // bytes, not chars
    const n = ok(b.create("peer:1", "t".repeat(300), "ok"));
    expect(n.title.length).toBe(80);
    expect(b.edit("peer:1", n.id, n.v, { text: "x".repeat(NOTE_MAX_BYTES + 1) })).toBe("too-large");
    for (let i = 1; i < MAX_NOTES_PER_AUTHOR; i++) ok(b.create("peer:1", `${i}`, ""));
    expect(b.create("peer:1", "one too many", "")).toBe("too-many-notes");
    for (let i = MAX_NOTES_PER_AUTHOR; i < MAX_NOTES; i++) ok(b.create("host", `${i}`, ""));
    expect(b.create("host", "full", "")).toBe("too-many-notes");
  });

  it("deletes only for the author or the host", () => {
    const b = new NoteBoard();
    const n = ok(b.create("peer:1", "", ""));
    expect(b.remove("peer:2", n.id)).toBe("forbidden");
    expect(b.remove("peer:1", n.id)).toBe(true);
    const m = ok(b.create("peer:1", "", ""));
    expect(b.remove("host", m.id)).toBe(true);
  });

  it("soft locks: host-set duration, auto-expiry, no stealing except by the host, never blocking edits", () => {
    const c = clock();
    const b = new NoteBoard(c.now);
    const n = ok(b.create("peer:1", "", ""));
    expect(b.lock("peer:1", n.id, true)).toEqual({ id: n.id, label: "peer:1", until: 1_000 + NOTE_LOCK_MS });
    expect(b.lock("peer:2", n.id, true)).toBeUndefined();
    expect(b.lock("peer:2", n.id, false)).toBeUndefined(); // can't release someone else's
    // A locked note can still be edited by anyone.
    expect(typeof b.edit("peer:2", n.id, n.v, { text: "malgré le verrou" })).toBe("object");
    c.tick(NOTE_LOCK_MS + 1);
    expect(b.lockOf(n.id)).toBeNull();
    expect(b.lock("peer:2", n.id, true)?.label).toBe("peer:2");
    expect(b.lock("host", n.id, true)?.label).toBe("host"); // host override
    expect(b.releaseAll("host")).toEqual([n.id]);
  });
});

describe("notes protocol validation", () => {
  it("parses peer operations strictly and drops client-supplied versions", () => {
    expect(parseWallMessage({ t: "snote-new", title: "A", text: "b", v: 99 })).toEqual({ t: "snote-new", title: "A", text: "b" });
    expect(parseWallMessage({ t: "snote-new", title: "A", text: "x".repeat(NOTE_MAX_BYTES + 1) })).toBeNull();
    expect(parseWallMessage({ t: "snote-edit", id: "n-0123456789abcdef", base: 1e300, text: "x" })).toBeNull();
    expect(parseWallMessage({ t: "snote-edit", id: "n-0123456789abcdef", base: 3 })).toBeNull();
    expect(parseWallMessage({ t: "snote-edit", id: "bad", base: 3, text: "x" })).toBeNull();
    expect(parseWallMessage({ t: "snote-edit", id: "n-0123456789abcdef", base: 3, text: "x", version: 9 })).toEqual({ t: "snote-edit", id: "n-0123456789abcdef", base: 3, text: "x" });
    expect(parseWallMessage({ t: "snote-lock", id: "n-0123456789abcdef", on: true, until: 9e15 })).toEqual({ t: "snote-lock", id: "n-0123456789abcdef", on: true });
    expect(parseWallMessage({ t: "snote-del", id: "<script>" })).toBeNull();
  });
  it("validates notes received from the host", () => {
    const good = { id: "n-0123456789abcdef", title: "T", text: "x", v: 1, by: "peer:1", at: 1, editedBy: "host", editedAt: 2, pinned: false };
    expect(cleanSharedNote(good)).toEqual(good);
    expect(cleanSharedNote({ ...good, by: "<b>" })).toBeNull();
    expect(cleanSharedNote({ ...good, v: -1 })).toBeNull();
    expect(cleanSharedNote({ ...good, extra: "dropped" })).toEqual(good);
    expect(parseWallMessage({ t: "snote", note: good, overwrote: "peer:1" })).toEqual({ t: "snote", note: good, overwrote: "peer:1" });
    expect(parseWallMessage({ t: "snote", note: good, overwrote: "nobody" })).toBeNull();
  });
});

describe("WallHost notes", () => {
  const make = async (burn = false) => {
    const params = await createWall({ ttl: "h1", password: false, burn, hostLeave: true });
    const host = new WallHost(params, () => undefined, { name: "H" });
    const peer = { out: Promise.resolve(), pipe: null, channel: null, label: "peer:1" };
    const apply = (label: string, msg: unknown) => (host as unknown as { apply(l: string, p: unknown, m: unknown): void }).apply(label, { ...peer, label }, parseWallMessage(msg));
    return { host, apply };
  };

  it("applies peer ops, rate-limits note edits per participant, and ignores host-only messages from peers", async () => {
    const { host, apply } = await make();
    apply("peer:1", { t: "snote-new", title: "Plan", text: "a" });
    const n = host.state.notes[0]!;
    expect(n).toMatchObject({ title: "Plan", by: "peer:1", v: 1 });
    let applied = 0;
    for (let i = 0; i < LIMITS.note.capacity + 10; i++) {
      const before = host.state.notes[0]!.v;
      apply("peer:1", { t: "snote-edit", id: n.id, base: 0, text: `t${i}` });
      if (host.state.notes[0]!.v > before) applied++;
    }
    expect(applied).toBeLessThanOrEqual(LIMITS.note.capacity + 1);
    // Another participant has its own bucket.
    apply("peer:2", { t: "snote-edit", id: n.id, base: 0, text: "p2" });
    expect(host.state.notes[0]!.text).toBe("p2");
    // A peer forging a host message ("snote") changes nothing.
    apply("peer:2", { t: "snote", note: { ...host.state.notes[0]!, text: "forged", v: 999 } });
    expect(host.state.notes[0]!.text).toBe("p2");
    apply("peer:2", { t: "snote-del", id: n.id });
    expect(host.state.notes).toHaveLength(1);
    host.pinNote(n.id, true);
    expect(host.state.notes[0]!.pinned).toBe(true);
    host.deleteNote(n.id);
    expect(host.state.notes).toHaveLength(0);
    host.stop();
  });

  it("flags the host when its edit was overwritten; locks are exposed in state", async () => {
    const { host, apply } = await make();
    host.createNote("Doc", "");
    const n = host.state.notes[0]!;
    host.editNote(n.id, n.v, { text: "host" });
    apply("peer:1", { t: "snote-edit", id: n.id, base: n.v, text: "peer" });
    expect(host.state.noteOverwrite).toMatchObject({ id: n.id, by: "peer:1" });
    apply("peer:1", { t: "snote-lock", id: n.id, on: true });
    expect(host.state.noteLocks[n.id]?.label).toBe("peer:1");
    host.stop();
  });

  it("notes are searchable and go into the export (JSON + Markdown), never on burn walls", async () => {
    const { host } = await make();
    host.createNote("Compte rendu", "Décision : on garde le café");
    const st = host.state;
    expect(searchNotes(st.notes, "decision").map((n) => n.title)).toEqual(["Compte rendu"]);
    expect(searchNotes(st.notes, "compte")).toHaveLength(1);
    expect(searchNotes(st.notes, "absent")).toHaveLength(0);
    const snap = await buildSnapshot({ burn: false, members: st.members, posts: st.posts, notes: st.notes, getItem: () => null });
    expect(snap.notes).toHaveLength(1);
    expect(parseSnapshot(JSON.stringify(snap))?.notes[0]?.text).toBe("Décision : on garde le café");
    expect(parseSnapshot(JSON.stringify({ ...snap, notes: [{ ...snap.notes[0], id: "evil" }] }))).toBeNull();
    const md = buildTranscript(snap);
    expect(md).toContain("## Notes partagées");
    expect(md).toContain("Décision : on garde le café");
    await expect(buildSnapshot({ burn: true, members: [], posts: [], notes: st.notes, getItem: () => null })).rejects.toThrow();
    host.stop();
  });
});
