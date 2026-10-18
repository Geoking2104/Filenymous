// @vitest-environment node
import { describe, expect, it } from "vitest";
import fr from "../i18n/locales/fr.json";
import en from "../i18n/locales/en.json";
import {
  LIMITS,
  MAX_POSTS,
  RateLimiter,
  castVote,
  cleanMember,
  cleanMessage,
  cleanName,
  cleanPost,
  diffMembers,
  extractMentions,
  groupPosts,
  initials,
  isEmoji,
  makePoll,
  pollTotals,
  pseudonym,
  toggleReaction,
  type Post,
} from "./feed";
import { parseMarkup, plainPreview, safeHref } from "./markup";
import { EMOJI_GROUPS, QUICK_REACTIONS, searchEmoji } from "./emoji";
import { cleanMeta, parseWallMessage } from "./model";
import { createWall } from "./link";
import { WallHost } from "./host";

const post = (over: Partial<Post> = {}): Post => ({ id: "m1", kind: "msg", by: "peer:1", at: 1000, text: "hi", reactions: {}, ...over });

describe("Sharewall feed model", () => {
  it("cleans names and messages (no control or bidi override characters)", () => {
    expect(cleanName("  Alice\u202e\u0000  Bob \n")).toBe("Alice Bob");
    expect(cleanName("x".repeat(80))).toHaveLength(32);
    expect(cleanName(42)).toBe("");
    expect(cleanMessage("a\r\nb\u0007\n\n\n\n\nc")).toBe("a\nb\n\n\nc");
    expect(cleanMessage("x".repeat(5000))).toHaveLength(4000);
  });

  it("makes friendly pseudonyms and initials", () => {
    expect(pseudonym("fr", () => 0)).toBe("Loutre Azur");
    expect(pseudonym("en-GB", () => 0)).toBe("Azure Otter");
    expect(initials("Loutre Jade")).toBe("LJ");
    expect(initials("solo")).toBe("SO");
  });

  it("toggles reactions per member and refuses non-emoji", () => {
    let p = toggleReaction(post(), "👍", "peer:1");
    p = toggleReaction(p, "👍", "host");
    expect(p.reactions["👍"]).toEqual(["peer:1", "host"]);
    p = toggleReaction(p, "👍", "peer:1");
    expect(p.reactions["👍"]).toEqual(["host"]);
    p = toggleReaction(p, "👍", "host");
    expect(p.reactions).toEqual({});
    expect(toggleReaction(post(), "<img>", "host").reactions).toEqual({});
    expect(isEmoji("❤️")).toBe(true);
    expect(isEmoji("👍🏽")).toBe(true);
    expect(isEmoji("abc")).toBe(false);
    expect(isEmoji("1")).toBe(false);
  });

  it("validates polls and counts single-choice votes", () => {
    expect(makePoll("Q?", ["a"])).toBeNull();
    expect(makePoll("Q?", ["a", "A"])).toBeNull();
    expect(makePoll("", ["a", "b"])).toBeNull();
    expect(makePoll("Q?", ["1", "2", "3", "4", "5", "6", "7"])).toBeNull();
    const poll = makePoll("  Pizza   ou sushi ? ", ["Pizza", "Sushi"])!;
    expect(poll.question).toBe("Pizza ou sushi ?");
    let p = post({ kind: "poll", poll, text: undefined });
    p = castVote(p, 0, "peer:1");
    p = castVote(p, 1, "peer:1"); // switches
    p = castVote(p, 1, "host");
    expect(pollTotals(p.poll!)).toEqual({ counts: [0, 2], total: 2 });
    p = castVote(p, 1, "host"); // toggles off
    expect(pollTotals(p.poll!).total).toBe(1);
    expect(castVote(p, 9, "host")).toBe(p);
    const closed = { ...p, poll: { ...p.poll!, closed: true } };
    expect(castVote(closed, 0, "host")).toBe(closed);
  });

  it("finds @mentions (longest name first, word boundary)", () => {
    const members = [
      { label: "peer:1", name: "Loutre" },
      { label: "peer:2", name: "Loutre Jade" },
      { label: "host", name: "Bob" },
    ];
    expect(extractMentions("salut @loutre jade et @Bob!", members).sort()).toEqual(["host", "peer:2"]);
    expect(extractMentions("@Bobby", members)).toEqual([]);
    expect(extractMentions("mail@bob", members)).toEqual([]);
  });

  it("groups consecutive posts by author within 5 minutes", () => {
    const rows = groupPosts([post({ at: 0 }), post({ id: "m2", at: 60_000 }), post({ id: "m3", at: 400_000 }), post({ id: "m4", by: "host", at: 400_001 })]);
    expect(rows.map((r) => r.first)).toEqual([true, false, true, true]);
  });

  it("rate limits with a token bucket (agents loops, spam)", () => {
    let now = 0;
    const rl = new RateLimiter(LIMITS.chat.capacity, LIMITS.chat.perSecond, () => now);
    for (let i = 0; i < 8; i++) expect(rl.take("peer:1")).toBe(true);
    expect(rl.take("peer:1")).toBe(false);
    expect(rl.retryIn("peer:1")).toBeGreaterThan(1000);
    expect(rl.take("peer:2")).toBe(true);
    now += 1500;
    expect(rl.take("peer:1")).toBe(true);
    expect(rl.take("peer:1")).toBe(false);
  });

  it("diffs member lists", () => {
    const a = cleanMember({ label: "peer:1", name: "A" })!;
    const b = cleanMember({ label: "peer:2", name: "B", agent: true })!;
    expect(b.agent).toBe(true);
    expect(cleanMember({ label: "evil", name: "x" })).toBeNull();
    expect(diffMembers([a], [b])).toEqual({ joined: [b], left: [a] });
  });

  it("validates posts received from the host", () => {
    expect(cleanPost(post(), cleanMeta)).toEqual(post());
    expect(cleanPost(post({ text: "" }), cleanMeta)).toBeNull();
    expect(cleanPost({ ...post(), by: "<b>" }, cleanMeta)).toBeNull();
    expect(cleanPost({ ...post(), reactions: { x: ["host"] } }, cleanMeta)).toBeNull();
    expect(cleanPost({ ...post(), reactions: { "👍": ["nobody"] } }, cleanMeta)).toBeNull();
    const item = { id: "i1-x", kind: "text", name: "", size: 3, mime: "text/plain", by: "host", at: 1 };
    expect(cleanPost({ id: "i1-x", kind: "file", by: "host", at: 1, item, reactions: {} }, cleanMeta)).toBeNull(); // note must be kind "note"
    expect(cleanPost({ id: "i1-x", kind: "note", by: "host", at: 1, item, reactions: {} }, cleanMeta)?.kind).toBe("note");
  });
});

