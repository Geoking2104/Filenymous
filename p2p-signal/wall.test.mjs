// Relay tests for Sharewall signaling: node --test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";

const PORT = 19950 + Math.floor(Math.random() * 400);
const URL = `ws://127.0.0.1:${PORT}/wall`;
let relay;

before(async () => {
  relay = spawn(process.execPath, [new globalThis.URL("./server.js", import.meta.url).pathname], {
    env: { ...process.env, PORT: String(PORT), WALL_SWEEP_MS: "100", WALL_HOST_GRACE_MS: "300", WALL_ORPHAN_MS: "1500", RATE_LIMIT_MAX_MESSAGES: "1000" },
    stdio: "pipe",
  });
  await new Promise((ok, ko) => {
    const t = setTimeout(() => ko(new Error("relay did not start")), 10_000);
    relay.stdout.on("data", d => { if (String(d).includes("listening")) { clearTimeout(t); ok(); } });
  });
});
after(() => relay?.kill());

function client() {
  const ws = new WebSocket(URL);
  const inbox = [];
  const waiters = [];
  ws.on("message", raw => {
    const msg = JSON.parse(String(raw));
    const i = waiters.findIndex(w => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].ok(msg);
    else inbox.push(msg);
  });
  const api = {
    ws,
    inbox,
    open: () => new Promise(ok => ws.once("open", ok)),
    send: m => ws.send(JSON.stringify(m)),
    next(pred, ms = 2000) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((ok, ko) => {
        const w = { pred, ok: m => { clearTimeout(t); ok(m); } };
        const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); ko(new Error("timeout")); }, ms);
        waiters.push(w);
      });
    },
    close: () => ws.close(),
  };
  return api;
}

const hostSecret = s => s.padEnd(32, "x");
const wallIdOf = secret => `wall-${createHash("sha256").update(secret).digest("hex").slice(0, 24)}`;
const sdp = { kind: "offer", sdp: "v=0" };


const soon = (ms = 60_000) => Date.now() + ms;
const isErr = e => m => m.type === "error" && m.error === e;

async function host(secret, extra = {}) {
  const c = client(); await c.open();
  c.send({ type: "wall-join", wallId: wallIdOf(secret), role: "host", hostSecret: secret, expiresAt: soon(), ...extra });
  const joined = await c.next(m => m.type === "wall-joined" || m.type === "error");
  return { c, joined };
}
async function peer(wallId, peerId) {
  const c = client(); await c.open();
  c.send({ type: "wall-join", wallId, role: "peer", peerId });
  const joined = await c.next(m => m.type === "wall-joined" || m.type === "error");
  return { c, joined };
}

test("host role requires the host secret; extra fields (e.g. a key) are refused", async () => {
  const s = hostSecret("h1");
  const c = client(); await c.open();
  c.send({ type: "wall-join", wallId: wallIdOf(s), role: "host", hostSecret: hostSecret("other"), expiresAt: soon() });
  await c.next(isErr("wall-host-denied"));
  c.send({ type: "wall-join", wallId: wallIdOf(s), role: "host", hostSecret: s, expiresAt: soon(), key: "must-not-be-sent" });
  await c.next(isErr("invalid-wall"));
  c.send({ type: "wall-join", wallId: wallIdOf(s), role: "peer", peerId: "p-abc", name: "Alice" });
  await c.next(isErr("invalid-wall"));
  c.close();
});

test("star routing: peers reach the host only, and never see each other", async () => {
  const s = hostSecret("h2");
  const h = await host(s, { destroyOnHostLeave: false });
  assert.equal(h.joined.type, "wall-joined");
  const a = await peer(wallIdOf(s), "p-aaa");
  assert.equal(a.joined.hostOnline, true);
  assert.equal((await h.c.next(m => m.type === "wall-peer-joined")).peerId, "p-aaa");
  const b = await peer(wallIdOf(s), "p-bbb");
  await h.c.next(m => m.type === "wall-peer-joined" && m.peerId === "p-bbb");
  a.c.send({ type: "wall-signal", payload: sdp });
  const got = await h.c.next(m => m.type === "wall-signal");
  assert.deepEqual(got, { type: "wall-signal", from: "p-aaa", payload: sdp });
  h.c.send({ type: "wall-signal", to: "p-bbb", payload: { kind: "answer", sdp: "v=0" } });
  const toB = await b.c.next(m => m.type === "wall-signal");
  assert.equal(toB.from, undefined);
  await assert.rejects(a.c.next(m => m.type === "wall-signal", 300));
  assert.equal(a.c.inbox.some(m => m.type === "wall-peer-joined"), false);
  // Signals carry only SDP/ICE: anything else is refused.
  a.c.send({ type: "wall-signal", payload: { kind: "data", blob: "x" } });
  await a.c.next(isErr("unsupported-signal-payload"));
  for (const x of [h, a, b]) x.c.close();
});

