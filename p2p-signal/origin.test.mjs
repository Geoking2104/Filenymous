// ALLOWED_ORIGIN: other web origins are refused, Origin-less clients (CLI) are accepted.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const PORT = 19900 + Math.floor(Math.random() * 90);
let relay;
before(async () => {
  relay = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], {
    env: { ...process.env, PORT: String(PORT), ALLOWED_ORIGIN: "https://filenymous.eu" },
    stdio: "pipe",
  });
  await new Promise((ok, ko) => {
    const t = setTimeout(() => ko(new Error("relay did not start")), 10_000);
    relay.stdout.on("data", d => { if (String(d).includes("listening")) { clearTimeout(t); ok(); } });
  });
});
after(() => relay?.kill());

const attempt = (headers) => new Promise((ok) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers });
  ws.on("open", () => { ws.close(); ok("open"); });
  ws.on("unexpected-response", (_q, r) => ok(r.statusCode));
  ws.on("error", () => ok("error"));
});

test("allowed origin connects", async () => assert.equal(await attempt({ origin: "https://filenymous.eu" }), "open"));
test("foreign origin is refused", async () => assert.equal(await attempt({ origin: "https://evil.example" }), 401));
test("no origin (CLI) connects", async () => assert.equal(await attempt({}), "open"));
