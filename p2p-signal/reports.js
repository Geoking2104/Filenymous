// "Canal de signalement" (whistleblowing mailbox) HTTP API, served by p2p-signal.
//
// Zero-knowledge and asynchronous: the organisation's browser generates an
// ECDH P-256 key pair and registers only the PUBLIC key. Reports are sealed to
// it in the reporter's browser (ephemeral ECDH + HKDF + AES-256-GCM) and
// stored here as ciphertext. Replies from the organisation are encrypted with
// a key derived from the reporter's follow-up secret, which never reaches the
// server either.
//
// Privacy rules for these endpoints:
// - no IP address, User-Agent or Referer is ever stored or logged. Rate limits
//   use HMAC(ip, in-memory key rotated every RATE_KEY_ROTATE_MS) kept only in
//   RAM for one minute; the key is never persisted, so buckets can't be
//   reversed or linked across rotations;
// - timestamps are rounded to the hour;
// - log lines carry no request data (error class only).
// nginx must also disable access_log for /api/v1/reports (see docs/DEPLOYMENT.md).
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const env = (k, d) => Number(process.env[k] || d);
const REPORT_TTL_S = env("REPORT_TTL_S", 90 * 24 * 3600);
const MAILBOX_TTL_S = env("REPORT_MAILBOX_TTL_S", 365 * 24 * 3600);
const MAX_REPORT_BODY = env("REPORT_MAX_BODY_BYTES", 12 * 1024 * 1024);
const MAX_MSG_BODY = env("REPORT_MAX_MSG_BYTES", 200_000);
const MAX_REPORTS_PER_MAILBOX = env("REPORT_MAX_PER_MAILBOX", 500);
const MAX_THREAD = env("REPORT_MAX_THREAD", 200);
const CREATE_PER_MIN = env("REPORT_CREATE_PER_MIN", 10);
const SUBMIT_PER_MIN = env("REPORT_SUBMIT_PER_MIN", 6);
const READ_PER_MIN = env("REPORT_READ_PER_MIN", 60);
const SUBMIT_PER_MAILBOX_PER_HOUR = env("REPORT_SUBMIT_PER_MAILBOX_HOUR", 60);
const RATE_KEY_ROTATE_MS = env("REPORT_RATE_KEY_ROTATE_MS", 10 * 60 * 1000);
const MAX_MEMORY_KEYS = env("REPORT_MAX_MEMORY_KEYS", 20_000);

const B64URL = /^[A-Za-z0-9_-]+$/;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const PUB_RE = /^[A-Za-z0-9_-]{87}$/; // raw uncompressed P-256 point, 65 bytes
export const STATUSES = ["recu", "en-cours", "clos"];

const hourNow = () => Math.floor(Date.now() / 3_600_000) * 3_600_000;
const sha256 = s => createHash("sha256").update(Buffer.from(s, "base64url")).digest("hex");
function sameHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Minimal KV + list + set with TTL, in memory (dev / tests). */
export class MemoryKV {
  constructor() {
    this.m = new Map();
    this.t = setInterval(() => this.sweep(), 60_000);
    this.t.unref?.();
  }
  sweep() {
    const n = Date.now();
    for (const [k, v] of this.m) if (v.exp <= n) this.m.delete(k);
  }
  live(k) {
    const e = this.m.get(k);
    if (!e) return null;
    if (e.exp <= Date.now()) return this.m.delete(k), null;
    return e;
  }
  room() {
    if (this.m.size >= MAX_MEMORY_KEYS) {
      this.sweep();
      if (this.m.size >= MAX_MEMORY_KEYS) throw new Error("full");
    }
  }
  async setNX(k, v, ttl) {
    if (this.live(k)) return false;
    this.room();
    this.m.set(k, { v, exp: Date.now() + ttl * 1000 });
    return true;
  }
  async set(k, v, ttl) {
    this.room();
    this.m.set(k, { v, exp: Date.now() + ttl * 1000 });
  }
  async get(k) {
    return this.live(k)?.v ?? null;
  }
  async expire(k, ttl) {
    const e = this.live(k);
    if (e) e.exp = Date.now() + ttl * 1000;
  }
  async push(k, v, ttl) {
    const e = this.live(k);
    if (e) return e.v.push(v), e.v.length;
    this.room();
    this.m.set(k, { v: [v], exp: Date.now() + ttl * 1000 });
    return 1;
  }
  async range(k) {
    return [...(this.live(k)?.v ?? [])];
  }
  async llen(k) {
    return this.live(k)?.v.length ?? 0;
  }
  /** Test helper: every stored byte, to prove no IP is kept. */
  dump() {
    return JSON.stringify([...this.m].map(([k, e]) => [k, e.v]));
  }
}

