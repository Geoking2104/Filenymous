// Browser-extension origins: accepted only through explicit "chrome-extension://*",
// "moz-extension://*" or exact-id entries in ALLOWED_ORIGIN; web sites stay refused.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const CHROME_ID = "abcdefghijklmnopabcdefghijklmnop";
const relays = {};

async function start(name, allowed) {
  const port = 19000 + Math.floor(Math.random() * 800);
  const proc = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], {
    env: { ...process.env, PORT: String(port), ALLOWED_ORIGIN: allowed, REDIS_URL: "" },
    stdio: "pipe",
  });
  await new Promise((ok, ko) => {
    const t = setTimeout(() => ko(new Error("relay did not start")), 10_000);
    proc.stdout.on("data", d => { if (String(d).includes("listening")) { clearTimeout(t); ok(); } });
  });
  relays[name] = { proc, port };
}

before(async () => {
  await start("wild", `https://filenymous.eu,chrome-extension://*,moz-extension://*`);
  await start("exact", `https://filenymous.eu,chrome-extension://${CHROME_ID}`);
  await start("web", `https://filenymous.eu`);
});
after(() => Object.values(relays).forEach(r => r.proc.kill()));

const ws = (name, origin) => new Promise((ok) => {
  const s = new WebSocket(`ws://127.0.0.1:${relays[name].port}`, { headers: origin ? { origin } : {} });
  s.on("open", () => { s.close(); ok("open"); });
  s.on("unexpected-response", (_q, r) => ok(r.statusCode));
  s.on("error", () => ok("error"));
});
const ice = async (name, origin) => {
  const r = await fetch(`http://127.0.0.1:${relays[name].port}/ice`, { headers: { origin } });
  return { status: r.status, acao: r.headers.get("access-control-allow-origin") };
};
const vaultPreflight = async (name, origin) => {
  const r = await fetch(`http://127.0.0.1:${relays[name].port}/api/v1/secrets`, { method: "OPTIONS", headers: { origin } });
  return { status: r.status, acao: r.headers.get("access-control-allow-origin") };
};

const FX = "moz-extension://0b4e1c6a-5d2f-4c3e-9a8b-7f6e5d4c3b2a";

test("scheme wildcards accept Chrome and Firefox extensions (WebSocket, /ice, vault CORS)", async () => {
  assert.equal(await ws("wild", `chrome-extension://${CHROME_ID}`), "open");
  assert.equal(await ws("wild", FX), "open");
  assert.deepEqual(await ice("wild", FX), { status: 200, acao: FX });
  assert.deepEqual(await vaultPreflight("wild", `chrome-extension://${CHROME_ID}`), { status: 204, acao: `chrome-extension://${CHROME_ID}` });
});

test("scheme wildcards never match web origins or malformed extension origins", async () => {
  assert.equal(await ws("wild", "https://evil.example"), 401);
  assert.equal(await ws("wild", "http://chrome-extension.evil.example"), 401);
  assert.equal(await ws("wild", "chrome-extension://abc/../x"), 401);
  assert.equal(await ws("wild", "safari-web-extension://abc"), 401);
  assert.equal((await ice("wild", "https://evil.example")).status, 403);
  assert.equal((await vaultPreflight("wild", "https://evil.example")).status, 403);
});

test("an exact extension id accepts only that id", async () => {
  assert.equal(await ws("exact", `chrome-extension://${CHROME_ID}`), "open");
  assert.equal(await ws("exact", `chrome-extension://${"z".repeat(32)}`), 401);
  assert.equal(await ws("exact", FX), 401);
});

test("without an extension entry, extensions stay refused (current production behaviour)", async () => {
  assert.equal(await ws("web", `chrome-extension://${CHROME_ID}`), 401);
  assert.equal((await ice("web", FX)).status, 403);
  assert.equal(await ws("web", "https://filenymous.eu"), "open");
  assert.equal(await ws("web"), "open");
});
