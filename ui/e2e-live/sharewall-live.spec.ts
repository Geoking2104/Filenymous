/**
 * Opt-in live check (not in CI): Sharewall on https://filenymous.eu/app/ with the live relay.
 * Host + guest, keyword search, on-device semantic search with the models served by the site,
 * and no live-captions control (removed). Screenshots blur the invite
 * link / key (SHOTS=dir). Never prints the link.
 *   npx playwright test -c playwright.live-p2p.config.ts e2e-live/sharewall-live.spec.ts
 */
import { test, expect, type Page } from "@playwright/test";
const BASE = process.env.LIVE_BASE || "https://filenymous.eu/app/";
const SHOTS = process.env.SHOTS;

async function shot(p: Page, name: string) {
  if (!SHOTS) return;
  await p.addStyleTag({ content: `[data-testid="wall-link"],[data-testid*="invite"],[data-testid*="qr"],input[value*="#wall"],a[href*="#wall"],canvas{filter:blur(12px)!important}` });
  await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

test("live sharewall: guest, search, on-device semantic search, no captions control", async ({ browser }) => {
  test.setTimeout(240_000);
  const host = await (await browser.newContext()).newPage();
  const off: string[] = [];
  host.on("request", (r) => { const u = new URL(r.url()); if (!u.hostname.endsWith("filenymous.eu")) off.push(u.hostname); });
  const speech: string[] = [];
  host.on("request", (r) => { if (/whisper/i.test(r.url())) speech.push(new URL(r.url()).pathname); });
  host.on("dialog", (d) => void d.accept());
  await host.goto(`${BASE}#wall-new`);
  await host.getByTestId("wall-agents").check();
  await host.getByTestId("wall-ack-leave").check();
  await host.getByTestId("wall-create-submit").click();
  await expect(host.getByTestId("wall-host-status")).toHaveAttribute("data-status", "online", { timeout: 30_000 });
  const link = await host.getByTestId("wall-link").inputValue();

  const guest = await (await browser.newContext()).newPage();
  guest.on("dialog", (d) => void d.accept());
  await guest.goto(link);
  await expect(guest.getByTestId("wall-peer-status")).toHaveAttribute("data-status", "online", { timeout: 45_000 });

  for (const t of ["The quarterly report is due Friday before noon.", "Who brings the croissants tomorrow?"]) {
    await host.getByTestId("wall-msg-input").fill(t);
    await host.getByTestId("wall-msg-input").press("Enter");
  }
  await guest.getByTestId("wall-msg-input").fill("Rendez-vous au café à 9h");
  await guest.getByTestId("wall-msg-input").press("Enter");
  await expect(host.getByText("Rendez-vous au café à 9h")).toBeVisible({ timeout: 20_000 });
  await expect(guest.getByText("croissants")).toBeVisible({ timeout: 20_000 });

  // Keyword search (accent-insensitive).
  await guest.getByTestId("wall-search").fill("CAFE");
  await expect(guest.getByTestId("wall-search-count")).toHaveAttribute("data-count", "1");
  await shot(guest, "1-guest-keyword-search");
  await guest.getByTestId("wall-search").fill("");

  // On-device semantic search with the models served from /app/models/.
  await host.getByTestId("wall-semantic-toggle").check();
  await expect(host.getByTestId("wall-semantic-state")).toContainText(/(On|Activée)/, { timeout: 150_000 });

  // Live captions were removed: no control, no indicator, no speech model fetched.
  await expect(host.getByTestId("wall-captions-toggle")).toHaveCount(0);
  await expect(host.getByText(/sous-titres|live captions/i)).toHaveCount(0);
  await expect(guest.getByTestId("wall-captions-on")).toHaveCount(0);
  expect(speech, "no speech model requested").toEqual([]);
  await host.getByTestId("wall-ai-tools").scrollIntoViewIfNeeded();
  await shot(host, "2-host-ai-tools");
  expect(off.filter((h) => !h.includes("umami") && h !== "www.opendpe.net"), "only the site + its signal relay (no model/runtime CDN)").toEqual([]);
});
