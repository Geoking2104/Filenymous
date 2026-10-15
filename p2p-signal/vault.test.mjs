// Secrets Vault API tests: node --test (in-memory store, plus Redis when redis-server is installed)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const procs = [];
process.on("exit", () => procs.forEach(p => p.kill()));

function waitFor(proc, text) {
  return new Promise((ok, ko) => {
    const t = setTimeout(() => ko(new Error(`did not print ${text}`)), 10_000);
    const on = d => { if (String(d).includes(text)) { clearTimeout(t); ok(); } };
    proc.stdout.on("data", on);
    proc.stderr.on("data", on);
  });
}

async function startRelay(env = {}) {
  const port = 20000 + Math.floor(Math.random() * 5000);
  const p = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], {
    env: { ...process.env, PORT: String(port), VAULT_CREATE_PER_MIN: "1000", VAULT_READ_PER_MIN: "1000", ...env },
    stdio: "pipe",
  });
  procs.push(p);
  await waitFor(p, "listening");
  return `http://127.0.0.1:${port}`;
}

const b64 = n => randomBytes(n).toString("base64url");
function newSecret(extra = {}) {
  const token = randomBytes(32);
  return {
    token: token.toString("base64url"),
    body: { v: 1, ct: b64(48), iv: b64(12), pw: false, auth: createHash("sha256").update(token).digest("hex"), ...extra },
  };
}
const post = (base, path, body, headers = { "content-type": "application/json" }) =>
  fetch(base + path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

async function suite(name, base) {
  await test(`${name}: create → meta → reveal burns → gone`, async () => {
    const s = newSecret();
    const r = await post(base, "/api/v1/secrets", s.body);
    assert.equal(r.status, 201);
    assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    const { id } = await r.json();
    const meta = await fetch(`${base}/api/v1/secrets/${id}/meta`);
    assert.equal(meta.status, 200);
    assert.equal((await meta.json()).pw, false);
    assert.equal((await fetch(`${base}/api/v1/secrets/${id}/meta`)).status, 200, "meta never consumes");
    const rev = await post(base, `/api/v1/secrets/${id}/reveal`, { token: s.token });
    assert.equal(rev.status, 200);
    const d = await rev.json();
    assert.equal(d.ct, s.body.ct);
    assert.equal(d.burned, true);
    assert.equal(d.auth, undefined, "auth hash never returned");
    assert.equal((await post(base, `/api/v1/secrets/${id}/reveal`, { token: s.token })).status, 404);
    assert.equal((await fetch(`${base}/api/v1/secrets/${id}/meta`)).status, 404);
  });

  await test(`${name}: wrong token is denied and does not burn`, async () => {
    const s = newSecret();
    const { id } = await (await post(base, "/api/v1/secrets", s.body)).json();
    assert.equal((await post(base, `/api/v1/secrets/${id}/reveal`, { token: b64(32) })).status, 403);
    assert.equal((await post(base, `/api/v1/secrets/${id}/reveal`, { token: s.token })).status, 200);
  });

  await test(`${name}: concurrent reveals → exactly one success`, async () => {
    const s = newSecret();
    const { id } = await (await post(base, "/api/v1/secrets", s.body)).json();
    const res = await Promise.all(Array.from({ length: 40 }, () => post(base, `/api/v1/secrets/${id}/reveal`, { token: s.token })));
    assert.equal(res.filter(r => r.status === 200).length, 1);
    assert.equal(res.filter(r => r.status === 404).length, 39);
  });

  await test(`${name}: TTL mode (reads=0) can be read until expiry`, async () => {
    const s = newSecret({ reads: 0, ttl: 3600 });
    const { id } = await (await post(base, "/api/v1/secrets", s.body)).json();
    for (let i = 0; i < 3; i++) {
      const r = await post(base, `/api/v1/secrets/${id}/reveal`, { token: s.token });
      assert.equal(r.status, 200);
      assert.equal((await r.json()).burned, false);
    }
  });

  await test(`${name}: validation and size limits`, async () => {
    const bad = [
      { ...newSecret().body, v: 2 },
      { ...newSecret().body, ct: "not base64!" },
      { ...newSecret().body, ct: "a".repeat(90_001) },
      { ...newSecret().body, ttl: 10 },
      { ...newSecret().body, ttl: 30 * 24 * 3600 },
      { ...newSecret().body, reads: 5 },
      { ...newSecret().body, pw: true }, // salt missing
      { ...newSecret().body, plaintext: "nope" },
    ];
    for (const b of bad) assert.equal((await post(base, "/api/v1/secrets", b)).status, 400, JSON.stringify(Object.keys(b)));
    assert.equal((await post(base, "/api/v1/secrets", "x".repeat(200_000))).status, 413);
    assert.equal((await post(base, "/api/v1/secrets", newSecret().body, { "content-type": "text/plain" })).status, 415);
    assert.equal((await fetch(`${base}/api/v1/secrets/short/meta`)).status, 404);
  });
}

await suite("memory", await startRelay());

test("rate limiting on creation", async () => {
  const base = await startRelay({ VAULT_CREATE_PER_MIN: "3" });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await post(base, "/api/v1/secrets", newSecret().body)).status);
  assert.deepEqual(codes, [201, 201, 201, 429, 429]);
});

const hasRedis = spawnSync("redis-server", ["--version"]).status === 0;
if (hasRedis) {
  const port = 26000 + Math.floor(Math.random() * 3000);
  const redis = spawn("redis-server", ["--port", String(port), "--save", "", "--appendonly", "no"], { stdio: "pipe" });
  procs.push(redis);
  await waitFor(redis, "Ready to accept connections");
  await suite("redis", await startRelay({ REDIS_URL: `redis://127.0.0.1:${port}` }));
} else {
  test("redis store", { skip: "redis-server not installed" }, () => {});
}

test("cleanup", () => procs.forEach(p => p.kill()));
