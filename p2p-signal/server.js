import { WebSocketServer, WebSocket } from "ws";

const port = Number(process.env.PORT || 8789);
const allowedOrigin = process.env.ALLOWED_ORIGIN || "";
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 10 * 60 * 1000);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 10_000);
const RATE_LIMIT_MAX_MESSAGES = Number(process.env.RATE_LIMIT_MAX_MESSAGES || 60);
const MAX_SIGNAL_SDP_BYTES = Number(process.env.MAX_SIGNAL_SDP_BYTES || 64_000);
const MAX_SIGNAL_ICE_BYTES = Number(process.env.MAX_SIGNAL_ICE_BYTES || 16_000);
const rooms = new Map();
const rateLimits = new Map();

function now() {
  return Date.now();
}

function validateOneTimeCode(code) {
  return typeof code === "string" && /^\d{3}-\d{3}$/.test(code);
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

function checkRateLimit(ws) {
  const key = ws._socket?.remoteAddress || "unknown";
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
  if (existing && existing.expiresAt > now()) return existing;
  const room = { sender: null, receiver: null, createdAt: now(), expiresAt: now() + ROOM_TTL_MS };
  rooms.set(code, room);
  return room;
}

function otherRole(role) {
  return role === "sender" ? "receiver" : "sender";
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
}

const wss = new WebSocketServer({
  port,
  verifyClient(info, done) {
    if (!allowedOrigin) return done(true);
    done(info.origin === allowedOrigin);
  },
});

wss.on("connection", ws => {
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
      const room = roomFor(code);
      const stale = room[role] && room[role].readyState !== WebSocket.OPEN;
      if (room[role] && !stale && room[role] !== ws) {
        send(ws, { type: "error", error: "role-taken" });
        return;
      }

      leave(ws);
      room[role] = ws;
      ws.roomCode = code;
      ws.roomRole = role;
      send(ws, { type: "joined", code, role });
      send(room[otherRole(role)], { type: "peer-joined", role });
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

console.log(`Filenymous p2p-signal listening on :${port}`);

export { validateOneTimeCode, validateSignalPayload };
