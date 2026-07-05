import { WebSocketServer, WebSocket } from "ws";

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
const rooms = new Map();
const roomSessions = new Map();
const rateLimits = new Map();

function now() {
  return Date.now();
}

function validateOneTimeCode(code) {
  return typeof code === "string" && /^\d{3}-\d{3}-[A-Z]{3}$/.test(code);
}

function validateRoomId(roomId) {
  return typeof roomId === "string" && /^room-[a-z0-9]{6,32}$/i.test(roomId);
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
}

const wss = new WebSocketServer({
  port,
  verifyClient(info, done) {
    if (!allowedOrigins.length) return done(true);
    done(allowedOrigins.includes(info.origin));
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

export { validateOneTimeCode, validateRoomEvent, validateRoomId, validateSignalPayload };
