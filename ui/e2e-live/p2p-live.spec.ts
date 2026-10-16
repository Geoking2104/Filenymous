/**
 * Opt-in live check (not in CI): two browsers against https://filenymous.eu/app/ + live relay/TURN.
 *   npx playwright test -c playwright.live-p2p.config.ts
 * Env: LOCAL_DIST=dist (serve a local build at the live origin), RELAY_ONLY=1 (force TURN), CLICK_DELAY_MS.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
const BASE = process.env.LIVE_BASE || "https://filenymous.eu/app/";
const DELAY = Number(process.env.CLICK_DELAY_MS || 0);
const RELAY = process.env.RELAY_ONLY === "1";

import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
// LOCAL_DIST=../dist → serve this build in place of https://filenymous.eu/app/*
// (same origin, so the live relay + TURN accept it).
const LOCAL_DIST = process.env.LOCAL_DIST;
const MIME: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm", ".webmanifest": "application/manifest+json" };

async function prep(page: Page, tag: string, noPicker = false) {
  if (LOCAL_DIST) {
    await page.route("https://filenymous.eu/app/**", async (route) => {
      const path = new URL(route.request().url()).pathname.replace(/^\/app\//, "") || "index.html";
      const file = join(LOCAL_DIST, path);
      const target = existsSync(file) && !file.endsWith("/") ? file : join(LOCAL_DIST, "index.html");
      await route.fulfill({ body: readFileSync(target), contentType: MIME[extname(target)] || "application/octet-stream" });
    });
  }
  page.on("console", (m) => console.log(`[${tag}] ${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => console.log(`[${tag}] PAGEERROR ${e.message}`));
  await page.addInitScript(([strip, relay]) => {
    if (strip) { delete (window as any).showSaveFilePicker; delete (window as any).showDirectoryPicker; }
    {
      const O0 = window.RTCPeerConnection;
      let n = 0;
      const W = function (cfg: RTCConfiguration) {
        const pc = new O0(cfg); const id = ++n;
        console.log(`pc${id} new ice=${JSON.stringify(cfg.iceServers?.map((s) => s.urls))}`);
        pc.addEventListener("signalingstatechange", () => console.log(`pc${id} sig=${pc.signalingState}`));
        pc.addEventListener("iceconnectionstatechange", () => console.log(`pc${id} ice=${pc.iceConnectionState}`));
        pc.addEventListener("icecandidate", (e) => console.log(`pc${id} cand ${e.candidate?.type ?? "end"}`));
        return pc;
      } as unknown as typeof RTCPeerConnection;
      W.prototype = O0.prototype;
      (window as any).RTCPeerConnection = W;
      const OW = window.WebSocket;
      (window as any).WebSocket = class extends OW { constructor(u: string | URL, p?: string | string[]) { super(u, p); this.addEventListener("message", (e) => { const m = JSON.parse(String((e as MessageEvent).data)); console.log(`ws< ${m.type} ${m.payload?.kind ?? m.error ?? m.role ?? ""}`); }); const send = this.send.bind(this); this.send = (d: any) => { const m = JSON.parse(d); console.log(`ws> ${m.type} ${m.payload?.kind ?? ""}`); send(d); }; this.addEventListener("close", (e) => console.log(`ws close ${(e as CloseEvent).code}`)); } };
    }
    if (relay) {
      const O = window.RTCPeerConnection;
      (window as any).RTCPeerConnection = function (cfg: RTCConfiguration) { return new O({ ...cfg, iceTransportPolicy: "relay" }); };
      (window as any).RTCPeerConnection.prototype = O.prototype;
    }
  }, [noPicker, RELAY] as const);
}

test("live p2p", async ({ browser }) => {
  test.setTimeout(240_000);
  const data = randomBytes(900 * 1024);
  const s = await (await browser.newContext()).newPage();
  await prep(s, "S");
  await s.goto(BASE);
  await s.locator('input[type="file"]').first().setInputFiles({ name: "x.bin", mimeType: "application/octet-stream", buffer: data });
  await s.getByTestId("path-direct").click();
  await s.getByRole("button", { name: /Démarrer le transfert direct|Start direct transfer/ }).click();
  const link = await s.getByTestId("p2p-link").inputValue();
  const r = await (await browser.newContext({ acceptDownloads: true })).newPage();
  await prep(r, "R", true);
  await r.goto(link);
  await expect(r.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "ready", { timeout: 60_000 });
  if (DELAY) await r.waitForTimeout(DELAY);
  console.log("sender status before click:", await s.getByTestId("p2p-send-status").getAttribute("data-status"));
  const dl = r.waitForEvent("download", { timeout: 90_000 });
  await r.getByTestId("p2p-download").click();
  await dl;
  await expect(r.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "complete", { timeout: 60_000 });
  await expect(s.getByTestId("p2p-send-status")).toHaveAttribute("data-status", "complete", { timeout: 30_000 });
  if (LOCAL_DIST) await expect(s.locator('[data-testid="p2p-send-log"] li[data-result="complete"]')).toHaveCount(1);
});
