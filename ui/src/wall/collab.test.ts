// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Task } from "./collab";
import {
  BoardStore,
  SCOPE_DEFAULT,
  SCOPE_FULL,
  SCOPE_READ_ONLY,
  TaskBoard,
  boardBatches,
  cleanBoardElement,
  cleanScope,
  mergeScene,
  parseScopeArg,
  visibleTo,
  type BoardElement,
} from "./collab";
import { WallHost } from "./host";
import { createWall } from "./link";
import { parseWallMessage, type WallMessage } from "./model";
import { cleanMember } from "./feed";
import { buildSnapshot, buildTranscript, parseSnapshot } from "./snapshot";

const el = (id: string, version: number, extra: Record<string, unknown> = {}): BoardElement =>
  ({ id, type: "rectangle", version, versionNonce: 1, isDeleted: false, x: 0, y: 0, width: 10, height: 10, ...extra }) as BoardElement;

describe("agent scopes", () => {
  it("validates scopes and parses CLI values", () => {
    expect(cleanScope({ post: true, files: false, secrets: false, limited: true })).toEqual({ post: true, files: false, secrets: false, limited: true });
    expect(cleanScope({ post: "yes" })).toBeNull();
    expect(parseScopeArg("read-only")).toEqual(SCOPE_READ_ONLY);
    expect(parseScopeArg("post")).toEqual(SCOPE_DEFAULT);
    expect(parseScopeArg("full")).toEqual(SCOPE_FULL);
    expect(parseScopeArg("post,limited")).toEqual({ post: true, files: false, secrets: false, limited: true });
    expect(parseScopeArg("root")).toBeNull();
  });

  it("limited view: own posts, mentions, replies to it, owned tasks and the context pack only", () => {
    const s = { ...SCOPE_DEFAULT, limited: true };
    const pack = new Set(["m-shared"]);
    const byOf = (id: string) => (id === "m-mine" ? "peer:2" : "host");
    expect(visibleTo("peer:2", s, pack, { id: "m1", by: "host" }, byOf)).toBe(false);
    expect(visibleTo("peer:2", s, pack, { id: "m-mine", by: "peer:2" }, byOf)).toBe(true);
    expect(visibleTo("peer:2", s, pack, { id: "m2", by: "host", mentions: ["peer:2"] }, byOf)).toBe(true);
    expect(visibleTo("peer:2", s, pack, { id: "m3", by: "host", replyTo: "m-mine" }, byOf)).toBe(true);
    expect(visibleTo("peer:2", s, pack, { id: "t-0123456789abcdef", by: "host", owner: "peer:2" }, byOf)).toBe(true);
    expect(visibleTo("peer:2", s, pack, { id: "m-shared", by: "host" }, byOf)).toBe(true);
    expect(visibleTo("peer:2", SCOPE_DEFAULT, pack, { id: "m1", by: "host" }, byOf)).toBe(true);
  });

  it("members carry the scope only for agents", () => {
    expect(cleanMember({ label: "peer:1", name: "A", agent: true, scope: SCOPE_DEFAULT })?.scope).toEqual(SCOPE_DEFAULT);
    expect(cleanMember({ label: "peer:1", name: "A", agent: false, scope: SCOPE_DEFAULT })?.scope).toBeUndefined();
  });
});

