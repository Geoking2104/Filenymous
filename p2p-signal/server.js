import { createServer } from "node:http";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { createVault, SECURITY_HEADERS } from "./vault.js";
import { createReports } from "./reports.js";

const port = Number(process.env.PORT || 8789);
const allowedOrigins = (process.env.ALLOWED_ORIGIN || "")
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 10 * 60 * 1000);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 10_000);
const RATE_LIMIT_MAX_MESSAGES = Number(process.env.RATE_LIMIT_MAX_MESSAGES || 60);
const MAX_SIGNAL_SDP_BYTES = Number(process.env.MAX_SIGNAL_SDP_BYTES || 64_000);
const MAX_SIGNAL_ICE_BYTES = Number(process.env.MAX_SIGNAL_ICE_BYTES || 16_000);
const MAX_ROOM_PEERS = Number(process.env.MAX_ROOM_PEERS || 12);
const MAX_ROOM_EVENT_BYTES = Number(process.env.MAX_ROOM_EVENT_BYTES || 768_000);
const MAX_ROOM_META_BYTES = Number(process.env.MAX_ROOM_META_BYTES || 8_000);
// Behind nginx every socket comes from 127.0.0.1: only trust X-Forwarded-For /
// X-Real-IP when explicitly told so (TRUST_PROXY=1), otherwise all users would
// share a single rate-limit bucket.
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || "");
const PING_INTERVAL_MS = Number(process.env.PING_INTERVAL_MS || 25_000);
// ICE / TURN configuration handed to browsers via GET /ice.
// STUN_URLS: comma-separated stun: URLs (default Google STUN).
// TURN_URLS: comma-separated turn:/turns: URLs (optional).
// TURN_SECRET: coturn `static-auth-secret` (use-auth-secret / TURN REST API)
//   -> short-lived per-request credentials, nothing static in the web app.
// TURN_USERNAME + TURN_CREDENTIAL: fallback static credentials (discouraged).
const STUN_URLS = (process.env.STUN_URLS ?? "stun:stun.l.google.com:19302").split(",").map(s => s.trim()).filter(Boolean);
const TURN_URLS = (process.env.TURN_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
const TURN_SECRET = process.env.TURN_SECRET || "";
const TURN_TTL_S = Number(process.env.TURN_TTL_S || 3600);
const rooms = new Map();
const roomSessions = new Map();
const rateLimits = new Map();
// Dropzones (100 % P2P collection links): the owner's tab is the receiver.
// The relay only routes SDP/ICE between the owner and each contributor; no
// file byte ever goes through it. dropId = "drop-" + sha256(ownerSecret)[:24],
// so only the holder of the owner link can take the owner role.
const DROP_MAX_TTL_MS = Number(process.env.DROP_MAX_TTL_MS || 30 * 24 * 3600 * 1000);
const DROP_DEFAULT_TTL_MS = Number(process.env.DROP_DEFAULT_TTL_MS || 7 * 24 * 3600 * 1000);
const MAX_DROP_CONTRIBUTORS = Number(process.env.MAX_DROP_CONTRIBUTORS || 8);
const DROP_SWEEP_MS = Number(process.env.DROP_SWEEP_MS || 30_000);
const drops = new Map();
// Sharewall (live multi-peer wall, star around the host's tab): the relay only
// routes SDP/ICE between the host and each peer, like Dropzones. It never sees
// the wall key (URL fragment) nor any content; it only knows an opaque wallId
// = "wall-" + sha256(hostSecret)[:24], random peer ids and the expiry.
// Walls connect on the /wall path so nginx can skip access logs for them.
const WALL_MAX_TTL_MS = Number(process.env.WALL_MAX_TTL_MS || 24 * 3600 * 1000 + 60_000);
const MAX_WALL_PEERS = Number(process.env.MAX_WALL_PEERS || 8);
const WALL_HOST_GRACE_MS = Number(process.env.WALL_HOST_GRACE_MS || 5_000);
const WALL_SWEEP_MS = Number(process.env.WALL_SWEEP_MS || 15_000);
const walls = new Map();
// Destroyed/expired wall ids, kept until their expiry so a closed wall can't
// be revived with the host link. Opaque ids only, in memory.
const closedWalls = new Map();

function now() {
  return Date.now();
}

function validateOneTimeCode(code) {
  return typeof code === "string" && /^\d{3}-\d{3}-[A-Z]{3}$/.test(code);
}

function validateRoomId(roomId) {
  return typeof roomId === "string" && /^room-[a-z0-9]{6,32}$/i.test(roomId);
}

function validateDropId(dropId) {
  return typeof dropId === "string" && /^drop-[a-f0-9]{24}$/.test(dropId);
}

function dropIdForOwnerSecret(ownerSecret) {
  if (typeof ownerSecret !== "string" || !/^[A-Za-z0-9_-]{22,64}$/.test(ownerSecret)) return null;
  return `drop-${createHash("sha256").update(ownerSecret, "utf8").digest("hex").slice(0, 24)}`;
}

function validateWallId(wallId) {
  return typeof wallId === "string" && /^wall-[a-f0-9]{24}$/.test(wallId);
}

function wallIdForHostSecret(hostSecret) {
  if (typeof hostSecret !== "string" || !/^[A-Za-z0-9_-]{22,64}$/.test(hostSecret)) return null;
  return `wall-${createHash("sha256").update(hostSecret, "utf8").digest("hex").slice(0, 24)}`;
}

function validateRoomPeerId(peerId) {
  return typeof peerId === "string" && /^[a-z0-9_-]{3,64}$/i.test(peerId);
}

function validateDisplayName(displayName) {
  return typeof displayName === "string"
    && displayName.trim().length > 0
    && displayName.trim().length <= 64
    && !/[\u0000-\u001f\u007f]/.test(displayName);
}

function cleanDisplayName(displayName) {
  return displayName.trim().slice(0, 64);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every(key => allowed.includes(key));
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function validateSignalPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  if (payload.kind === "offer" || payload.kind === "answer") {
    return hasOnlyKeys(payload, ["kind", "sdp"])
      && typeof payload.sdp === "string"
      && payload.sdp.length > 0
      && byteLength(payload.sdp) <= MAX_SIGNAL_SDP_BYTES;
  }
  if (payload.kind === "ice") {
    return hasOnlyKeys(payload, ["kind", "candidate"])
      && payload.candidate
      && typeof payload.candidate === "object"
      && !Array.isArray(payload.candidate)
      && byteLength(JSON.stringify(payload.candidate)) <= MAX_SIGNAL_ICE_BYTES;
  }
  return false;
}

function validateRoomEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  if (!hasOnlyKeys(event, ["kind", "iv", "ciphertext", "meta"])) return false;
  if (!["chat", "file-offer", "file-chunk", "file-complete", "file-revoke", "room-close"].includes(event.kind)) return false;
  if (typeof event.iv !== "string" || event.iv.length < 1 || byteLength(event.iv) > 256) return false;
  if (typeof event.ciphertext !== "string" || event.ciphertext.length < 1) return false;
  if (byteLength(JSON.stringify(event)) > MAX_ROOM_EVENT_BYTES) return false;
  if (event.meta !== undefined) {
    if (!event.meta || typeof event.meta !== "object" || Array.isArray(event.meta)) return false;
    if (byteLength(JSON.stringify(event.meta)) > MAX_ROOM_META_BYTES) return false;
  }
  return true;
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const real = req.headers["x-real-ip"];
    if (typeof real === "string" && real) return real.trim();
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

function checkRateLimit(ws) {
  const key = ws.clientIp || ws._socket?.remoteAddress || "unknown";
  const current = now();
  const bucket = rateLimits.get(key) || { resetAt: current + RATE_LIMIT_WINDOW_MS, count: 0 };
  if (current > bucket.resetAt) {
    bucket.resetAt = current + RATE_LIMIT_WINDOW_MS;
    bucket.count = 0;
  }
  bucket.count += 1;
  rateLimits.set(key, bucket);
  return bucket.count <= RATE_LIMIT_MAX_MESSAGES;
}

function isOpen(peer) {
  return peer && peer.readyState === WebSocket.OPEN;
}

function send(ws, msg) {
  if (isOpen(ws)) ws.send(JSON.stringify(msg));
}

function roomFor(code) {
  const existing = rooms.get(code);
  if (existing && (existing.expiresAt > now() || isOpen(existing.sender) || isOpen(existing.receiver))) {
    // A sender keeping its tab open must not lose its code after ROOM_TTL_MS.
    existing.expiresAt = now() + ROOM_TTL_MS;
    return existing;
  }
  const room = { sender: null, receiver: null, createdAt: now(), expiresAt: now() + ROOM_TTL_MS };
  rooms.set(code, room);
  return room;
}

function roomSessionFor(roomId) {
  const existing = roomSessions.get(roomId);
  if (existing && existing.expiresAt > now() && !existing.closed) return existing;
  if (existing) roomSessions.delete(roomId);
  const room = {
    peers: new Map(),
    createdAt: now(),
    expiresAt: now() + ROOM_TTL_MS,
    closed: false,
  };
  roomSessions.set(roomId, room);
  return room;
}

function otherRole(role) {
  return role === "sender" ? "receiver" : "sender";
}

function roomPeers(room) {
  return Array.from(room.peers.values())
    .filter(peer => isOpen(peer.ws))
    .map(peer => ({ peerId: peer.peerId, displayName: peer.displayName }));
}

function broadcastRoom(room, msg, exceptWs) {
  for (const peer of room.peers.values()) {
    if (peer.ws !== exceptWs) send(peer.ws, msg);
  }
}

function leaveRoomPeer(ws) {
  const roomId = ws.publicRoomId;
  const peerId = ws.publicRoomPeerId;
  if (!roomId || !peerId) return;

  const room = roomSessions.get(roomId);
  if (room && room.peers.get(peerId)?.ws === ws) {
    room.peers.delete(peerId);
    broadcastRoom(room, { type: "room-peer-left", roomId, peerId }, ws);
    if (room.peers.size === 0 || room.expiresAt <= now()) roomSessions.delete(roomId);
  }

  ws.publicRoomId = undefined;
  ws.publicRoomPeerId = undefined;
}

function closeRoom(roomId, reason) {
  const room = roomSessions.get(roomId);
  if (!room) return false;
  room.closed = true;
  broadcastRoom(room, { type: "room-closed", roomId, reason }, null);
  for (const peer of room.peers.values()) {
    peer.ws.publicRoomId = undefined;
    peer.ws.publicRoomPeerId = undefined;
  }
  room.peers.clear();
  roomSessions.delete(roomId);
  return true;
}

function dropFor(dropId) {
  const existing = drops.get(dropId);
  if (existing) return existing;
  const drop = { owner: null, contributors: new Map(), expiresAt: 0 };
  drops.set(dropId, drop);
  return drop;
}

function expireDrop(dropId) {
  const drop = drops.get(dropId);
  if (!drop) return;
  for (const ws of [drop.owner, ...drop.contributors.values()]) {
    if (!ws) continue;
    send(ws, { type: "drop-expired", dropId });
    ws.dropId = undefined;
    ws.dropRole = undefined;
    ws.dropPeerId = undefined;
  }
  drops.delete(dropId);
}

function leaveDrop(ws) {
  const dropId = ws.dropId;
  if (!dropId) return;
  const drop = drops.get(dropId);
  if (drop) {
    if (ws.dropRole === "owner" && drop.owner === ws) {
      drop.owner = null;
      for (const c of drop.contributors.values()) send(c, { type: "drop-owner-offline", dropId });
    } else if (ws.dropRole === "contributor" && drop.contributors.get(ws.dropPeerId) === ws) {
      drop.contributors.delete(ws.dropPeerId);
      send(drop.owner, { type: "drop-peer-left", dropId, peerId: ws.dropPeerId });
    }
    // Keep the expiry known while the drop is idle only if an owner set it;
    // an empty drop is forgotten (the expiry is also enforced client-side).
    if (!drop.owner && drop.contributors.size === 0) drops.delete(dropId);
  }
  ws.dropId = undefined;
  ws.dropRole = undefined;
  ws.dropPeerId = undefined;
}

function wallPeerIds(wall) {
  return Array.from(wall.peers.keys());
}

function closeWall(wallId, reason) {
  const wall = walls.get(wallId);
  closedWalls.set(wallId, Math.max(wall?.expiresAt || 0, now() + 60_000));
  if (!wall) return;
  clearTimeout(wall.graceTimer);
  for (const ws of [wall.host, ...wall.peers.values()]) {
    if (!ws) continue;
    send(ws, { type: "wall-closed", wallId, reason });
    ws.wallId = undefined;
    ws.wallRole = undefined;
    ws.wallPeerId = undefined;
  }
  walls.delete(wallId);
}

function leaveWall(ws) {
  const wallId = ws.wallId;
  if (!wallId) return;
  const wall = walls.get(wallId);
  ws.wallId = undefined;
  if (wall) {
    if (ws.wallRole === "host" && wall.host === ws) {
      wall.host = null;
      for (const p of wall.peers.values()) send(p, { type: "wall-host-offline", wallId });
      if (wall.destroyOnHostLeave) {
        // Short grace so a host reconnecting after a network blip keeps the wall.
        clearTimeout(wall.graceTimer);
        wall.graceTimer = setTimeout(() => {
          const w = walls.get(wallId);
          if (w && !isOpen(w.host)) closeWall(wallId, "host-left");
        }, WALL_HOST_GRACE_MS);
        wall.graceTimer.unref?.();
      }
    } else if (ws.wallRole === "peer" && wall.peers.get(ws.wallPeerId) === ws) {
      wall.peers.delete(ws.wallPeerId);
      send(wall.host, { type: "wall-peer-left", wallId, peerId: ws.wallPeerId });
    }
    if (!wall.host && wall.peers.size === 0 && !wall.graceTimer) walls.delete(wallId);
  }
  ws.wallRole = undefined;
  ws.wallPeerId = undefined;
}

function leave(ws) {
  for (const [code, room] of rooms) {
    for (const role of ["sender", "receiver"]) {
      if (room[role] === ws) {
        room[role] = null;
        send(room[otherRole(role)], { type: "peer-left", role });
      }
    }
    if (!room.sender && !room.receiver) rooms.delete(code);
  }
  ws.roomCode = undefined;
  ws.roomRole = undefined;
  leaveRoomPeer(ws);
  leaveDrop(ws);
  leaveWall(ws);
}

// Browser extensions (Filenymous for Chrome/Firefox) connect with their own
// origin. Firefox gives every install a random moz-extension://<uuid>, so an
// ALLOWED_ORIGIN entry "moz-extension://*" (or "chrome-extension://*") accepts
// any id of that extension scheme. Web pages cannot send these origins, so this
// does not open the relay to other web sites; http(s) wildcards are not supported.
const EXTENSION_ORIGIN_RE = /^(chrome-extension|moz-extension):\/\/[A-Za-z0-9-]{1,64}$/;

function originAllowedBy(list, origin) {
  if (!list.length) return true;
  if (typeof origin !== "string") return false;
  if (list.includes(origin)) return true;
  const m = origin.match(EXTENSION_ORIGIN_RE);
  return !!m && list.includes(`${m[1]}://*`);
}

function originAllowed(origin) {
  return originAllowedBy(allowedOrigins, origin);
}

function iceServers() {
  const servers = [];
  if (STUN_URLS.length) servers.push({ urls: STUN_URLS });
  if (TURN_URLS.length) {
    if (TURN_SECRET) {
      // Unique per request: coturn quotas (user-quota) are per username, so a
      // shared "<expiry>:filenymous" made two peers fetching in the same second
      // compete for one quota and the second allocation could be refused.
      const username = `${Math.floor(now() / 1000) + TURN_TTL_S}:fn-${randomBytes(6).toString("hex")}`;
      const credential = createHmac("sha1", TURN_SECRET).update(username).digest("base64");
      servers.push({ urls: TURN_URLS, username, credential });
    } else if (process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
      servers.push({ urls: TURN_URLS, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
    }
  }
  return servers;
}

const vault = createVault({ clientIp });
// Reports reuse the KV only through their own module; IPs are never stored (see reports.js).
const reports = createReports({ clientIp, securityHeaders: SECURITY_HEADERS });

function httpHandler(req, res) {
  const path = (req.url || "/").split("?")[0].replace(/^\/filenymous-signal/, "") || "/";
  const origin = req.headers.origin;
  const headers = { "content-type": "application/json", "cache-control": "no-store", vary: "Origin" };
  if (origin && originAllowed(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-methods"] = "GET, OPTIONS";
  }
  if (path.startsWith("/api/v1/secrets") || path.startsWith("/api/v1/reports")) {
    if (origin && !originAllowed(origin)) {
      res.writeHead(403, headers);
      return res.end(JSON.stringify({ error: "origin-not-allowed" }));
    }
    (path.startsWith("/api/v1/reports") ? reports : vault).handle(req, res, path, headers);
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, headers);
    return res.end();
  }
  if (req.method === "GET" && (path === "/health" || path === "/healthz")) {
    res.writeHead(200, headers);
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size, roomSessions: roomSessions.size, drops: drops.size, walls: walls.size, turn: TURN_URLS.length > 0 }));
  }
  if (req.method === "GET" && path === "/ice") {
    if (origin && !originAllowed(origin)) {
      res.writeHead(403, headers);
      return res.end(JSON.stringify({ error: "origin-not-allowed" }));
    }
    res.writeHead(200, headers);
    return res.end(JSON.stringify({ iceServers: iceServers(), ttl: TURN_TTL_S }));
  }
  res.writeHead(426, { "content-type": "text/plain; charset=utf-8" });
  res.end("Upgrade Required");
}