export class RedisKV {
  constructor(url) {
    this.url = url;
    this.c = null;
  }
  async conn() {
    if (!this.c) {
      const { createClient } = await import("redis");
      this.c = createClient({ url: this.url });
      this.c.on("error", () => console.error("reports: redis error"));
      await this.c.connect();
    }
    return this.c;
  }
  async setNX(k, v, ttl) {
    return (await (await this.conn()).set(k, v, { EX: ttl, NX: true })) === "OK";
  }
  async set(k, v, ttl) {
    await (await this.conn()).set(k, v, { EX: ttl });
  }
  async get(k) {
    return (await this.conn()).get(k);
  }
  async expire(k, ttl) {
    await (await this.conn()).expire(k, ttl);
  }
  async push(k, v, ttl) {
    const c = await this.conn();
    const [n] = await c.multi().rPush(k, v).expire(k, ttl).exec();
    return Number(n);
  }
  async range(k) {
    return (await this.conn()).lRange(k, 0, -1);
  }
  async llen(k) {
    return (await this.conn()).lLen(k);
  }
}

export function createKV() {
  return process.env.REDIS_URL ? new RedisKV(process.env.REDIS_URL) : new MemoryKV();
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on("data", c => {
      size += c.length;
      if (size <= max) parts.push(c);
    });
    req.on("end", () => (size > max ? reject(Object.assign(new Error("too-large"), { status: 413 })) : resolve(Buffer.concat(parts).toString("utf8"))));
    req.on("error", reject);
  });
}

const isSealed = (s, maxCt) =>
  s && typeof s === "object" && Object.keys(s).every(k => ["epk", "iv", "ct"].includes(k))
  && typeof s.epk === "string" && PUB_RE.test(s.epk)
  && typeof s.iv === "string" && s.iv.length === 16 && B64URL.test(s.iv)
  && typeof s.ct === "string" && s.ct.length > 0 && s.ct.length <= maxCt && B64URL.test(s.ct);
const isSym = (m, maxCt) =>
  m && typeof m === "object" && Object.keys(m).every(k => ["iv", "ct"].includes(k))
  && typeof m.iv === "string" && m.iv.length === 16 && B64URL.test(m.iv)
  && typeof m.ct === "string" && m.ct.length > 0 && m.ct.length <= maxCt && B64URL.test(m.ct);
const isToken = t => typeof t === "string" && t.length === 43 && B64URL.test(t);

