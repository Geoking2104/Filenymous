// Relay tests for Dropzone signaling: node --test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";

const PORT = 19500 + Math.floor(Math.random() * 400);
const URL = `ws://127.0.0.1:${PORT}`;
let relay;

before(async () => {
  relay = spawn(process.execPath, [new globalThis.URL("./server.js", import.meta.url).pathname], {
    env: { ...process.env, PORT: String(PORT), DROP_SWEEP_MS: "100", RATE_LIMIT_MAX_MESSAGES: "1000" },
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

const ownerSecret = s => s.padEnd(32, "x");
const dropIdOf = secret => `drop-${createHash("sha256").update(secret).digest("hex").slice(0, 24)}`;
const sdp = { kind: "offer", sdp: "v=0" };

test("owner role requires the owner secret", async () => {
  const s = ownerSecret("a");
  const c = client(); await c.open();
  c.send({ type: "drop-join", dropId: dropIdOf(s), role: "owner", ownerSecret: ownerSecret("b") });
  assert.equal((await c.next(m => m.type === "error")).error, "drop-owner-denied");
  c.send({ type: "drop-join", dropId: dropIdOf(s), role: "owner", ownerSecret: s });
  assert.equal((await c.next(m => m.type === "drop-joined")).role, "owner");
  c.close();
});

test("contributor sees owner offline/online, signals are routed, contributors are isolated", async () => {
  const s = ownerSecret("route");
  const dropId = dropIdOf(s);
  const c1 = client(); await c1.open();
  c1.send({ type: "drop-join", dropId, role: "contributor", peerId: "c1-peer" });
  assert.equal((await c1.next(m => m.type === "drop-joined")).ownerOnline, false);
  c1.send({ type: "drop-signal", payload: sdp });
  await c1.next(m => m.type === "drop-owner-offline");

  const owner = client(); await owner.open();
  owner.send({ type: "drop-join", dropId, role: "owner", ownerSecret: s, expiresAt: Date.now() + 60_000 });
  const joined = await owner.next(m => m.type === "drop-joined");
  assert.deepEqual(joined.contributors, ["c1-peer"]);
  await c1.next(m => m.type === "drop-owner-online");

  const c2 = client(); await c2.open();
  c2.send({ type: "drop-join", dropId, role: "contributor", peerId: "c2-peer" });
  assert.equal((await c2.next(m => m.type === "drop-joined")).ownerOnline, true);
  assert.equal((await owner.next(m => m.type === "drop-peer-joined")).peerId, "c2-peer");

  c2.send({ type: "drop-signal", payload: sdp });
  const got = await owner.next(m => m.type === "drop-signal");
  assert.equal(got.from, "c2-peer");
  owner.send({ type: "drop-signal", to: "c2-peer", payload: { kind: "answer", sdp: "v=0" } });
  assert.equal((await c2.next(m => m.type === "drop-signal")).payload.kind, "answer");

  await new Promise(r => setTimeout(r, 150));
  assert.ok(!c1.inbox.some(m => JSON.stringify(m).includes("c2-peer")), "c1 must not learn about c2");

  owner.close();
  await c1.next(m => m.type === "drop-owner-offline");
  await c2.next(m => m.type === "drop-owner-offline");
  c1.close(); c2.close();
});

test("a new owner connection replaces the previous one (reload)", async () => {
  const s = ownerSecret("dup");
  const a = client(); await a.open();
  a.send({ type: "drop-join", dropId: dropIdOf(s), role: "owner", ownerSecret: s });
  await a.next(m => m.type === "drop-joined");
  const b = client(); await b.open();
  b.send({ type: "drop-join", dropId: dropIdOf(s), role: "owner", ownerSecret: s });
  await b.next(m => m.type === "drop-joined");
  assert.equal((await a.next(m => m.type === "error")).error, "drop-owner-replaced");
  a.close(); b.close();
});

test("drop room TTL: expired drops are closed and refuse joins", async () => {
  const s = ownerSecret("ttl");
  const dropId = dropIdOf(s);
  const owner = client(); await owner.open();
  owner.send({ type: "drop-join", dropId, role: "owner", ownerSecret: s, expiresAt: Date.now() + 300 });
  await owner.next(m => m.type === "drop-joined");
  const c = client(); await c.open();
  c.send({ type: "drop-join", dropId, role: "contributor", peerId: "late-peer" });
  await c.next(m => m.type === "drop-joined");
  await owner.next(m => m.type === "drop-expired", 3000);
  await c.next(m => m.type === "drop-expired", 3000);
  const past = client(); await past.open();
  past.send({ type: "drop-join", dropId, role: "owner", ownerSecret: s, expiresAt: Date.now() - 1 });
  assert.equal((await past.next(m => m.type === "error")).error, "drop-expired");
  owner.close(); c.close(); past.close();
});
