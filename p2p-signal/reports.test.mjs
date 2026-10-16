// "Canal de signalement" API tests: node --test (in-process, in-memory KV).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes, generateKeyPairSync } from "node:crypto";

process.env.REPORT_TTL_S = "2";
process.env.REPORT_MAX_BODY_BYTES = "50000";
process.env.REPORT_SUBMIT_PER_MIN = "5";
process.env.REPORT_MAX_THREAD = "3";
const { createReports, MemoryKV } = await import("./reports.js");
const { SECURITY_HEADERS } = await import("./vault.js");

const IP = "203.0.113.77";
const kv = new MemoryKV();
const logs = [];
for (const k of ["log", "error", "warn", "info"]) {
  const orig = console[k];
  console[k] = (...a) => { logs.push(a.join(" ")); orig(...a); };
}
// clientIp as in server.js with TRUST_PROXY=1: the forwarded address.
const api = createReports({ kv, securityHeaders: SECURITY_HEADERS, clientIp: req => req.headers["x-forwarded-for"] || req.socket.remoteAddress });
const srv = createServer((req, res) => {
  const path = req.url.split("?")[0];
  api.handle(req, res, path, {}).then(h => { if (!h) { res.writeHead(404); res.end(); } });
});
await new Promise(ok => srv.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${srv.address().port}/api/v1/reports`;
test.after(() => srv.close());

const b64 = n => randomBytes(n).toString("base64url");
const pub = () => generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
const rawPub = () => { const j = pub(); return Buffer.concat([Buffer.from([4]), Buffer.from(j.x, "base64url"), Buffer.from(j.y, "base64url")]).toString("base64url"); };
const hash = t => createHash("sha256").update(Buffer.from(t, "base64url")).digest("hex");
const post = (path, body, ip = IP) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip, "user-agent": "UA-SECRET-123" }, body: JSON.stringify(body) });
const sealed = (n = 64) => ({ epk: rawPub(), iv: b64(12), ct: b64(n) });

async function mailbox() {
  const admin = b64(32);
  const r = await post("/mailboxes", { v: 1, pub: rawPub(), admin: hash(admin) });
  assert.equal(r.status, 201);
  const { id } = await r.json();
  return { id, admin };
}
async function submit(mid, ip) {
  const token = b64(32), id = b64(16);
  const r = await post(`/mailboxes/${mid}/reports`, { v: 1, id, auth: hash(token), sealed: sealed() }, ip);
  return { r, id, token };
}

test("create mailbox, fetch its public key, submit, org lists/opens/replies/sets status, reporter follows up", async () => {
  const { id: mid, admin } = await mailbox();
  const g = await fetch(`${base}/mailboxes/${mid}`);
  assert.equal(g.status, 200);
  assert.equal(g.headers.get("cache-control"), "no-store");
  assert.match((await g.json()).pub, /^[A-Za-z0-9_-]{87}$/);
  const { r, id, token } = await submit(mid, "198.51.100.1");
  assert.equal(r.status, 201);
  assert.equal((await post(`/mailboxes/${mid}/list`, { token: b64(32) })).status, 403, "wrong admin token");
  const list = await (await post(`/mailboxes/${mid}/list`, { token: admin })).json();
  assert.deepEqual(list.reports.map(x => [x.id, x.status, x.messages]), [[id, "recu", 0]]);
  assert.equal(list.reports[0].createdAt % 3_600_000, 0, "timestamps rounded to the hour");
  const open = await (await post(`/mailboxes/${mid}/open`, { token: admin, id })).json();
  assert.ok(open.sealed.ct && !("auth" in open));
  assert.equal((await post(`/mailboxes/${mid}/reply`, { token: admin, id, msg: { iv: b64(12), ct: b64(40) } })).status, 201);
  assert.equal((await post(`/r/${id}/thread`, { token: b64(32) })).status, 403, "wrong follow-up key");
  assert.equal((await post(`/r/${b64(16)}/thread`, { token })).status, 403, "unknown id: same answer");
  let th = await (await post(`/r/${id}/thread`, { token })).json();
  assert.equal(th.status, "en-cours", "a reply moves the report to en cours");
  assert.equal(th.thread[0].from, "org");
  assert.equal((await post(`/r/${id}/followup`, { token, sealed: sealed() })).status, 201);
  assert.equal((await post(`/mailboxes/${mid}/status`, { token: admin, id, status: "clos" })).status, 200);
  assert.equal((await post(`/mailboxes/${mid}/status`, { token: admin, id, status: "deleted" })).status, 400);
  th = await (await post(`/r/${id}/thread`, { token })).json();
  assert.deepEqual([th.status, th.thread.map(m => m.from)], ["clos", ["org", "reporter"]]);
  // Another mailbox's admin can't open it.
  const other = await mailbox();
  assert.equal((await post(`/mailboxes/${other.id}/open`, { token: other.admin, id })).status, 404);
});

test("validation and limits", async () => {
  const { id: mid, admin } = await mailbox();
  assert.equal((await post("/mailboxes", { v: 1, pub: "x", admin: hash(b64(32)) })).status, 400);
  assert.equal((await post("/mailboxes", { v: 1, pub: rawPub(), admin: hash(b64(32)), ip: IP })).status, 400, "unknown fields refused");
  assert.equal((await fetch(`${base}/mailboxes/${b64(16)}`)).status, 404);
  const big = await post(`/mailboxes/${mid}/reports`, { v: 1, id: b64(16), auth: hash(b64(32)), sealed: sealed(60_000) }, "192.0.2.9");
  assert.equal(big.status, 413);
  const { r, id, token } = await submit(mid, "192.0.2.10");
  assert.equal(r.status, 201);
  for (let i = 0; i < 2; i++) assert.equal((await post(`/r/${id}/followup`, { token, sealed: sealed() })).status, 201);
  assert.equal((await post(`/mailboxes/${mid}/reply`, { token: admin, id, msg: { iv: b64(12), ct: b64(10) } })).status, 201);
  assert.equal((await post(`/r/${id}/followup`, { token, sealed: sealed() })).status, 507, "thread limit");
  const dup = await post(`/mailboxes/${mid}/reports`, { v: 1, id, auth: hash(b64(32)), sealed: sealed() }, "192.0.2.11");
  assert.equal(dup.status, 409, "an existing report id can't be overwritten");
  // Per-client submit rate limit (5/min here).
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await submit(mid, "192.0.2.50")).r.status);
  assert.deepEqual(codes.slice(0, 5), [201, 201, 201, 201, 201]);
  assert.equal(codes[6], 429);
});

test("reports expire after their TTL (90 days in production)", async () => {
  const { id: mid, admin } = await mailbox();
  const { id, token } = await submit(mid, "192.0.2.77");
  assert.equal((await post(`/r/${id}/thread`, { token })).status, 200);
  await new Promise(ok => setTimeout(ok, 2200));
  assert.equal((await post(`/r/${id}/thread`, { token })).status, 403);
  assert.deepEqual((await (await post(`/mailboxes/${mid}/list`, { token: admin })).json()).reports, []);
});

test("no IP address or User-Agent is stored or logged", async () => {
  const { id: mid } = await mailbox();
  await submit(mid, IP);
  const stored = kv.dump() + JSON.stringify([...api._buckets.keys()]);
  for (const bad of [IP, "198.51.100.1", "192.0.2.", "127.0.0.1", "UA-SECRET"]) assert.ok(!stored.includes(bad), `found ${bad}`);
  assert.ok(!logs.join("\n").match(/\d+\.\d+\.\d+\.\d+|UA-SECRET/), "no request data in logs");
});

test("the relay routes /api/v1/reports (and keeps the origin check)", async () => {
  const port = 25000 + Math.floor(Math.random() * 3000);
  const p = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], { env: { ...process.env, PORT: String(port), ALLOWED_ORIGIN: "https://filenymous.eu" }, stdio: "pipe" });
  try {
    await new Promise((ok, ko) => { const t = setTimeout(() => ko(new Error("no start")), 10_000); p.stdout.on("data", d => String(d).includes("listening") && (clearTimeout(t), ok())); });
    const u = `http://127.0.0.1:${port}/api/v1/reports/mailboxes`;
    const body = JSON.stringify({ v: 1, pub: rawPub(), admin: hash(b64(32)) });
    const ok = await fetch(u, { method: "POST", headers: { "content-type": "application/json", origin: "https://filenymous.eu" }, body });
    assert.equal(ok.status, 201);
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://filenymous.eu");
    const bad = await fetch(u, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body });
    assert.equal(bad.status, 403);
  } finally {
    p.kill();
  }
});
