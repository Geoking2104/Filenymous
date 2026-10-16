// Secrets Vault (burn-after-reading) HTTP API, served by p2p-signal.
//
// Zero-knowledge: browsers encrypt with AES-256-GCM before upload; the key
// lives only in the link fragment. This module stores ciphertext + an auth
// hash (sha256 of a token derived from the full key), never the key itself.
// Revealing requires the token, so knowing the id alone (or a wrong password)
// cannot burn a secret. Read-and-delete is atomic (Lua on Redis, synchronous
// on the in-memory fallback).
import { createHash, randomBytes } from "node:crypto";

const MAX_CT_CHARS = Number(process.env.VAULT_MAX_CT_CHARS || 90_000); // ~64 KiB plaintext in base64url
const MAX_BODY_BYTES = Number(process.env.VAULT_MAX_BODY_BYTES || 100_000);
const MAX_TTL_S = Number(process.env.VAULT_MAX_TTL_S || 7 * 24 * 3600);
const DEFAULT_TTL_S = Number(process.env.VAULT_DEFAULT_TTL_S || 24 * 3600);
const CREATE_PER_MIN = Number(process.env.VAULT_CREATE_PER_MIN || 20);
const READ_PER_MIN = Number(process.env.VAULT_READ_PER_MIN || 60);
const MAX_MEMORY_SECRETS = Number(process.env.VAULT_MAX_MEMORY_SECRETS || 10_000);

const B64URL = /^[A-Za-z0-9_-]+$/;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const HEX64 = /^[a-f0-9]{64}$/;

const REVEAL_LUA = `
local v = redis.call('GET', KEYS[1])
if not v then return {0} end
local d = cjson.decode(v)
if d.auth ~= ARGV[1] then return {1} end
if d.reads == 1 then redis.call('DEL', KEYS[1]) end
return {2, v}`;

export class MemoryStore {
  constructor() {
    this.map = new Map();
    this.timer = setInterval(() => this.sweep(), 30_000);
    this.timer.unref?.();
  }
  sweep() {
    const t = Date.now();
    for (const [k, v] of this.map) if (v.expiresAt <= t) this.map.delete(k);
  }
  async put(id, record, ttlS) {
    this.sweep();
    if (this.map.size >= MAX_MEMORY_SECRETS) throw new Error("vault-full");
    this.map.set(id, { json: JSON.stringify(record), expiresAt: Date.now() + ttlS * 1000 });
  }
  get(id) {
    const e = this.map.get(id);
    if (!e) return null;
    if (e.expiresAt <= Date.now()) {
      this.map.delete(id);
      return null;
    }
    return e.json;
  }
  async peek(id) {
    return this.get(id);
  }
  /** Synchronous check-and-delete: atomic in Node's single thread. */
  async reveal(id, authHash) {
    const json = this.get(id);
    if (!json) return { status: "gone" };
    const d = JSON.parse(json);
    if (d.auth !== authHash) return { status: "denied" };
    if (d.reads === 1) this.map.delete(id);
    return { status: "ok", json };
  }
}

export class RedisStore {
  constructor(url) {
    this.url = url;
    this.client = null;
  }
  async conn() {
    if (!this.client) {
      const { createClient } = await import("redis");
      this.client = createClient({ url: this.url });
      this.client.on("error", e => console.error("vault redis:", e.message));
      await this.client.connect();
    }
    return this.client;
  }
  async put(id, record, ttlS) {
    const ok = await (await this.conn()).set(`secret:${id}`, JSON.stringify(record), { EX: ttlS, NX: true });
    if (ok !== "OK") throw new Error("id-collision");
  }
  async peek(id) {
    return (await this.conn()).get(`secret:${id}`);
  }
  async reveal(id, authHash) {
    const r = await (await this.conn()).eval(REVEAL_LUA, { keys: [`secret:${id}`], arguments: [authHash] });
    if (r[0] === 0) return { status: "gone" };
    if (r[0] === 1) return { status: "denied" };
    return { status: "ok", json: r[1] };
  }
  async close() {
    await this.client?.quit();
  }
}

export function createStore() {
  if (process.env.REDIS_URL) return new RedisStore(process.env.REDIS_URL);
  if (process.env.NODE_ENV === "production" && !process.env.VAULT_ALLOW_MEMORY) {
    console.warn("vault: REDIS_URL not set, using the in-memory store (secrets are lost on restart)");
  }
  return new MemoryStore();
}