describe("Sharewall markdown-lite (never HTML)", () => {
  it("parses bold, italic, code, quotes, fences, links and mentions as an AST", () => {
    const b = parseMarkup("**gras** et *ital* `x<y>` https://ex.com/a?b=1. @Bob", [{ label: "host", name: "Bob" }]);
    expect(b).toHaveLength(1);
    const kinds = (b[0] as { c: Array<{ t: string }> }).c.map((n) => n.t);
    expect(kinds).toEqual(["b", "text", "i", "text", "code", "text", "link", "text", "mention"]);
    const link = (b[0] as { c: Array<{ t: string; href?: string }> }).c.find((n) => n.t === "link")!;
    expect(link.href).toBe("https://ex.com/a?b=1");
    expect(parseMarkup("> cité\nsuite").map((x) => x.t)).toEqual(["quote", "p"]);
    expect(parseMarkup("```js\nlet a = '<b>';\n```")).toEqual([{ t: "pre", v: "let a = '<b>';" }]);
  });

  it("keeps HTML and dangerous URLs as plain text", () => {
    const b = parseMarkup('<img src=x onerror=alert(1)> javascript:alert(1) data:text/html,<b>');
    expect(JSON.stringify(b)).not.toContain('"link"');
    expect(b).toEqual([{ t: "p", c: [{ t: "text", v: '<img src=x onerror=alert(1)> javascript:alert(1) data:text/html,<b>' }] }]);
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("https://filenymous.eu/")).toBe("https://filenymous.eu/");
    expect(plainPreview("**a** `b`\n> c")).toBe("a b c");
  });

  it("does not italicize inside words (snake_case, 2*3*4)", () => {
    expect(parseMarkup("snake_case_name 2*3*4")).toEqual([{ t: "p", c: [{ t: "text", v: "snake_case_name 2*3*4" }] }]);
  });
});