export function createReports({ kv = createKV(), clientIp, securityHeaders = {} }) {
  // Privacy-preserving rate limiting: bucket = HMAC(rotating key, ip). The key
  // lives only in RAM and is replaced regularly; buckets live one minute.
  let rateKey = randomBytes(32);
  const rot = setInterval(() => { rateKey = randomBytes(32); }, RATE_KEY_ROTATE_MS);
  rot.unref?.();
  const buckets = new Map();
  const sw = setInterval(() => {
    const t = Date.now();
    for (const [k, b] of buckets) if (b.resetAt < t) buckets.delete(k);
  }, 60_000);
  sw.unref?.();
  function hit(key, max, windowMs = 60_000) {
    const t = Date.now();
    let b = buckets.get(key);
    if (!b || t > b.resetAt) b = { resetAt: t + windowMs, count: 0 };
    b.count++;
    buckets.set(key, b);
    return b.count > max;
  }
  const limited = (req, kind, max) =>
    hit(`${kind}:${createHmac("sha256", rateKey).update(String(clientIp(req))).digest("base64url").slice(0, 16)}`, max);

  const mboxKey = id => `rmbox:${id}`;
  const listKey = id => `rmbox:${id}:reports`;
  const repKey = id => `rrep:${id}`;
  const thrKey = id => `rrep:${id}:thread`;

  async function mailbox(id) {
    if (!ID_RE.test(id)) return null;
    const j = await kv.get(mboxKey(id));
    return j ? JSON.parse(j) : null;
  }
  async function report(id) {
    if (!ID_RE.test(id)) return null;
    const j = await kv.get(repKey(id));
    return j ? JSON.parse(j) : null;
  }
  async function thread(id) {
    return (await kv.range(thrKey(id))).map(s => JSON.parse(s));
  }
  const ttlLeft = r => Math.max(60, Math.ceil((r.expiresAt - Date.now()) / 1000));

  async function handle(req, res, path, baseHeaders) {
    if (!path.startsWith("/api/v1/reports")) return false;
    const headers = { ...baseHeaders, ...securityHeaders, "content-type": "application/json" };
    if (headers["access-control-allow-origin"]) {
      headers["access-control-allow-methods"] = "GET, POST, OPTIONS";
      headers["access-control-allow-headers"] = "content-type";
      headers["access-control-max-age"] = "600";
    }
    const reply = (status, body) => {
      res.writeHead(status, headers);
      res.end(body === undefined ? "" : JSON.stringify(body));
      return true;
    };
    if (req.method === "OPTIONS") return reply(204);
    const body = async max => {
      if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) throw Object.assign(new Error("json"), { status: 415 });
      try {
        return JSON.parse(await readBody(req, max));
      } catch (e) {
        throw Object.assign(new Error("bad"), { status: e.status || 400 });
      }
    };
    const p = path.slice("/api/v1/reports".length);
    try {
      // --- organisation: create a mailbox -------------------------------
      if (p === "/mailboxes" && req.method === "POST") {
        if (limited(req, "create", CREATE_PER_MIN)) return reply(429, { error: "rate-limited" });
        const b = await body(4_000);
        if (!b || b.v !== 1 || !PUB_RE.test(b.pub || "") || !HEX64.test(b.admin || "") || Object.keys(b).some(k => !["v", "pub", "admin"].includes(k))) return reply(400, { error: "invalid" });
        const id = randomBytes(16).toString("base64url");
        const rec = { v: 1, pub: b.pub, admin: b.admin, createdAt: hourNow() };
        if (!(await kv.setNX(mboxKey(id), JSON.stringify(rec), MAILBOX_TTL_S))) return reply(503, { error: "unavailable" });
        return reply(201, { id, reportTtlS: REPORT_TTL_S });
      }
      let m = p.match(/^\/mailboxes\/([^/]+)$/);
      if (m && req.method === "GET") {
        if (limited(req, "read", READ_PER_MIN)) return reply(429, { error: "rate-limited" });
        const mb = await mailbox(m[1]);
        return mb ? reply(200, { pub: mb.pub, reportTtlS: REPORT_TTL_S }) : reply(404, { error: "gone" });
      }
      // --- reporter: submit ------------------------------------------------
      m = p.match(/^\/mailboxes\/([^/]+)\/reports$/);
      if (m && req.method === "POST") {
        if (limited(req, "submit", SUBMIT_PER_MIN)) return reply(429, { error: "rate-limited" });
        const mb = await mailbox(m[1]);
        if (!mb) return reply(404, { error: "gone" });
        if (hit(`mbox:${m[1]}`, SUBMIT_PER_MAILBOX_PER_HOUR, 3_600_000)) return reply(429, { error: "rate-limited" });
        const b = await body(MAX_REPORT_BODY);
        if (!b || b.v !== 1 || !ID_RE.test(b.id || "") || !HEX64.test(b.auth || "") || !isSealed(b.sealed, MAX_REPORT_BODY) || Object.keys(b).some(k => !["v", "id", "auth", "sealed"].includes(k))) return reply(400, { error: "invalid" });
        if ((await kv.llen(listKey(m[1]))) >= MAX_REPORTS_PER_MAILBOX) return reply(507, { error: "mailbox-full" });
        const rec = { v: 1, mailbox: m[1], auth: b.auth, sealed: b.sealed, status: "recu", createdAt: hourNow(), expiresAt: Date.now() + REPORT_TTL_S * 1000 };
        if (!(await kv.setNX(repKey(b.id), JSON.stringify(rec), REPORT_TTL_S))) return reply(409, { error: "exists" });
        await kv.push(listKey(m[1]), b.id, Math.max(REPORT_TTL_S, MAILBOX_TTL_S));
        return reply(201, { status: "recu", expiresAt: rec.expiresAt });
      }
      // --- organisation: inbox (admin token in the body, never in the URL) --
      m = p.match(/^\/mailboxes\/([^/]+)\/(list|open|reply|status)$/);
      if (m && req.method === "POST") {
        if (limited(req, "read", READ_PER_MIN)) return reply(429, { error: "rate-limited" });
        const [, mid, action] = m;
        const b = await body(MAX_MSG_BODY);
        const mb = await mailbox(mid);
        if (!mb) return reply(404, { error: "gone" });
        if (!isToken(b?.token) || !sameHex(sha256(b.token), mb.admin)) return reply(403, { error: "denied" });
        if (action === "list") {
          await kv.expire(mboxKey(mid), MAILBOX_TTL_S); // an active mailbox stays alive
          const ids = [...new Set(await kv.range(listKey(mid)))];
          const out = [];
          for (const id of ids) {
            const r = await report(id);
            if (r && r.mailbox === mid) out.push({ id, status: r.status, createdAt: r.createdAt, expiresAt: r.expiresAt, messages: await kv.llen(thrKey(id)) });
          }
          return reply(200, { reports: out.sort((a, b2) => b2.createdAt - a.createdAt) });
        }
        const r = await report(b.id);
        if (!r || r.mailbox !== mid) return reply(404, { error: "gone" });
        if (action === "open") return reply(200, { sealed: r.sealed, status: r.status, createdAt: r.createdAt, expiresAt: r.expiresAt, thread: await thread(b.id) });
        if (action === "status") {
          if (!STATUSES.includes(b.status)) return reply(400, { error: "invalid" });
          r.status = b.status;
          await kv.set(repKey(b.id), JSON.stringify(r), ttlLeft(r));
          return reply(200, { status: r.status });
        }
        if (!isSym(b.msg, MAX_MSG_BODY)) return reply(400, { error: "invalid" });
        if ((await kv.llen(thrKey(b.id))) >= MAX_THREAD) return reply(507, { error: "thread-full" });
        await kv.push(thrKey(b.id), JSON.stringify({ from: "org", at: hourNow(), msg: b.msg }), ttlLeft(r));
        if (r.status === "recu") {
          r.status = "en-cours";
          await kv.set(repKey(b.id), JSON.stringify(r), ttlLeft(r));
        }
        return reply(201, { status: r.status });
      }
      // --- reporter: follow-up with the one-way key ------------------------
      m = p.match(/^\/r\/([^/]+)\/(thread|followup)$/);
      if (m && req.method === "POST") {
        if (limited(req, "read", READ_PER_MIN)) return reply(429, { error: "rate-limited" });
        const b = await body(MAX_MSG_BODY);
        const r = await report(m[1]);
        // Same answer for "unknown" and "wrong key": no oracle on report ids.
        if (!r || !isToken(b?.token) || !sameHex(sha256(b.token), r.auth)) return reply(403, { error: "denied" });
        if (m[2] === "thread") {
          const mb = await mailbox(r.mailbox);
          return reply(200, { status: r.status, createdAt: r.createdAt, expiresAt: r.expiresAt, pub: mb?.pub ?? null, thread: await thread(m[1]) });
        }
        if (!isSealed(b.sealed, MAX_MSG_BODY)) return reply(400, { error: "invalid" });
        if ((await kv.llen(thrKey(m[1]))) >= MAX_THREAD) return reply(507, { error: "thread-full" });
        await kv.push(thrKey(m[1]), JSON.stringify({ from: "reporter", at: hourNow(), sealed: b.sealed }), ttlLeft(r));
        return reply(201, { status: r.status });
      }
      return reply(404, { error: "not-found" });
    } catch (e) {
      if (e.status === 413) return reply(413, { error: "too-large" });
      if (e.status === 415) return reply(415, { error: "json-required" });
      if (e.status === 400) return reply(400, { error: "invalid-json" });
      if (e.message === "full") return reply(507, { error: "unavailable" });
      console.error("reports: internal error"); // never log request data
      return reply(503, { error: "unavailable" });
    }
  }
  return { handle, kv, _buckets: buckets };
}
