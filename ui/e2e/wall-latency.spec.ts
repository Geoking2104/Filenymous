/**
 * Regression (seen in production): on a high-latency relay link the peer tab used to
 * start twice on mount and send two offers; the host answered both and the newest
 * RTCPeerConnection applied the stale answer, so the peer stayed in "handshake".
 */
import { test, expect } from "@playwright/test";
import { createWall, join, newPage, say, msg, startRelay, type Relay } from "./wall-helpers";

let relay: Relay;
test.beforeAll(async () => {
  relay = await startRelay();
});
test.afterAll(() => relay.proc.kill());

test("peer connects once over a slow signaling link (300 ms each way)", async ({ browser }) => {
  const host = await newPage(browser, relay.url);
  const { link } = await createWall(host.page);
  const peer = await newPage(browser, relay.url);
  const offers: number[] = [];
  await peer.page.routeWebSocket(/127\.0\.0\.1/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      try {
        if (JSON.parse(String(m)).payload?.kind === "offer") offers.push(Date.now());
      } catch { /* ignore */ }
      setTimeout(() => server.send(m), 300);
    });
    server.onMessage((m) => setTimeout(() => ws.send(m), 300));
  });
  await join(peer.page, link);
  expect(offers).toHaveLength(1);
  await say(peer.page, "lent mais connecté");
  await expect(msg(host.page, "lent mais connecté")).toBeVisible();
});
