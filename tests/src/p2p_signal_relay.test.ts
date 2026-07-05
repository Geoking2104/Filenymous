import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { WebSocket } from "ws";

const root = resolve(__dirname, "..", "..");
const serverPath = resolve(root, "p2p-signal/server.js");
const allowedOrigin = "https://filenymous.eu";

let child: ChildProcessWithoutNullStreams | undefined;

async function freePort() {
  const server = createServer();
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port allocated");
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close(err => (err ? rejectClose(err) : resolveClose()));
  });
  return address.port;
}

async function startRelay(port: number) {
  child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      ALLOWED_ORIGIN: `${allowedOrigin},https://geoking2104.github.io`,
    },
  });

  let output = "";
  child.stdout.on("data", chunk => { output += chunk.toString(); });
  child.stderr.on("data", chunk => { output += chunk.toString(); });

  await new Promise<void>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`Relay did not start: ${output}`)), 5_000);
    child?.stdout.on("data", chunk => {
      if (chunk.toString().includes(`:${port}`)) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    child?.once("exit", code => {
      clearTimeout(timer);
      rejectReady(new Error(`Relay exited early with ${code}: ${output}`));
    });
  });
}

function join(url: string, role: "sender" | "receiver", code: string) {
  return new Promise<WebSocket>((resolveJoin, rejectJoin) => {
    const ws = new WebSocket(url, { origin: allowedOrigin });
    const timer = setTimeout(() => rejectJoin(new Error(`${role} join timed out`)), 5_000);

    ws.on("open", () => ws.send(JSON.stringify({ type: "join", code, role })));
    ws.on("message", raw => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "joined") {
        clearTimeout(timer);
        resolveJoin(ws);
      }
      if (msg.type === "error") {
        clearTimeout(timer);
        rejectJoin(new Error(msg.error));
      }
    });
    ws.on("error", rejectJoin);
  });
}

function nextMessage<T extends Record<string, unknown>>(
  ws: WebSocket,
  predicate: (msg: T) => boolean,
  label: string,
) {
  return new Promise<T>((resolveMessage, rejectMessage) => {
    const timer = setTimeout(() => rejectMessage(new Error(`${label} timed out`)), 5_000);
    const handler = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(raw.toString()) as T;
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolveMessage(msg);
      }
    };
    ws.on("message", handler);
  });
}

function joinRoom(url: string, roomId: string, peerId: string, displayName: string) {
  return new Promise<{ ws: WebSocket; joined: Record<string, unknown> }>((resolveJoin, rejectJoin) => {
    const ws = new WebSocket(url, { origin: allowedOrigin });
    const timer = setTimeout(() => rejectJoin(new Error(`${peerId} room join timed out`)), 5_000);

    ws.on("open", () => ws.send(JSON.stringify({ type: "room-join", roomId, peerId, displayName })));
    ws.on("message", raw => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "room-joined") {
        clearTimeout(timer);
        resolveJoin({ ws, joined: msg });
      }
      if (msg.type === "error") {
        clearTimeout(timer);
        rejectJoin(new Error(msg.error));
      }
    });
    ws.on("error", rejectJoin);
  });
}

afterEach(async () => {
  if (child && !child.killed) {
    child.kill();
    await new Promise(resolveExit => child?.once("exit", resolveExit));
  }
  child = undefined;
});

describe("P2P signaling relay integration", () => {
  it("keeps the sender room registered and relays an offer to the receiver", async () => {
    const port = await freePort();
    await startRelay(port);

    const code = "456-789-QTZ";
    const sender = await join(`ws://127.0.0.1:${port}`, "sender", code);
    const receiver = await join(`ws://127.0.0.1:${port}`, "receiver", code);

    const relayed = new Promise<Record<string, string>>((resolveSignal, rejectSignal) => {
      const timer = setTimeout(() => rejectSignal(new Error("Relay timed out")), 5_000);
      receiver.on("message", raw => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "signal") {
          clearTimeout(timer);
          resolveSignal(msg.payload);
        }
      });
    });

    sender.send(JSON.stringify({
      type: "signal",
      code,
      payload: { kind: "offer", sdp: "v=0\r\n" },
    }));

    await expect(relayed).resolves.toEqual({ kind: "offer", sdp: "v=0\r\n" });
    sender.close();
    receiver.close();
  });

  it("tracks live room presence and relays encrypted room events", async () => {
    const port = await freePort();
    await startRelay(port);
    const url = `ws://127.0.0.1:${port}`;
    const roomId = "room-testabc";

    const alice = await joinRoom(url, roomId, "alice", "Alice");
    expect(alice.joined).toMatchObject({
      type: "room-joined",
      roomId,
      peerId: "alice",
      peers: [{ peerId: "alice", displayName: "Alice" }],
    });

    const bobJoinedNotice = nextMessage(alice.ws, msg => msg.type === "room-peer-joined", "bob joined notice");
    const bob = await joinRoom(url, roomId, "bob", "Bob");
    expect(bob.joined).toMatchObject({
      type: "room-joined",
      roomId,
      peerId: "bob",
      peers: [
        { peerId: "alice", displayName: "Alice" },
        { peerId: "bob", displayName: "Bob" },
      ],
    });
    await expect(bobJoinedNotice).resolves.toMatchObject({
      type: "room-peer-joined",
      roomId,
      peer: { peerId: "bob", displayName: "Bob" },
    });

    const chatRelayed = nextMessage(bob.ws, msg => msg.type === "room-event", "room event");
    alice.ws.send(JSON.stringify({
      type: "room-event",
      roomId,
      event: { kind: "chat", iv: "iv-b64", ciphertext: "cipher-b64" },
    }));
    await expect(chatRelayed).resolves.toMatchObject({
      type: "room-event",
      roomId,
      from: "alice",
      event: { kind: "chat", iv: "iv-b64", ciphertext: "cipher-b64" },
    });

    const bobLeft = nextMessage(alice.ws, msg => msg.type === "room-peer-left", "bob left notice");
    bob.ws.close();
    await expect(bobLeft).resolves.toMatchObject({
      type: "room-peer-left",
      roomId,
      peerId: "bob",
    });

    alice.ws.close();
  });

  it("closes a room and rejects events after revocation", async () => {
    const port = await freePort();
    await startRelay(port);
    const url = `ws://127.0.0.1:${port}`;
    const roomId = "room-closeabc";

    const alice = await joinRoom(url, roomId, "alice", "Alice");
    const bob = await joinRoom(url, roomId, "bob", "Bob");
    const closedForBob = nextMessage(bob.ws, msg => msg.type === "room-closed", "room closed");
    const closedForAlice = nextMessage(alice.ws, msg => msg.type === "room-closed", "room closed self");

    alice.ws.send(JSON.stringify({ type: "room-close", roomId, reason: "done" }));

    await expect(closedForBob).resolves.toMatchObject({ type: "room-closed", roomId, reason: "done" });
    await expect(closedForAlice).resolves.toMatchObject({ type: "room-closed", roomId, reason: "done" });

    const rejectedEvent = nextMessage(alice.ws, msg => msg.type === "error", "rejected room event");
    alice.ws.send(JSON.stringify({
      type: "room-event",
      roomId,
      event: { kind: "chat", iv: "iv-b64", ciphertext: "cipher-b64" },
    }));
    await expect(rejectedEvent).resolves.toMatchObject({ type: "error", error: "not-in-room" });

    alice.ws.close();
    bob.ws.close();
  });
});
