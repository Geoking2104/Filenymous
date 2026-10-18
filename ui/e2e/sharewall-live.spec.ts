/**
 * E2E: Sharewall live media — screen/camera streams relayed by the host's tab
 * (publisher → host → viewers), negotiated inside the sealed DataChannel.
 * Chromium fake media devices; three browser contexts.
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import { createWall, join, newPage as open, startRelay, type Relay } from "./wall-helpers";

test.use({
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--auto-accept-this-tab-capture", "--auto-select-desktop-capture-source=Entire screen"],
  },
});
test.describe.configure({ mode: "serial" });

let relay: Relay;
test.beforeAll(async () => {
  relay = await startRelay();
});
test.afterAll(() => relay?.proc.kill());

const newPage = async (browser: Browser) => {
  const c = await open(browser, relay.url);
  await c.page.context().grantPermissions(["camera", "microphone", "clipboard-read", "clipboard-write"]);
  c.page.on("dialog", (d) => void d.accept()); // consent prompts
  return c;
};

async function playing(p: Page, n: number) {
  await expect(p.getByTestId("wall-live-tile")).toHaveCount(n, { timeout: 20_000 });
  await expect
    .poll(
      () => p.getByTestId("wall-live-video").evaluateAll((vs: HTMLVideoElement[]) => vs.filter((v) => v.videoWidth > 0 && v.readyState >= 2).length),
      { timeout: 20_000 },
    )
    .toBe(n);
}

test("live camera + screen: the host forwards streams to every viewer, limit 2, stop everywhere", async ({ browser }) => {
  test.setTimeout(120_000);
  const host = await newPage(browser);
  const { link } = await createWall(host.page, { hostLeave: false });
  const [a, b] = await Promise.all([newPage(browser), newPage(browser)]);
  await join(a.page, link);
  await join(b.page, link);

  // A goes live with the (fake) camera after the explicit consent prompt.
  let consent = "";
  a.page.removeAllListeners("dialog");
  a.page.on("dialog", (d) => {
    consent = d.message();
    void d.accept();
  });
  await a.page.getByTestId("wall-live-toggle").click();
  await a.page.getByTestId("wall-live-mic").check();
  await a.page.getByTestId("wall-live-camera").click();
  expect(consent).toContain("caméra");
  for (const p of [host.page, b.page, a.page]) await playing(p, 1);
  await expect(b.page.getByTestId("wall-live-badge")).toHaveText(/EN DIRECT/);
  await expect(b.page.locator('[data-testid="wall-member"][data-label="peer:1"]')).toContainText("EN DIRECT");
  // Viewers receive audio + video tracks forwarded by the host.
  await expect.poll(() => b.page.getByTestId("wall-live-video").evaluate((v: HTMLVideoElement) => (v.srcObject as MediaStream | null)?.getTracks().length ?? 0)).toBe(2);
  await expect(a.page.getByTestId("wall-live-stop-mine")).toBeVisible();

  // The host shares its screen: two streams for everyone.
  await host.page.getByTestId("wall-live-toggle").click();
  const screen = host.page.getByTestId("wall-live-screen");
  const kind = (await screen.count()) ? "screen" : "camera";
  await host.page.getByTestId(kind === "screen" ? "wall-live-screen" : "wall-live-camera").click();
  for (const p of [host.page, a.page, b.page]) await playing(p, 2);
  if (kind === "screen") await expect(b.page.getByTestId("wall-live-tile").filter({ hasText: "🖥️" })).toHaveCount(1);
  console.log(`host shared: ${kind}`);

  // A third stream is refused (limit 2 at once).
  await b.page.getByTestId("wall-live-toggle").click();
  await b.page.getByTestId("wall-live-camera").click();
  await expect(b.page.getByTestId("wall-notice")).toContainText("2 directs au plus", { timeout: 10_000 });
  await expect(b.page.getByTestId("wall-live-tile")).toHaveCount(2);

  // A stops: its tile disappears everywhere, and its camera is released.
  await a.page.getByTestId("wall-live-stop-mine").click();
  for (const p of [host.page, a.page, b.page]) await expect(p.getByTestId("wall-live-tile")).toHaveCount(1, { timeout: 10_000 });
  // The host can stop any stream (moderation): it stops its own here.
  await host.page.getByTestId("wall-live-stop").click();
  for (const p of [host.page, a.page, b.page]) await expect(p.getByTestId("wall-live-tile")).toHaveCount(0, { timeout: 10_000 });

  // Media negotiation never went through the relay (it travels inside the sealed channel).
  for (const c of [host, a, b]) {
    const all = c.sent.join("\n");
    expect(all).not.toMatch(/m=video|m=audio/);
  }
  host.page.removeAllListeners("dialog");
  host.page.once("dialog", (d) => void d.accept());
  await host.page.getByTestId("wall-destroy").click();
  await expect(b.page.getByTestId("wall-ended")).toHaveAttribute("data-reason", "destroyed", { timeout: 10_000 });
});