describe("Sharewall emoji set (bundled, offline)", () => {
  it("ships ~100+ emojis with FR/EN keywords and valid quick reactions", () => {
    const all = EMOJI_GROUPS.flatMap((g) => g.list);
    expect(all.length).toBeGreaterThanOrEqual(100);
    for (const e of all) expect(isEmoji(e.e), e.e).toBe(true);
    for (const e of QUICK_REACTIONS) expect(isEmoji(e)).toBe(true);
    expect(searchEmoji("fête")).toContain("🎉");
    expect(searchEmoji("party")).toContain("🎉");
    expect(searchEmoji("robot")).toContain("🤖");
  });
});

describe("Sharewall v2 protocol validation", () => {
  it("accepts the new messages and rejects malformed ones", () => {
    expect(parseWallMessage({ t: "profile", name: " Ana\u202e ", agent: true, media: false })).toEqual({ t: "profile", name: "Ana", agent: true, media: false });
    expect(parseWallMessage({ t: "say", text: "hi", replyTo: "m1" })).toEqual({ t: "say", text: "hi", replyTo: "m1" });
    expect(parseWallMessage({ t: "say", text: "hi", replyTo: "../x" })).toBeNull();
    expect(parseWallMessage({ t: "react", id: "m1", emoji: "🎉" })).toEqual({ t: "react", id: "m1", emoji: "🎉" });
    expect(parseWallMessage({ t: "react", id: "m1", emoji: "<b>" })).toBeNull();
    expect(parseWallMessage({ t: "vote", id: "q1", option: 7 })).toBeNull();
    expect(parseWallMessage({ t: "burst", kind: "applause" })).toEqual({ t: "burst", kind: "applause" });
    expect(parseWallMessage({ t: "burst", kind: "boom" })).toBeNull();
    expect(parseWallMessage({ t: "live-start", kind: "screen", tracks: 3 })).toBeNull();
    expect(parseWallMessage({ t: "rtc", link: "up:s1", kind: "offer", sdp: "v=0" })).toEqual({ t: "rtc", link: "up:s1", kind: "offer", sdp: "v=0" });
    expect(parseWallMessage({ t: "rtc", link: "sideways:s1", kind: "offer", sdp: "v=0" })).toBeNull();
    expect(parseWallMessage({ t: "rtc", link: "down:s1", kind: "ice", candidate: { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 } })?.t).toBe("rtc");
    expect(parseWallMessage({ t: "kick", reason: "agents-off" })).toEqual({ t: "kick", reason: "agents-off" });
    expect(parseWallMessage({ t: "members", members: [{ label: "host", name: "H" }, { label: "x" }] })).toBeNull();
    expect(parseWallMessage({ t: "live", streams: [{ sid: "s1", by: "peer:1", kind: "camera" }] })?.t).toBe("live");
    expect(parseWallMessage({ t: "welcome", label: "peer:3", expiresAt: 5, burn: false, hostLeave: true, agents: false, media: true })?.t).toBe("welcome");
    expect(parseWallMessage({ t: "welcome", label: "Hôte", expiresAt: 5, burn: false, hostLeave: true, agents: false, media: true })).toBeNull();
  });
});

