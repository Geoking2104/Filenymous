// @vitest-environment node
import { describe, expect, it } from "vitest";
import fr from "../i18n/locales/fr.json";
import en from "../i18n/locales/en.json";
import { SYSTEM_TEXT, cleanPost, type Post } from "./feed";
import { cleanMeta } from "./model";
import { WallHost } from "./host";
import { createWall } from "./link";
import { SEARCH_MAX_CHARS, highlightRanges, normalizeQuery, searchPosts } from "./search-annotations";
import {
  ExportBlockedError,
  MAX_EXPORT_ITEM_BYTES,
  SNAPSHOT_FORMAT,
  b64ToBytes,
  buildSnapshot,
  buildTranscript,
  bytesToB64,
  parseSnapshot,
  snapshotFilename,
  snapshotItemToBlob,
} from "./snapshot";

const post = (id: string, o: Partial<Post>): Post => ({ id, kind: "msg", by: "host", at: 1, reactions: {}, ...o });

describe("wall search", () => {
  const feed: Post[] = [
    post("m1", { text: "Le café est prêt" }),
    post("m2", { text: "Rien à voir", by: "peer:1" }),
    post("f1", { kind: "file", item: { id: "f1", kind: "file", name: "Rapport-Été.pdf", mime: "application/pdf", size: 3, by: "host", at: 1 } as never }),
    post("p1", { kind: "poll", poll: { question: "Quel jour ?", options: ["Lundi", "Mardi café"], votes: [[], []], closed: false } as never }),
  ];
  it("matches messages, file names and poll options, case and accent insensitive", () => {
    expect(searchPosts(feed, "CAFE").map((p) => p.id)).toEqual(["m1", "p1"]);
    expect(searchPosts(feed, "ete").map((p) => p.id)).toEqual(["f1"]);
    expect(searchPosts(feed, "lundi").map((p) => p.id)).toEqual(["p1"]);
    expect(searchPosts(feed, "   ")).toEqual(feed);
    expect(searchPosts(feed, "zzz")).toEqual([]);
  });
  it("highlights ranges in the original text and caps the query", () => {
    expect(highlightRanges("Le café, CAFÉ", "cafe")).toEqual([[3, 7], [9, 13]]);
    expect(normalizeQuery("x".repeat(500)).length).toBeLessThanOrEqual(SEARCH_MAX_CHARS);
  });
});

describe("system notice (export transparency)", () => {
  it("is only accepted from the host on a msg post", () => {
    const base = { id: "m-aaaaaaaa", kind: "msg", by: "host", at: 1, text: SYSTEM_TEXT.exported, reactions: {}, system: "exported" };
    expect(cleanPost(base, cleanMeta)?.system).toBe("exported");
    expect(cleanPost({ ...base, by: "peer:1" }, cleanMeta)).toBeNull();
    expect(cleanPost({ ...base, system: "pwned" }, cleanMeta)).toBeNull();
    expect(cleanPost({ ...base, kind: "note" }, cleanMeta)).toBeNull();
    expect(cleanPost({ ...base, system: undefined }, cleanMeta)?.system).toBeUndefined();
  });
  it("announceExport posts a non-removable notice", async () => {
    const params = await createWall({ ttl: "h1", password: false, burn: false, hostLeave: true });
    const host = new WallHost(params, () => undefined, { name: "H" });
    host.announceExport();
    const p = host.state.posts.at(-1)!;
    expect(p).toMatchObject({ kind: "msg", by: "host", system: "exported", text: SYSTEM_TEXT.exported });
    host.removeItem(p.id);
    expect(host.state.posts.some((x) => x.id === p.id)).toBe(true);
    host.stop();
  });
});

