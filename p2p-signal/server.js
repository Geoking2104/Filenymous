import { WebSocketServer, WebSocket } from "ws";

const port = Number(process.env.PORT || 8789);
const allowedOrigin = process.env.ALLOWED_ORIGIN || "";
const rooms = new Map();

function validateOneTimeCode(code) {
  return typeof code === "string" && /^\d{3}-\d{3}$/.test(code);
}

function isOpen(peer) {
  return peer && peer.readyState === WebSocket.OPEN;
}

function send(ws, msg) {
  if (isOpen(ws)) ws.send(JSON.stringify(msg));
}

function roomFor(code) {
  if (!rooms.has(code)) rooms.set(code, { sender: null, receiver: null });
  return rooms.get(code);
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

export { validateOneTimeCode };