const httpServer = createServer(httpHandler);
const wss = new WebSocketServer({
  server: httpServer,
  verifyClient(info, done) {
    // Browsers always send Origin, so ALLOWED_ORIGIN still blocks other web
    // sites; non-browser clients (the Filenymous CLI) send none and are allowed.
    done(!info.origin || originAllowed(info.origin));
  },
});

const pingTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, PING_INTERVAL_MS);
pingTimer.unref?.();

const wallSweepTimer = setInterval(() => {
  const t = now();
  for (const [wallId, wall] of walls) {
    if (wall.expiresAt && wall.expiresAt <= t) closeWall(wallId, "expired");
  }
  for (const [wallId, until] of closedWalls) if (until <= t) closedWalls.delete(wallId);
}, WALL_SWEEP_MS);
wallSweepTimer.unref?.();

const dropSweepTimer = setInterval(() => {
  const t = now();
  for (const [dropId, drop] of drops) {
    if (drop.expiresAt && drop.expiresAt <= t) expireDrop(dropId);
  }
}, DROP_SWEEP_MS);
dropSweepTimer.unref?.();

wss.on("connection", (ws, req) => {
  ws.clientIp = clientIp(req);
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: "error", error: "invalid-json" });
      return;
    }

    if (!checkRateLimit(ws)) {
      send(ws, { type: "error", error: "rate-limited" });
      return;
    }

    if (msg.type === "join") {
      const { code, role } = msg;
      if (!validateOneTimeCode(code) || !["sender", "receiver"].includes(role)) {
        send(ws, { type: "error", error: "invalid-room" });
        return;
      }
      leave(ws);
      const room = roomFor(code);
      const stale = room[role] && room[role].readyState !== WebSocket.OPEN;
      if (room[role] && !stale && room[role] !== ws) {
        send(ws, { type: "error", error: "role-taken" });
        return;
      }

      room[role] = ws;
      ws.roomCode = code;
      ws.roomRole = role;
      send(ws, { type: "joined", code, role });
      send(room[otherRole(role)], { type: "peer-joined", role });
      return;
    }

    if (msg.type === "room-join") {
      const { roomId, peerId, displayName } = msg;
      if (!validateRoomId(roomId) || !validateRoomPeerId(peerId) || !validateDisplayName(displayName)) {
        send(ws, { type: "error", error: "invalid-room" });
        return;
      }

      leaveRoomPeer(ws);
      const room = roomSessionFor(roomId);
      const existingPeer = room.peers.get(peerId);
      const stale = existingPeer && !isOpen(existingPeer.ws);
      if (existingPeer && !stale && existingPeer.ws !== ws) {
        send(ws, { type: "error", error: "room-peer-taken" });
        return;
      }
      if (!existingPeer && room.peers.size >= MAX_ROOM_PEERS) {
        send(ws, { type: "error", error: "room-full" });
        return;
      }

      const peer = {
        ws,
        peerId,
        displayName: cleanDisplayName(displayName),
        joinedAt: now(),
      };
      room.peers.set(peerId, peer);
      ws.publicRoomId = roomId;
      ws.publicRoomPeerId = peerId;
      send(ws, { type: "room-joined", roomId, peerId, peers: roomPeers(room), expiresAt: room.expiresAt });
      broadcastRoom(room, { type: "room-peer-joined", roomId, peer: { peerId, displayName: peer.displayName } }, ws);
      return;
    }

    if (msg.type === "room-event") {
      const { roomId, event } = msg;
      const room = roomSessions.get(roomId);
      if (!validateRoomId(roomId) || !validateRoomEvent(event)) {
        send(ws, { type: "error", error: "invalid-room-event" });
        return;
      }
      if (!room || room.closed || room.expiresAt <= now() || ws.publicRoomId !== roomId || !ws.publicRoomPeerId) {
        send(ws, { type: "error", error: "not-in-room" });
        return;
      }
      if (room.peers.get(ws.publicRoomPeerId)?.ws !== ws) {
        send(ws, { type: "error", error: "not-in-room" });
        return;
      }

      const peers = roomPeers(room).filter(peer => peer.peerId !== ws.publicRoomPeerId);
      if (!peers.length) send(ws, { type: "room-waiting", roomId, peers: 0 });
      broadcastRoom(room, { type: "room-event", roomId, from: ws.publicRoomPeerId, event }, ws);
      return;
    }

    if (msg.type === "room-close") {
      const { roomId } = msg;
      const reason = typeof msg.reason === "string" && msg.reason.length <= 64 ? msg.reason : "closed";
      const room = roomSessions.get(roomId);
      if (!validateRoomId(roomId) || !room || ws.publicRoomId !== roomId || !ws.publicRoomPeerId) {
        send(ws, { type: "error", error: "not-in-room" });
        return;
      }
      closeRoom(roomId, reason);
      return;
    }

    if (msg.type === "room-leave") {
      leaveRoomPeer(ws);
      send(ws, { type: "room-left" });
      return;
    }

    if (msg.type === "drop-join") {
      const { dropId, role } = msg;
      if (!validateDropId(dropId) || !["owner", "contributor"].includes(role)) {
        send(ws, { type: "error", error: "invalid-drop" });
        return;
      }
      const existing = drops.get(dropId);
      if (existing?.expiresAt && existing.expiresAt <= now()) {
        expireDrop(dropId);
        send(ws, { type: "error", error: "drop-expired" });
        return;
      }
      if (role === "owner") {
        if (dropIdForOwnerSecret(msg.ownerSecret) !== dropId) {
          send(ws, { type: "error", error: "drop-owner-denied" });
          return;
        }
        const requested = Number(msg.expiresAt);
        const maxAt = now() + DROP_MAX_TTL_MS;
        const expiresAt = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, maxAt) : now() + DROP_DEFAULT_TTL_MS;
        if (expiresAt <= now()) {
          send(ws, { type: "error", error: "drop-expired" });
          return;
        }
        leave(ws);
        const drop = dropFor(dropId);
        if (drop.owner && drop.owner !== ws) {
          // Holding the owner secret is the authority: the newest owner tab
          // (e.g. after a reload whose old socket is not yet timed out) wins.
          const previous = drop.owner;
          previous.dropId = undefined;
          previous.dropRole = undefined;
          send(previous, { type: "error", error: "drop-owner-replaced" });
        }
        drop.owner = ws;
        drop.expiresAt = expiresAt;
        ws.dropId = dropId;
        ws.dropRole = "owner";
        send(ws, { type: "drop-joined", dropId, role, expiresAt, contributors: Array.from(drop.contributors.keys()) });
        for (const c of drop.contributors.values()) send(c, { type: "drop-owner-online", dropId });
        return;
      }
      const { peerId } = msg;
      if (!validateRoomPeerId(peerId)) {
        send(ws, { type: "error", error: "invalid-drop" });
        return;
      }
      leave(ws);
      const drop = dropFor(dropId);
      const current = drop.contributors.get(peerId);
      if (current && isOpen(current) && current !== ws) {
        send(ws, { type: "error", error: "drop-peer-taken" });
        return;
      }
      if (!current && drop.contributors.size >= MAX_DROP_CONTRIBUTORS) {
        send(ws, { type: "error", error: "drop-full" });
        return;
      }
      drop.contributors.set(peerId, ws);
      ws.dropId = dropId;
      ws.dropRole = "contributor";
      ws.dropPeerId = peerId;
      const ownerOnline = !!isOpen(drop.owner);
      // Contributors never learn about each other: only the owner is told.
      send(ws, { type: "drop-joined", dropId, role, ownerOnline });
      if (ownerOnline) send(drop.owner, { type: "drop-peer-joined", dropId, peerId });
      return;
    }

    if (msg.type === "drop-signal") {
      const { payload } = msg;
      if (!validateSignalPayload(payload)) {
        send(ws, { type: "error", error: "unsupported-signal-payload" });
        return;
      }
      const drop = ws.dropId ? drops.get(ws.dropId) : null;
      if (!drop) {
        send(ws, { type: "error", error: "not-in-drop" });
        return;
      }
      if (ws.dropRole === "owner") {
        const target = drop.contributors.get(msg.to);
        if (!isOpen(target)) {
          send(ws, { type: "drop-peer-left", dropId: ws.dropId, peerId: msg.to });
          return;
        }
        send(target, { type: "drop-signal", payload });
        return;
      }
      if (!isOpen(drop.owner)) {
        send(ws, { type: "drop-owner-offline", dropId: ws.dropId });
        return;
      }
      send(drop.owner, { type: "drop-signal", from: ws.dropPeerId, payload });
      return;
    }

    if (msg.type === "drop-leave") {
      leaveDrop(ws);
      send(ws, { type: "drop-left" });
      return;
    }

    if (msg.type === "wall-join") {
      const { wallId, role } = msg;
      // Strict shape: the relay accepts no extra field (never a key or a name).
      const allowed = role === "host" ? ["type", "wallId", "role", "hostSecret", "expiresAt", "destroyOnHostLeave"] : ["type", "wallId", "role", "peerId"];
      if (!validateWallId(wallId) || !["host", "peer"].includes(role) || !hasOnlyKeys(msg, allowed)) {
        send(ws, { type: "error", error: "invalid-wall" });
        return;
      }
      if (closedWalls.has(wallId)) {
        send(ws, { type: "error", error: "wall-closed" });
        return;
      }
      const existing = walls.get(wallId);
      if (existing?.expiresAt && existing.expiresAt <= now()) {
        closeWall(wallId, "expired");
        send(ws, { type: "error", error: "wall-closed" });
        return;
      }
      if (role === "host") {
        if (wallIdForHostSecret(msg.hostSecret) !== wallId) {
          send(ws, { type: "error", error: "wall-host-denied" });
          return;
        }
        const requested = Number(msg.expiresAt);
        if (!Number.isSafeInteger(requested) || requested <= now()) {
          send(ws, { type: "error", error: "wall-closed" });
          return;
        }
        leave(ws);
        let wall = walls.get(wallId);
        if (!wall) {
          wall = { host: null, peers: new Map(), expiresAt: 0, destroyOnHostLeave: false, graceTimer: undefined };
          walls.set(wallId, wall);
        }
        if (wall.host && wall.host !== ws) {
          const previous = wall.host;
          previous.wallId = undefined;
          previous.wallRole = undefined;
          send(previous, { type: "error", error: "wall-host-replaced" });
        }
        clearTimeout(wall.graceTimer);
        wall.graceTimer = undefined;
        // First host join fixes the expiry (capped); a reconnecting host can't extend it.
        const capped = Math.min(requested, now() + WALL_MAX_TTL_MS);
        wall.expiresAt = wall.expiresAt ? Math.min(wall.expiresAt, capped) : capped;
        wall.destroyOnHostLeave = msg.destroyOnHostLeave === true;
        wall.host = ws;
        ws.wallId = wallId;
        ws.wallRole = "host";
        send(ws, { type: "wall-joined", wallId, role, expiresAt: wall.expiresAt, peers: wallPeerIds(wall) });
        for (const p of wall.peers.values()) send(p, { type: "wall-host-online", wallId });
        return;
      }
      const { peerId } = msg;
      if (!validateRoomPeerId(peerId)) {
        send(ws, { type: "error", error: "invalid-wall" });
        return;
      }
      leave(ws);
      let wall = walls.get(wallId);
      if (!wall) {
        wall = { host: null, peers: new Map(), expiresAt: 0, destroyOnHostLeave: false, graceTimer: undefined };
        walls.set(wallId, wall);
      }
      const current = wall.peers.get(peerId);
      if (current && isOpen(current) && current !== ws) {
        send(ws, { type: "error", error: "wall-peer-taken" });
        return;
      }
      if (!current && wall.peers.size >= MAX_WALL_PEERS) {
        send(ws, { type: "error", error: "wall-full" });
        if (!wall.host && wall.peers.size === 0) walls.delete(wallId);
        return;
      }
      wall.peers.set(peerId, ws);
      ws.wallId = wallId;
      ws.wallRole = "peer";
      ws.wallPeerId = peerId;
      const hostOnline = !!isOpen(wall.host);
      // Peers never learn about each other from the relay: only the host is told.
      send(ws, { type: "wall-joined", wallId, role, hostOnline });
      if (hostOnline) send(wall.host, { type: "wall-peer-joined", wallId, peerId });
      return;
    }

    if (msg.type === "wall-signal") {
      const { payload } = msg;
      if (!validateSignalPayload(payload) || !hasOnlyKeys(msg, ["type", "payload", "to"])) {
        send(ws, { type: "error", error: "unsupported-signal-payload" });
        return;
      }
      const wall = ws.wallId ? walls.get(ws.wallId) : null;
      if (!wall) {
        send(ws, { type: "error", error: "not-in-wall" });
        return;
      }
      if (ws.wallRole === "host") {
        const target = wall.peers.get(msg.to);
        if (!isOpen(target)) {
          send(ws, { type: "wall-peer-left", wallId: ws.wallId, peerId: msg.to });
          return;
        }
        send(target, { type: "wall-signal", payload });
        return;
      }
      if (!isOpen(wall.host)) {
        send(ws, { type: "wall-host-offline", wallId: ws.wallId });
        return;
      }
      send(wall.host, { type: "wall-signal", from: ws.wallPeerId, payload });
      return;
    }

    if (msg.type === "wall-close") {
      // Kill switch: only the current host socket can close its wall.
      const wallId = ws.wallId;
      const wall = wallId ? walls.get(wallId) : null;
      if (!wall || ws.wallRole !== "host" || wall.host !== ws) {
        send(ws, { type: "error", error: "not-wall-host" });
        return;
      }
      closeWall(wallId, "destroyed");
      return;
    }

    if (msg.type === "wall-leave") {
      leaveWall(ws);
      send(ws, { type: "wall-left" });
      return;
    }

    if (msg.type === "signal") {
      const { code, payload } = msg;
      if (!validateSignalPayload(payload)) {
        send(ws, { type: "error", error: "unsupported-signal-payload" });
        return;
      }
      if (!validateOneTimeCode(code) || ws.roomCode !== code || !ws.roomRole) {
        send(ws, { type: "error", error: "not-in-room" });
        return;
      }
      const room = rooms.get(code);
      const peer = room?.[otherRole(ws.roomRole)];
      if (!isOpen(peer)) {
        send(ws, { type: "waiting", role: otherRole(ws.roomRole) });
        return;
      }
      send(peer, { type: "signal", payload });
      return;
    }

    if (msg.type === "leave") {
      leave(ws);
      send(ws, { type: "left" });
      return;
    }

    send(ws, { type: "error", error: "unknown-type" });
  });

  ws.on("close", () => leave(ws));
  ws.on("error", () => leave(ws));
});

httpServer.listen(port, () => {
  console.log(`Filenymous p2p-signal listening on :${port}`);
});

export { dropIdForOwnerSecret, validateDropId, validateWallId, wallIdForHostSecret, validateOneTimeCode, validateRoomEvent, validateRoomId, validateSignalPayload };