describe("wall snapshot", () => {
  const wall = async (burn: boolean) => {
    const params = await createWall({ ttl: "h1", password: false, burn, hostLeave: true });
    const host = new WallHost(params, () => undefined, { name: "Hôte" });
    host.say("salut");
    host.addBlob("a.txt", "text/plain", new Blob([new TextEncoder().encode("hello")]));
    return host;
  };
  it("builds a JSON snapshot with posts, members and file bytes without burning them", async () => {
    const host = await wall(false);
    const s = await buildSnapshot({ title: "Équipe", burn: false, members: host.state.members, posts: host.state.posts, getItem: (id) => host.exportItem(id), now: 5 });
    expect(s).toMatchObject({ format: SNAPSHOT_FORMAT, v: 1, title: "Équipe", exportedAt: 5, burn: false, skipped: [] });
    expect(s.members[0]).toEqual({ label: "host", name: "Hôte", host: true });
    expect(s.posts.map((p) => p.kind)).toEqual(["msg", "file"]);
    expect(new TextDecoder().decode(b64ToBytes(s.items[0]!.dataB64))).toBe("hello");
    expect(host.exportItem(s.items[0]!.id)).not.toBeNull(); // not consumed
    const back = parseSnapshot(JSON.stringify(s));
    expect(back?.posts).toHaveLength(2);
    expect(buildTranscript(s)).toContain("salut");
    host.stop();
  });
  it("is refused on burn walls", async () => {
    const host = await wall(true);
    expect(host.exportItem(host.state.posts[1]!.id)).toBeNull();
    await expect(buildSnapshot({ burn: true, members: [], posts: host.state.posts, getItem: () => null })).rejects.toBeInstanceOf(ExportBlockedError);
    host.stop();
  });
  it("skips oversize or unavailable files and lists them", async () => {
    const big = post("f_big", { kind: "file", item: { id: "f_big", kind: "file", name: "big.bin", mime: "x/y", size: MAX_EXPORT_ITEM_BYTES + 1, by: "host", at: 1 } as never });
    const gone = post("f_gone", { kind: "file", item: { id: "f_gone", kind: "file", name: "gone.bin", mime: "x/y", size: 3, by: "host", at: 1 } as never });
    const s = await buildSnapshot({ burn: false, members: [], posts: [big, gone], getItem: () => null });
    expect(s.skipped.map((k) => [k.name, k.reason])).toEqual([["big.bin", "too-large"], ["gone.bin", "unavailable"]]);
    expect(s.items).toEqual([]);
  });
  it("parseSnapshot rejects malformed or hostile input and never trusts the MIME type", () => {
    expect(parseSnapshot("not json")).toBeNull();
    expect(parseSnapshot(JSON.stringify({ format: SNAPSHOT_FORMAT, v: 1, burn: false, exportedAt: 1, posts: [{ id: "x", kind: "script" }], members: [], items: [], skipped: [] }))).toBeNull();
    expect(parseSnapshot(JSON.stringify({ format: "other" }))).toBeNull();
    const blob = snapshotItemToBlob({ id: "f", meta: { mime: "text/html" } as never, dataB64: bytesToB64(new Uint8Array([60])) });
    expect(blob.type).toBe("application/octet-stream");
  });
  it("names files filenymous-mur-<slug>-<date>.json", () => {
    const d = new Date(2026, 9, 19).getTime();
    expect(snapshotFilename("Réunion d'équipe / Q4!", "json", d)).toBe("filenymous-mur-reunion-d-equipe-q4-2026-10-19.json");
    expect(snapshotFilename("", "md", d)).toBe("filenymous-mur-sans-nom-2026-10-19.md");
    expect(snapshotFilename("../../etc", "json", d)).toBe("filenymous-mur-etc-2026-10-19.json");
  });
  it("has FR and EN strings for search and export", () => {
    for (const l of [fr, en] as unknown as Array<{ wall: Record<string, Record<string, string>> }>) {
      expect(l.wall.export!.warning).toBeTruthy();
      expect(l.wall.export!.blockedBurn).toBeTruthy();
      expect(l.wall.system!.exported).toBeTruthy();
      expect(l.wall.search!.count_other).toContain("{{count}}");
    }
  });
});
