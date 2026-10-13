import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WebSocket } from "ws";

const root = resolve(__dirname, "..", "..");
const serverPath = resolve(root, "p2p-signal/server.js");
let child: ChildProcessWithoutNullStreams | undefined;

async function freePort() {
  const server = createServer();
  await new Promise<void>(ok => server.listen(0, "127.0.0.1", ok));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  await new Promise<void>(ok => server.close(() => ok()));
  return address.port;
}

async function startRelay(port: number, env: Record<string, string> = {}) {
  child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: { ...process.env, PORT: String(port), ALLOWED_ORIGIN: "https://filenymous.eu", ...env },
  });
  await new Promise<void>((ok, ko) => {
    const timer = setTimeout(() => ko(new Error("relay did not start")), 5_000);
    child!.stdout.on("data", c => {
      if (String(c).includes(`:${port}`)) {
        clearTimeout(timer);
        ok();
      }
    });
  });
}

afterEach(() => {
  child?.kill();
  child = undefined;
});

describe("p2p-signal HTTP endpoints", () => {
  it("serves /health (also under the nginx /filenymous-signal prefix)", async () => {
    const port = await freePort();
    await startRelay(port);
    for (const path of ["/health", "/filenymous-signal/health"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
    }
    expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(426);
  });

  it("issues short-lived TURN REST credentials on /ice, with CORS for allowed origins only", async () => {
    const port = await freePort();
    await startRelay(port, { TURN_URLS: "turn:turn.example.org:3478", TURN_SECRET: "s3cret", STUN_URLS: "stun:stun.example.org:3478" });
    const res = await fetch(`http://127.0.0.1:${port}/ice`, { headers: { origin: "https://filenymous.eu" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://filenymous.eu");
    const body = await res.json();
    const turn = body.iceServers.find((s: { urls: string[] }) => s.urls[0]!.startsWith("turn:"));
    expect(body.iceServers[0].urls).toEqual(["stun:stun.example.org:3478"]);
    expect(turn.username).toMatch(/^\d+:filenymous$/);
    expect(turn.credential).toBe(createHmac("sha1", "s3cret").update(turn.username).digest("base64"));
    expect(Number(turn.username.split(":")[0])).toBeGreaterThan(Date.now() / 1000);

    const denied = await fetch(`http://127.0.0.1:${port}/ice`, { headers: { origin: "https://evil.example" } });
    expect(denied.status).toBe(403);
  });

  it("still rejects WebSocket upgrades from unknown origins", async () => {
    const port = await freePort();
    await startRelay(port);
    const err = await new Promise<string>(ok => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "https://evil.example" });
      ws.on("open", () => ok("open"));
      ws.on("error", e => ok(String(e.message)));
    });
    expect(err).toContain("401");
  });

  it("keeps per-client rate limiting behind a proxy and ships deploy hints", () => {
    const server = readFileSync(serverPath, "utf8");
    expect(server).toContain("TRUST_PROXY");
    expect(server).toContain("x-real-ip");
    const unit = readFileSync(resolve(root, "p2p-signal/filenymous-signal.service"), "utf8");
    expect(unit).toContain("TRUST_PROXY=1");
    const nginx = readFileSync(resolve(root, "p2p-signal/nginx-opendpe-location.conf"), "utf8");
    expect(nginx).toContain("proxy_set_header Upgrade $http_upgrade");
    expect(nginx).toContain("X-Real-IP");
  });
});
