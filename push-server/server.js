/**
 * Filenymous Web Push backend
 *
 * POST   /api/push/subscribe     body: { subscription, userId?, topics? }
 * DELETE /api/push/unsubscribe   body: { endpoint }
 * POST   /api/push/send          Authorization: Bearer <PUSH_API_SECRET>
 *                                body: { userId? | topic? | endpoint?, title, body, tab?, kind?, tag? }
 * GET    /api/push/vapid-public-key
 * GET    /health
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webpush from "web-push";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Minimal .env loader (no dependency) — Windows/macOS/Linux */
function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnvFile();

const PORT = Number(process.env.PORT || 3091);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:contact@filenymous.eu";
const API_SECRET = process.env.PUSH_API_SECRET || "";
const STORE_PATH =
  process.env.SUBSCRIPTIONS_PATH || path.join(__dirname, "data", "subscriptions.json");

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
} else {
  console.warn("[push] VAPID keys missing — run npm run vapid and set .env");
}

/** @typedef {{ endpoint: string, keys: { p256dh: string, auth: string }, expirationTime?: number|null }} PushSub */
/** @typedef {{ subscription: PushSub, userId: string, topics: string[], updatedAt: number }} Stored */

/** @type {Map<string, Stored>} */
const store = new Map();

function loadStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    if (Array.isArray(raw)) {
      for (const row of raw) {
        if (row?.subscription?.endpoint) store.set(row.subscription.endpoint, row);
      }
    }
    console.log(`[push] loaded ${store.size} subscription(s)`);
  } catch (e) {
    console.warn("[push] load store failed:", e.message);
  }
}

function saveStore() {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    const rows = [...store.values()];
    fs.writeFileSync(STORE_PATH, JSON.stringify(rows, null, 2));
  } catch (e) {
    console.warn("[push] save store failed:", e.message);
  }
}

loadStore();

function cors(req, res) {
  const origin = req.headers.origin || "";
  const allowed = CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);
  if (CORS_ORIGIN === "*" || allowed.includes(origin) || allowed.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN === "*" ? "*" : origin || "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function authorized(req) {
  if (!API_SECRET) return false;
  const h = req.headers.authorization || "";
  return h === `Bearer ${API_SECRET}`;
}

function isValidSub(sub) {
  return (
    sub &&
    typeof sub.endpoint === "string" &&
    sub.endpoint.startsWith("https://") &&
    sub.keys &&
    typeof sub.keys.p256dh === "string" &&
    typeof sub.keys.auth === "string"
  );
}

async function sendTo(sub, payload) {
  const data = JSON.stringify({
    title: payload.title || "Filenymous",
    body: payload.body || "",
    tab: payload.tab || "",
    kind: payload.kind || "info",
    tag: payload.tag || `fn-${Date.now()}`,
    url: payload.url || "./",
  });

  try {
    await webpush.sendNotification(sub, data, {
      TTL: payload.ttl ?? 60 * 60,
      urgency: payload.urgency || "normal",
    });
    return { ok: true, endpoint: sub.endpoint };
  } catch (err) {
    const statusCode = err.statusCode || err.status || 0;
    if (statusCode === 404 || statusCode === 410) {
      store.delete(sub.endpoint);
      saveStore();
    }
    return {
      ok: false,
      endpoint: sub.endpoint,
      statusCode,
      message: err.body || err.message || String(err),
    };
  }
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        service: "filenymous-push",
        subscriptions: store.size,
        vapidConfigured: Boolean(VAPID_PUBLIC && VAPID_PRIVATE),
      });
    }

    if (req.method === "GET" && url.pathname === "/api/push/vapid-public-key") {
      if (!VAPID_PUBLIC) return json(res, 503, { error: "VAPID not configured" });
      return json(res, 200, { publicKey: VAPID_PUBLIC });
    }

    if (req.method === "POST" && url.pathname === "/api/push/subscribe") {
      const body = await readBody(req);
      const subscription = body.subscription;
      if (!isValidSub(subscription)) {
        return json(res, 400, { error: "Invalid subscription" });
      }
      const userId = String(body.userId || "anonymous").slice(0, 128);
      const topics = Array.isArray(body.topics)
        ? body.topics.map((t) => String(t).slice(0, 64)).slice(0, 20)
        : [];

      store.set(subscription.endpoint, {
        subscription,
        userId,
        topics,
        updatedAt: Date.now(),
      });
      saveStore();
      return json(res, 201, { ok: true, endpoint: subscription.endpoint });
    }

    if (req.method === "DELETE" && url.pathname === "/api/push/unsubscribe") {
      const body = await readBody(req);
      const endpoint = body.endpoint || body.subscription?.endpoint;
      if (!endpoint) return json(res, 400, { error: "endpoint required" });
      const existed = store.delete(endpoint);
      if (existed) saveStore();
      return json(res, 200, { ok: true, removed: existed });
    }

    if (req.method === "POST" && url.pathname === "/api/push/send") {
      if (!authorized(req)) return json(res, 401, { error: "Unauthorized" });
      if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
        return json(res, 503, { error: "VAPID not configured" });
      }

      const body = await readBody(req);
      if (!body.title) return json(res, 400, { error: "title required" });

      /** @type {Stored[]} */
      let targets = [];
      if (body.endpoint) {
        const row = store.get(body.endpoint);
        if (row) targets = [row];
      } else if (body.userId) {
        targets = [...store.values()].filter((r) => r.userId === body.userId);
      } else if (body.topic) {
        targets = [...store.values()].filter((r) => r.topics.includes(body.topic));
      } else if (body.broadcast === true) {
        targets = [...store.values()];
      } else {
        return json(res, 400, {
          error: "Specify endpoint, userId, topic, or broadcast:true",
        });
      }

      const results = [];
      for (const row of targets) {
        results.push(await sendTo(row.subscription, body));
      }

      const sent = results.filter((r) => r.ok).length;
      return json(res, 200, {
        ok: true,
        targeted: targets.length,
        sent,
        failed: results.length - sent,
        results,
      });
    }

    return json(res, 404, { error: "Not found" });
  } catch (e) {
    console.error("[push]", e);
    return json(res, 500, { error: e.message || "Server error" });
  }
});

server.listen(PORT, () => {
  console.log(`[push] Filenymous push-server on :${PORT}`);
  console.log(`[push] subscriptions: ${store.size}`);
  console.log(`[push] vapid: ${VAPID_PUBLIC ? "ok" : "missing"}`);
});