export const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-resource-policy": "cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "cache-control": "no-store",
  pragma: "no-cache",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on("data", c => {
      size += c.length;
      // Past the limit, keep draining (so the 413 reaches the client) but
      // stop buffering.
      if (size <= MAX_BODY_BYTES) parts.push(c);
    });
    req.on("end", () => {
      if (size > MAX_BODY_BYTES) reject(Object.assign(new Error("too-large"), { status: 413 }));
      else resolve(Buffer.concat(parts).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function validateCreate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const allowed = ["v", "ct", "iv", "salt", "pw", "auth", "ttl", "reads"];
  if (!Object.keys(body).every(k => allowed.includes(k))) return null;
  const { v, ct, iv, salt, pw, auth } = body;
  if (v !== 1) return null;
  if (typeof ct !== "string" || !ct || ct.length > MAX_CT_CHARS || !B64URL.test(ct)) return null;
  if (typeof iv !== "string" || !B64URL.test(iv) || iv.length !== 16) return null;
  if (typeof pw !== "boolean") return null;
  if (pw ? typeof salt !== "string" || !B64URL.test(salt) || salt.length !== 22 : salt !== undefined) return null;
  if (typeof auth !== "string" || !HEX64.test(auth)) return null;
  const reads = body.reads === undefined ? 1 : body.reads;
  if (reads !== 0 && reads !== 1) return null; // 1 = burn after reading, 0 = until expiry
  const ttl = body.ttl === undefined ? DEFAULT_TTL_S : body.ttl;
  if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > MAX_TTL_S) return null;
  return { ct, iv, salt, pw, auth, reads, ttl };
}

export function createVault({ store = createStore(), clientIp }) {
  const buckets = new Map();
  const sweep = setInterval(() => {
    const t = Date.now();
    for (const [k, b] of buckets) if (b.resetAt < t) buckets.delete(k);
  }, 60_000);
  sweep.unref?.();

  function limited(req, kind, max) {
    const key = `${kind}:${clientIp(req)}`;
    const t = Date.now();
    const b = buckets.get(key) || { resetAt: t + 60_000, count: 0 };
    if (t > b.resetAt) {
      b.resetAt = t + 60_000;
      b.count = 0;
    }
    b.count++;
    buckets.set(key, b);
    return b.count > max;
  }

  /** Returns true when the request was handled. */
  async function handle(req, res, path, baseHeaders) {
    if (!path.startsWith("/api/v1/secrets")) return false;
    const headers = { ...baseHeaders, ...SECURITY_HEADERS, "content-type": "application/json" };
    if (headers["access-control-allow-origin"]) {
      headers["access-control-allow-methods"] = "GET, POST, OPTIONS";
      headers["access-control-allow-headers"] = "content-type";
      headers["access-control-max-age"] = "600";
    }
    const reply = (status, body) => {
      res.writeHead(status, headers);
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    if (req.method === "OPTIONS") return reply(204), true;

    try {
      if (path === "/api/v1/secrets" && req.method === "POST") {
        if (limited(req, "create", CREATE_PER_MIN)) return reply(429, { error: "rate-limited" }), true;
        if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) return reply(415, { error: "json-required" }), true;
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch (e) {
          return reply(e.status || 400, { error: e.status ? "too-large" : "invalid-json" }), true;
        }
        const rec = validateCreate(body);
        if (!rec) return reply(400, { error: "invalid-secret" }), true;
        const id = randomBytes(16).toString("base64url");
        const expiresAt = Date.now() + rec.ttl * 1000;
        const record = { v: 1, ct: rec.ct, iv: rec.iv, pw: rec.pw, auth: rec.auth, reads: rec.reads, expiresAt };
        if (rec.salt) record.salt = rec.salt;
        try {
          await store.put(id, record, rec.ttl);
        } catch (e) {
          return reply(e.message === "vault-full" ? 507 : 503, { error: "unavailable" }), true;
        }
        return reply(201, { id, expiresAt }), true;
      }

      const m = path.match(/^\/api\/v1\/secrets\/([^/]+)\/(meta|reveal)$/);
      if (!m) return reply(404, { error: "not-found" }), true;
      const [, id, action] = m;
      if (limited(req, "read", READ_PER_MIN)) return reply(429, { error: "rate-limited" }), true;
      if (!ID_RE.test(id)) return reply(404, { error: "gone" }), true;

      if (action === "meta" && req.method === "GET") {
        // Non-consuming: lets the page show "Afficher le secret" first, so link
        // previewers and bots never burn the secret.
        const json = await store.peek(id);
        if (!json) return reply(404, { error: "gone" }), true;
        const d = JSON.parse(json);
        return reply(200, { pw: d.pw, ...(d.salt ? { salt: d.salt } : {}), reads: d.reads, expiresAt: d.expiresAt }), true;
      }
      if (action === "reveal" && req.method === "POST") {
        let token;
        try {
          token = JSON.parse(await readBody(req)).token;
        } catch (e) {
          return reply(e.status || 400, { error: e.status ? "too-large" : "invalid-json" }), true;
        }
        if (typeof token !== "string" || !B64URL.test(token) || token.length !== 43) return reply(400, { error: "invalid-token" }), true;
        const authHash = createHash("sha256").update(Buffer.from(token, "base64url")).digest("hex");
        const r = await store.reveal(id, authHash);
        if (r.status === "gone") return reply(404, { error: "gone" }), true;
        if (r.status === "denied") return reply(403, { error: "denied" }), true;
        const d = JSON.parse(r.json);
        return reply(200, { ct: d.ct, iv: d.iv, ...(d.salt ? { salt: d.salt } : {}), pw: d.pw, burned: d.reads === 1 }), true;
      }
      return reply(405, { error: "method-not-allowed" }), true;
    } catch (e) {
      console.error("vault:", e?.message || e);
      return reply(503, { error: "unavailable" }), true;
    }
  }

  return { handle, store };
}