describe("tasks & decisions", () => {
  it("anyone ticks or assigns; only author or host edits text / deletes; decisions are never 'done'", () => {
    const b = new TaskBoard();
    const t = b.create("peer:1", "task", "  Écrire le rapport ", null);
    if (typeof t === "string") throw new Error(t);
    expect(t.text).toBe("Écrire le rapport");
    expect(b.update("peer:2", t.id, { done: true, owner: "peer:2" })).toMatchObject({ done: true, owner: "peer:2", editedBy: "peer:2" });
    expect(b.update("peer:2", t.id, { text: "x" })).toBe("forbidden");
    expect(b.update("host", t.id, { text: "Rapport v2" })).toMatchObject({ text: "Rapport v2" });
    expect(b.remove("peer:2", t.id)).toBe("forbidden");
    const d = b.create("peer:2", "decision", "On garde WebRTC", "peer:1");
    if (typeof d === "string") throw new Error(d);
    expect(d.owner).toBeNull();
    expect(b.update("peer:1", d.id, { done: true })).toMatchObject({ done: false });
    expect(b.list().map((x) => x.kind)).toEqual(["task", "decision"]);
    expect(b.remove("host", t.id)).toBe(true);
    expect(b.create("peer:1", "task", "   ", null)).toBe("empty");
  });

  it("parses task messages strictly", () => {
    expect(parseWallMessage({ t: "task-new", kind: "task", text: "a", owner: "peer:3" })).toEqual({ t: "task-new", kind: "task", text: "a", owner: "peer:3" });
    expect(parseWallMessage({ t: "task-new", kind: "chore", text: "a", owner: null })).toBeNull();
    expect(parseWallMessage({ t: "task-set", id: "t-0123456789abcdef" })).toBeNull();
    expect(parseWallMessage({ t: "task-set", id: "t-0123456789abcdef", owner: "evil" })).toBeNull();
    expect(parseWallMessage({ t: "task-set", id: "t-0123456789abcdef", done: true })).toEqual({ t: "task-set", id: "t-0123456789abcdef", done: true });
  });
});

describe("whiteboard", () => {
  it("sanitizes elements: no images, http(s) links only, no unknown types", () => {
    expect(cleanBoardElement({ ...el("a", 1), type: "image", fileId: "x" })).toBeNull();
    expect(cleanBoardElement({ ...el("a", 1), type: "script" })).toBeNull();
    expect(cleanBoardElement({ ...el("a", 1), link: "javascript:alert(1)" })?.link).toBeNull();
    expect(cleanBoardElement({ ...el("a", 1), link: "https://filenymous.eu" })?.link).toBe("https://filenymous.eu");
    expect(cleanBoardElement({ ...el("a", 1), customData: { x: 1 } })).not.toHaveProperty("customData");
    expect(cleanBoardElement({ ...el("a", 1), points: Array.from({ length: 30_000 }, () => [1, 2]) })).toBeNull();
    expect(cleanBoardElement({ ...el("a b", 1) })).toBeNull();
  });

  it("merges by version (ties: lower versionNonce wins) and caps the scene", () => {
    const b = new BoardStore();
    expect(b.merge([el("a", 2)])).toHaveLength(1);
    expect(b.merge([el("a", 1)])).toHaveLength(0);
    expect(b.merge([{ ...el("a", 2), versionNonce: 0 }])).toHaveLength(1);
    expect(b.merge([{ ...el("a", 2), versionNonce: 5 }])).toHaveLength(0);
    const local = [el("a", 3), el("b", 1)];
    expect(mergeScene(local, [el("a", 2)])).toBe(local);
    expect(mergeScene(local, [el("b", 4, { x: 9 })]).find((e) => e.id === "b")?.x).toBe(9);
  });

  it("splits relayed elements into small batches", () => {
    const big = Array.from({ length: 50 }, (_, i) => el(`e${i}`, 1, { text: "x".repeat(3000) }));
    const batches = boardBatches(big, 20_000);
    expect(batches.length).toBeGreaterThan(5);
    expect(batches.flat()).toHaveLength(50);
    for (const b of batches) expect(JSON.stringify(b).length).toBeLessThan(25_000);
  });
});

// ---- host enforcement, with fake sealed channels ----------------------------

type FakePeer = Record<string, unknown> & { sent: WallMessage[] };