describe("Sharewall host feed (authoritative, in memory)", () => {
  const make = async (allowAgents = false) => {
    const params = await createWall({ ttl: "h1", password: false, burn: false, hostLeave: true });
    const events: string[] = [];
    const host = new WallHost(params, () => undefined, { name: "Hôte Jade", allowAgents });
    host.on((e) => events.push(e.type));
    return { host, events };
  };

  it("posts messages with mentions, replies, reactions, polls, pins and removal", async () => {
    const { host, events } = await make();
    host.say("Bonjour @Hôte Jade");
    const m = host.state.posts[0]!;
    expect(m.mentions).toEqual(["host"]);
    host.say("réponse", m.id);
    expect(host.state.posts[1]!.replyTo).toBe(m.id);
    host.say("réponse fantôme", "nope");
    expect(host.state.posts[2]!.replyTo).toBeUndefined();
    host.react(m.id, "🎉");
    expect(host.state.posts[0]!.reactions).toEqual({ "🎉": ["host"] });
    host.createPoll("Q ?", ["a", "b"]);
    const q = host.state.posts.find((p) => p.kind === "poll")!;
    host.vote(q.id, 1);
    host.closePoll(q.id);
    const closed = host.state.posts.find((p) => p.id === q.id)!;
    expect(closed.poll).toMatchObject({ closed: true, votes: [[], ["host"]] });
    host.pin(m.id);
    expect(host.state.pinned).toBe(m.id);
    host.removeItem(m.id);
    expect(host.state.pinned).toBeNull();
    expect(host.state.posts.some((p) => p.id === m.id)).toBe(false);
    host.setHand(true);
    expect(host.state.members[0]).toMatchObject({ hand: true, host: true, name: "Hôte Jade" });
    host.rename("  ");
    expect(host.state.members[0]!.name).toBe("Hôte Jade");
    expect(events).toEqual(expect.arrayContaining(["post", "pin", "unpost", "members"]));
    host.stop();
  });

  it("adds files and notes as feed items and caps the feed", async () => {
    const { host } = await make();
    expect(host.addBlob("a.png", "image/png", new Blob([new Uint8Array(10)]))).toBeNull();
    expect(host.addText("secret")).toBeNull();
    expect(host.state.posts.map((p) => p.kind)).toEqual(["file", "note"]);
    for (let i = 0; i < MAX_POSTS + 5; i++) host.say(`m${i}`);
    expect(host.state.posts).toHaveLength(MAX_POSTS);
    expect(host.state.posts.slice(0, 2).map((p) => p.kind)).toEqual(["file", "note"]); // items are never trimmed
    host.stop();
  });

  it("toggles the AI agents setting (off by default)", async () => {
    const { host } = await make();
    expect(host.state.agents).toBe(false);
    host.setAgentsAllowed(true);
    expect(host.state.agents).toBe(true);
    host.stop();
    expect(host.state.posts).toEqual([]);
  });
});

describe("Sharewall AI agents wording (honest, no overclaim)", () => {
  const w = (loc: Record<string, any>) => JSON.stringify(loc.wall).toLowerCase();
  it("tells that what an agent reads goes to its model provider, and that the badge is self-declared", () => {
    expect(w(fr)).toContain("fournisseur de son modèle");
    expect(w(fr)).toContain("auto-déclaré");
    expect(w(en)).toContain("model provider");
    expect(w(en)).toContain("self-declared");
    for (const loc of [fr, en] as Array<Record<string, any>>) {
      expect(loc.wall.agents.present_one).toBeTruthy();
      expect(loc.wall.agents.enableConfirm).toBeTruthy();
      for (const banned of ["verified agent", "agent vérifié", "agents are safe", "sans risque", "risk-free", "first ever", "premier au monde", "world's first", "revolutionary", "révolutionnaire"]) {
        expect(w(loc), banned).not.toContain(banned);
      }
    }
  });
});