test("kill switch: only the host closes the wall; peers are told; the wall can't be revived", async () => {
  const s = hostSecret("h3");
  const h = await host(s);
  const a = await peer(wallIdOf(s), "p-ccc");
  a.c.send({ type: "wall-close" });
  await a.c.next(isErr("not-wall-host"));
  h.c.send({ type: "wall-close" });
  assert.equal((await a.c.next(m => m.type === "wall-closed")).reason, "destroyed");
  assert.equal((await h.c.next(m => m.type === "wall-closed")).reason, "destroyed");
  const again = await host(s);
  assert.equal(again.joined.error, "wall-closed");
  const late = await peer(wallIdOf(s), "p-ddd");
  assert.equal(late.joined.error, "wall-closed");
  for (const x of [h, a, again, late]) x.c.close();
});

test("destroy when the host disconnects (after a short grace); otherwise peers just see it offline", async () => {
  const s1 = hostSecret("h4");
  const h1 = await host(s1, { destroyOnHostLeave: true });
  const a = await peer(wallIdOf(s1), "p-eee");
  h1.c.close();
  await a.c.next(m => m.type === "wall-host-offline");
  assert.equal((await a.c.next(m => m.type === "wall-closed", 3000)).reason, "host-left");

  const s2 = hostSecret("h5");
  const h2 = await host(s2, { destroyOnHostLeave: false });
  const b = await peer(wallIdOf(s2), "p-fff");
  h2.c.close();
  await b.c.next(m => m.type === "wall-host-offline");
  await assert.rejects(b.c.next(m => m.type === "wall-closed", 800));
  const h2b = await host(s2);
  assert.equal(h2b.joined.type, "wall-joined");
  await b.c.next(m => m.type === "wall-host-online");
  for (const x of [a, b, h2b]) x.c.close();
});

test("a host reconnecting within the grace keeps the wall", async () => {
  const s = hostSecret("h6");
  const h = await host(s, { destroyOnHostLeave: true });
  const a = await peer(wallIdOf(s), "p-ggg");
  h.c.close();
  await a.c.next(m => m.type === "wall-host-offline");
  const back = await host(s, { destroyOnHostLeave: true });
  assert.equal(back.joined.type, "wall-joined");
  await a.c.next(m => m.type === "wall-host-online");
  await assert.rejects(a.c.next(m => m.type === "wall-closed", 700));
  for (const x of [a, back]) x.c.close();
});

test("expiry is enforced by the relay, capped at 24 h, and can't be extended by the host", async () => {
  const s = hostSecret("h7");
  const h = await host(s, { expiresAt: Date.now() + 400 });
  const a = await peer(wallIdOf(s), "p-hhh");
  assert.equal((await a.c.next(m => m.type === "wall-closed", 3000)).reason, "expired");
  await h.c.next(m => m.type === "wall-closed");
  const s2 = hostSecret("h8");
  const h2 = await host(s2, { expiresAt: Date.now() + 30 * 24 * 3600 * 1000 });
  assert.ok(h2.joined.expiresAt <= Date.now() + 24 * 3600 * 1000 + 61_000);
  const h2b = await host(s2, { expiresAt: Date.now() + 25 * 24 * 3600 * 1000 });
  assert.ok(h2b.joined.expiresAt <= h2.joined.expiresAt);
  for (const x of [h, a, h2, h2b]) x.c.close();
});

test("no-expiry walls: expiresAt may be omitted; they live with the host and close when it leaves", async () => {
  const s = hostSecret("n1");
  const h = await host(s, { expiresAt: undefined, destroyOnHostLeave: true });
  assert.equal(h.joined.type, "wall-joined");
  assert.equal(h.joined.expiresAt, 0);
  const a = await peer(wallIdOf(s), "p-nnn");
  await assert.rejects(a.c.next(m => m.type === "wall-closed", 600));
  h.c.close();
  assert.equal((await a.c.next(m => m.type === "wall-closed", 3000)).reason, "host-left");
  const again = await host(s, { expiresAt: undefined });
  assert.equal(again.joined.type, "error");
  assert.equal(again.joined.error, "wall-closed");
  const bad = await host(hostSecret("n2"), { expiresAt: -5 });
  assert.equal(bad.joined.error, "wall-closed");
  for (const x of [a, again, bad]) x.c.close();
});

test("a no-expiry wall left without its host is closed after the orphan delay", async () => {
  const s = hostSecret("n3");
  const h = await host(s, { expiresAt: undefined, destroyOnHostLeave: false });
  const a = await peer(wallIdOf(s), "p-ooo");
  h.c.close();
  await a.c.next(m => m.type === "wall-host-offline");
  assert.equal((await a.c.next(m => m.type === "wall-closed", 4000)).reason, "host-left");
  a.c.close();
});

test("peer capacity is bounded", async () => {
  const s = hostSecret("h9");
  const h = await host(s);
  const peers = [];
  for (let i = 0; i < 8; i++) peers.push(await peer(wallIdOf(s), `p-cap${i}`));
  assert.ok(peers.every(p => p.joined.type === "wall-joined"));
  const extra = await peer(wallIdOf(s), "p-capx");
  assert.equal(extra.joined.error, "wall-full");
  for (const x of [h, extra, ...peers]) x.c.close();
});