async function makeHost(opts: ConstructorParameters<typeof WallHost>[2] = {}) {
  const params = await createWall({ ttl: "h1", password: false, burn: false, hostLeave: true });
  const host = new WallHost(params, () => undefined, { name: "H", allowAgents: true, ...opts });
  const h = host as unknown as {
    peers: Map<string, FakePeer>;
    admit(id: string, p: FakePeer, m: WallMessage): void;
    onPeerMessage(id: string, p: FakePeer, m: WallMessage): Promise<void>;
  };
  let n = 0;
  const join = (name: string, agent: boolean, feat = 2) => {
    const id = `id${++n}`;
    const sent: WallMessage[] = [];
    const peer: FakePeer = {
      sent,
      pc: { close() {} },
      pendingIce: [],
      uploads: new Map(),
      out: Promise.resolve(),
      lastTyping: 0,
      down: new Map(),
      feat: 1,
      seen: new Set(),
      label: `peer:${n}`,
      channel: { readyState: "open", send() {}, bufferedAmount: 0, bufferedAmountLowThreshold: 0, addEventListener() {}, removeEventListener() {} },
      pipe: { sealControl: async (m: WallMessage) => (sent.push(m), new ArrayBuffer(0)), sealData: async () => new ArrayBuffer(0) },
    };
    h.peers.set(id, peer);
    h.admit(id, peer, parseWallMessage({ t: "profile", name, agent, media: false, ...(feat > 1 ? { feat } : {}) })!);
    const send = (m: unknown) => h.onPeerMessage(id, peer, parseWallMessage(m)!);
    return { id, peer, sent, label: peer.label as string, send };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { host, join, flush };
}

describe("WallHost: agent approval, scopes, context pack", () => {
  it("an agent waits for approval and sees nothing until the host accepts it with a scope", async () => {
    const { host, join, flush } = await makeHost();
    host.say("secret plan");
    const a = join("Bot", true);
    await flush();
    expect(host.state.pendingAgents).toEqual([{ label: a.label, name: "Bot" }]);
    expect(a.sent.map((m) => m.t)).toEqual(["welcome"]);
    expect((a.sent[0] as { pending?: boolean }).pending).toBe(true);
    expect(host.state.members.some((m) => m.label === a.label)).toBe(false);
    await a.send({ t: "say", text: "hello?" });
    expect(host.state.posts).toHaveLength(1);
    host.approveAgent(a.label, { ...SCOPE_READ_ONLY });
    await flush();
    expect(host.state.pendingAgents).toEqual([]);
    expect(host.state.members.find((m) => m.label === a.label)?.scope).toEqual(SCOPE_READ_ONLY);
    expect(a.sent.some((m) => m.t === "post")).toBe(true);
    // Read-only: posting is refused and the agent is told why.
    await a.send({ t: "say", text: "I should not post" });
    await flush();
    expect(host.state.posts).toHaveLength(1);
    expect(a.sent.some((m) => m.t === "notice" && m.code === "scope-denied")).toBe(true);
  });

  it("files / secrets scopes gate explicit fetches; the context pack grants a single item", async () => {
    const { host, join, flush } = await makeHost();
    host.addText("API_KEY=sk-test", "key");
    host.addBlob("r.txt", "text/plain", new Blob(["report"]));
    const [secret, file] = host.state.posts;
    const a = join("Bot", true);
    host.approveAgent(a.label, { ...SCOPE_DEFAULT });
    await flush();
    await a.send({ t: "get", rid: 1, id: secret!.id });
    await a.send({ t: "get", rid: 2, id: file!.id });
    await flush();
    const fails = a.sent.filter((m) => m.t === "get-fail") as Array<{ rid: number; reason: string }>;
    expect(fails.map((f) => [f.rid, f.reason])).toEqual([[1, "denied"], [2, "denied"]]);
    host.shareWithAgent(a.label, file!.id, true);
    await a.send({ t: "get", rid: 3, id: file!.id });
    await flush();
    expect(a.sent.some((m) => m.t === "get-begin" && m.rid === 3)).toBe(true);
    host.setAgentScope(a.label, { ...SCOPE_FULL });
    await a.send({ t: "get", rid: 4, id: secret!.id });
    await flush();
    expect(a.sent.some((m) => m.t === "get-begin" && m.rid === 4)).toBe(true);
  });

  it("limited view filters the replay and live posts, and retracts what leaves the view", async () => {
    const { host, join, flush } = await makeHost();
    host.say("before: not for the bot");
    const a = join("Bot", true);
    host.approveAgent(a.label, { ...SCOPE_DEFAULT, limited: true });
    await flush();
    const posts = () => a.sent.filter((m) => m.t === "post").map((m) => (m as { post: { text?: string } }).post.text);
    expect(posts()).toEqual([]);
    host.say("public chatter");
    host.say("@Bot please summarize");
    await flush();
    expect(posts()).toEqual(["@Bot please summarize"]);
    const hidden = host.state.posts.find((p) => p.text === "public chatter")!;
    host.shareWithAgent(a.label, hidden.id, true);
    await flush();
    expect(posts()).toContain("public chatter");
    host.shareWithAgent(a.label, hidden.id, false);
    await flush();
    expect(a.sent.some((m) => m.t === "unpost" && m.id === hidden.id)).toBe(true);
    // Reacting to an entry outside its view is refused.
    await a.send({ t: "react", id: hidden.id, emoji: "👍" });
    await flush();
    expect(host.state.posts.find((p) => p.id === hidden.id)?.reactions).toEqual({});
    // Its own tasks are visible; others' are not.
    host.addTask("task", "for the bot", a.label);
    host.addTask("task", "for a human", null);
    await flush();
    const tasks = a.sent.filter((m) => m.t === "task").map((m) => (m as { task: { text: string } }).task.text);
    expect(tasks).toEqual(["for the bot"]);
  });

  it("tasks and board go only to peers that understand them; agents never get the board", async () => {
    const { host, join, flush } = await makeHost();
    const old = join("Old tab", false, 1);
    const human = join("Human", false);
    const bot = join("Bot", true);
    host.approveAgent(bot.label, { ...SCOPE_FULL });
    await flush();
    host.addTask("decision", "Ship it", null);
    host.boardOp([el("r1", 1)]);
    await human.send({ t: "board-op", els: [el("r2", 1), { id: "x", type: "image", version: 1, versionNonce: 1, isDeleted: false }] });
    await bot.send({ t: "board-op", els: [el("r3", 1)] });
    await flush();
    expect(old.sent.some((m) => m.t === "task" || m.t === "board")).toBe(false);
    expect(human.sent.some((m) => m.t === "task")).toBe(true);
    expect(human.sent.filter((m) => m.t === "board").flatMap((m) => (m as { els: BoardElement[] }).els.map((e) => e.id))).toEqual(["r1"]);
    expect(bot.sent.some((m) => m.t === "board")).toBe(false);
    expect(bot.sent.some((m) => m.t === "task")).toBe(true);
    expect(host.boardElements().map((e) => e.id).sort()).toEqual(["r1", "r2"]);
    // A late joiner gets the whole scene.
    const late = join("Late", false);
    await flush();
    expect(late.sent.filter((m) => m.t === "board").flatMap((m) => (m as { els: BoardElement[] }).els).length).toBe(2);
  });

  it("CLI hosts can auto-approve agents with a chosen scope; Nuke wipes tasks and board", async () => {
    const { host, join, flush } = await makeHost({ autoApproveAgents: true, agentScope: { ...SCOPE_READ_ONLY } });
    const a = join("Bot", true);
    await flush();
    expect(host.state.members.find((m) => m.label === a.label)?.scope).toEqual(SCOPE_READ_ONLY);
    host.addTask("task", "t", null);
    host.boardOp([el("r1", 1)]);
    await host.destroy("destroyed");
    expect(host.state.tasks).toEqual([]);
    expect(host.boardElements()).toEqual([]);
  });
});

describe("export", () => {
  it("snapshot and transcript include tasks, decisions and the board; parseSnapshot validates them", async () => {
    const b = new TaskBoard();
    const t1 = b.create("host", "task", "Relire", "peer:1") as never;
    const d1 = b.create("peer:1", "decision", "Go", null) as never;
    const snap = await buildSnapshot({ burn: false, members: [{ label: "host", name: "H", agent: false, host: true, hand: false, media: false }, { label: "peer:1", name: "Alice", agent: false, host: false, hand: false, media: false }], posts: [], tasks: [t1, d1], board: [el("r1", 1), el("gone", 2, { isDeleted: true })], getItem: () => null });
    expect(snap.tasks).toHaveLength(2);
    expect(snap.board?.map((e) => e.id)).toEqual(["r1"]);
    const md = buildTranscript(snap, "en");
    expect(md).toContain("- [ ] Relire — Alice");
    expect(md).toContain("1. Go — Alice");
    const back = parseSnapshot(JSON.stringify(snap));
    expect(back?.tasks).toHaveLength(2);
    expect(back?.board).toHaveLength(1);
    expect(parseSnapshot(JSON.stringify({ ...snap, board: [{ id: "x", type: "image", version: 1, versionNonce: 1, isDeleted: false }] }))).toBeNull();
  });
});

describe("delegated task states (A2A-style)", () => {
  it("lets only host, author or owner move the state; completed ticks done", () => {
    const b = new TaskBoard();
    const t = b.create("a1", "task", "summarise the PDF", "b2", 1, "submitted") as Task;
    expect(t.state).toBe("submitted");
    expect(b.update("c3", t.id, { state: "working" })).toBe("forbidden");
    const w = b.update("b2", t.id, { state: "working", note: "on it" }) as Task;
    expect(w.state).toBe("working");
    expect(w.note).toBe("on it");
    const d = b.update("b2", t.id, { state: "completed", result: "post_1" }) as Task;
    expect(d.done).toBe(true);
    expect(d.result).toBe("post_1");
    expect(b.update("a1", t.id, { state: "bogus" as never })).toBe("empty");
  });
  it("drops a stale progress note when the task reaches a terminal state", () => {
    const b = new TaskBoard();
    const t = b.create("a1", "task", "do it", "b2", 1, "submitted") as Task;
    expect((b.update("b2", t.id, { state: "working", note: "on it" }) as Task).note).toBe("on it");
    const done = b.update("b2", t.id, { state: "completed" }) as Task;
    expect(done.done).toBe(true);
    expect(done.note).toBeUndefined();
    const t2 = b.create("a1", "task", "other", "b2", 2, "submitted") as Task;
    expect((b.update("b2", t2.id, { state: "failed", note: "network down" }) as Task).note).toBe("network down");
  });

  it("parses task-set with state/note/result and rejects bad values", () => {
    expect(parseWallMessage({ t: "task-set", id: "t-0123456789abcdef", state: "working", note: "x" })).toMatchObject({ state: "working", note: "x" });
    expect(parseWallMessage({ t: "task-set", id: "t-0123456789abcdef", state: "nope" })).toBeNull();
    expect(parseWallMessage({ t: "task-new", kind: "task", text: "x", owner: null, state: "working" })).toBeNull();
    expect(parseWallMessage({ t: "welcome", label: "peer:1", expiresAt: 0, burn: false, hostLeave: false, agents: true, media: false, feat: 3 })).toMatchObject({ feat: 3 });
  });
});

describe("WallHost: scoped wall search", () => {
  const hits = (sent: WallMessage[], rid: number) => {
    const r = sent.find((m) => (m.t === "search-res" || m.t === "search-fail") && m.rid === rid) as { t: string; hits?: Array<{ snippet: string; kind: string }>; reason?: string };
    return r;
  };
  it("limited agents search only their view; the search scope widens it; secrets stay masked", async () => {
    const { host, join, flush } = await makeHost();
    host.say("budget deadline is friday");
    host.addText("deadline token sk-xyz", "deadline key");
    const a = join("Bot", true, 4);
    host.approveAgent(a.label, { ...SCOPE_DEFAULT, limited: true });
    await flush();
    await a.send({ t: "search", rid: 1, q: "deadline" });
    await flush();
    expect(hits(a.sent, 1).hits).toEqual([]);
    host.setAgentScope(a.label, { ...SCOPE_DEFAULT, limited: true, search: true });
    await a.send({ t: "search", rid: 2, q: "deadline" });
    await flush();
    const r = hits(a.sent, 2);
    expect(r.hits!.map((h) => h.snippet).join(" ")).toContain("friday");
    expect(JSON.stringify(r)).not.toContain("sk-xyz");
    expect(a.sent.some((m) => m.t === "post" && (m as { post: { text?: string } }).post.text?.includes("friday"))).toBe(false);
  });
  it("rate-limits searches", async () => {
    const { host, join, flush } = await makeHost();
    const a = join("Bot", true, 4);
    host.approveAgent(a.label, { ...SCOPE_DEFAULT });
    await flush();
    for (let i = 1; i <= 8; i++) await a.send({ t: "search", rid: i, q: "x y" });
    await flush();
    expect(a.sent.some((m) => m.t === "search-fail" && m.reason === "rate-limited")).toBe(true);
  });
});

describe("WallHost: private agent threads", () => {
  it("host approves, routes only to the two agents, sees everything and can close", async () => {
    const { host, join, flush } = await makeHost();
    const a = join("A", true, 4);
    const b = join("B", true, 4);
    const h = join("Human", false, 4);
    const old = join("Old", true, 2);
    for (const x of [a, b, old]) host.approveAgent(x.label, { ...SCOPE_DEFAULT });
    await flush();
    await a.send({ t: "thread-open", to: old.label, goal: "x" });
    await flush();
    expect(a.sent.some((m) => m.t === "notice" && m.code === "thread-denied")).toBe(true);
    await a.send({ t: "thread-open", to: b.label, goal: "Agree on a plan" });
    await flush();
    const th = host.state.threads[0]!;
    expect(th).toMatchObject({ a: a.label, b: b.label, state: "pending", goal: "Agree on a plan" });
    await a.send({ t: "thread-say", id: th.id, text: "too early" });
    await flush();
    expect(host.state.threadMsgs[th.id]).toEqual([]);
    host.approveThread(th.id);
    await a.send({ t: "thread-say", id: th.id, text: "I take part 1" });
    await b.send({ t: "thread-say", id: th.id, text: "ok, part 2 for me" });
    await flush();
    expect(host.state.threadMsgs[th.id]!.map((m) => m.text)).toEqual(["I take part 1", "ok, part 2 for me"]);
    for (const x of [a, b]) expect(x.sent.filter((m) => m.t === "thread-msg")).toHaveLength(2);
    expect(h.sent.some((m) => m.t.startsWith("thread"))).toBe(false);
    expect(old.sent.some((m) => m.t.startsWith("thread"))).toBe(false);
    expect(host.state.posts).toHaveLength(0);
    // A third party cannot write into it.
    await h.send({ t: "thread-say", id: th.id, text: "hi" });
    await flush();
    expect(host.state.threadMsgs[th.id]).toHaveLength(2);
    host.closeThread(th.id);
    await flush();
    expect(host.state.threads[0]!.state).toBe("closed");
    await a.send({ t: "thread-say", id: th.id, text: "after close" });
    await flush();
    expect(host.state.threadMsgs[th.id]).toHaveLength(2);
  });
  it("parses thread messages strictly", () => {
    expect(parseWallMessage({ t: "thread-open", to: "evil" })).toBeNull();
    expect(parseWallMessage({ t: "thread-say", id: "th-0123456789abcdef", text: "  " })).toBeNull();
    expect(parseWallMessage({ t: "thread-close", id: "nope" })).toBeNull();
    expect(parseWallMessage({ t: "thread-open", to: "peer:2", goal: "g" })).toEqual({ t: "thread-open", to: "peer:2", goal: "g" });
  });
});
