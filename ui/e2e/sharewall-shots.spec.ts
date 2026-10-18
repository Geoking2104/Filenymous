/**
 * Screenshots of Sharewall v2 (only with SW_SHOTS=<dir>): feed with reactions,
 * emoji picker, poll, live stream, AI agent participants, mobile.
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createWall, here, join, msg, newPage as open, say, startRelay, type Relay } from "./wall-helpers";

const DIR = process.env.SW_SHOTS;
const CLI = resolve(here, "../../cli/dist/filenymous.js");
test.skip(!DIR || !existsSync(CLI), "screenshots only (SW_SHOTS=<dir>, CLI built)");
test.use({
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--auto-accept-this-tab-capture", "--auto-select-desktop-capture-source=Entire screen"] },
});

let relay: Relay;
const procs: ChildProcess[] = [];
test.beforeAll(async () => (relay = await startRelay()));
test.afterAll(() => {
  for (const p of procs) p.kill("SIGKILL");
  relay?.proc.kill();
});

async function ctx(browser: Browser, viewport: { width: number; height: number }) {
  const c = await open(browser, relay.url, { viewport, colorScheme: "dark" });
  await c.page.context().grantPermissions(["camera", "microphone", "clipboard-read", "clipboard-write"]);
  c.page.on("dialog", (d) => void d.accept());
  return c.page;
}
async function rename(p: Page, label: string, name: string) {
  await p.locator(`[data-testid="wall-member"][data-label="${label}"]`).getByTestId("wall-name-edit").click();
  await p.getByTestId("wall-name-input").fill(name);
  await p.getByTestId("wall-name-input").press("Enter");
}
const shot = (p: Page, name: string) => p.screenshot({ path: `${DIR}/${name}.png` });

test("Sharewall v2 screenshots", async ({ browser }) => {
  test.setTimeout(180_000);
  mkdirSync(DIR!, { recursive: true });
  const desk = { width: 1440, height: 900 };
  const host = await ctx(browser, desk);
  const { link } = await createWall(host, { hostLeave: false, agents: true });
  await rename(host, "host", "Camille (hôte)");
  const alice = await ctx(browser, desk);
  await join(alice, link);
  await rename(alice, "peer:1", "Alice");
  const mobile = await ctx(browser, { width: 390, height: 844 });
  await join(mobile, link);

  // Two CLI agents.
  const agents = ["Agent Résumé", "Agent Traduction"].map((name) => {
    const p = spawn(process.execPath, [CLI, "wall", "join", link, "--name", name, "--signal", relay.url, "--app-url", "http://localhost:5173/", "--quiet"], { stdio: ["pipe", "pipe", "inherit"] });
    procs.push(p);
    return p;
  });
  await expect(host.getByTestId("wall-badge-ai")).toHaveCount(2, { timeout: 20_000 });

  await say(host, "Bienvenue sur le mur de l'atelier 👋 — **1 h**, puis tout disparaît.");
  await say(alice, "Merci ! Je partage le plan dans une minute.");
  await say(alice, "@Agent Résumé tu pourras faire la synthèse ?");
  await expect(msg(host, "synthèse")).toBeVisible();
  agents[0]!.stdin!.write(`${JSON.stringify({ cmd: "send", text: "Bien sûr : je publierai un résumé en **3 points** à la fin." })}\n`);
  agents[1]!.stdin!.write(`${JSON.stringify({ cmd: "send", text: "Et je le traduis en anglais. 🇬🇧" })}\n`);
  await expect(msg(host, "traduis")).toBeVisible();
  const m = msg(host, "Bienvenue");
  const mid = (await m.getAttribute("data-id"))!;
  for (const [p, e] of [[alice, "❤️"], [mobile, "❤️"], [alice, "🎉"], [host, "👍"]] as const) {
    const el = p.locator(`[data-id="${mid}"]`);
    await el.hover();
    await el.locator(`[data-testid="wall-quick-react"][data-emoji="${e}"]`).click();
  }
  await expect(alice.locator(`[data-id="${mid}"] [data-testid="wall-reaction"][data-emoji="❤️"]`)).toHaveAttribute("data-count", "2");
  await alice.getByTestId("wall-hand").click();
  await host.mouse.move(0, 0);
  await host.waitForTimeout(400);
  await shot(host, "01-feed-reactions-agents-desktop");

  // Emoji picker.
  await alice.getByTestId("wall-emoji-toggle").click();
  await alice.waitForTimeout(300);
  await shot(alice, "02-emoji-picker-desktop");
  await alice.keyboard.press("Escape");

  // Poll with live results.
  await alice.getByTestId("wall-poll-toggle").click();
  await alice.getByTestId("wall-poll-question").fill("On commence par quel sujet ?");
  await alice.getByTestId("wall-poll-option").nth(0).fill("Sécurité");
  await alice.getByTestId("wall-poll-option").nth(1).fill("Démo en direct");
  await alice.getByTestId("wall-poll-add").click();
  await alice.getByTestId("wall-poll-option").nth(2).fill("Questions");
  await alice.getByTestId("wall-poll-submit").click();
  await expect(host.getByTestId("wall-poll")).toHaveCount(1);
  await host.locator('[data-testid="wall-poll-vote"][data-index="1"]').click();
  await alice.locator('[data-testid="wall-poll-vote"][data-index="1"]').click();
  await mobile.locator('[data-testid="wall-poll-vote"][data-index="0"]').click();
  await expect(alice.getByTestId("wall-poll-total")).toHaveText("3 votes");
  await alice.getByTestId("wall-poll").scrollIntoViewIfNeeded();
  await shot(alice, "03-poll-desktop");

  // Live: Alice's camera + the host's screen.
  await alice.getByTestId("wall-live-toggle").click();
  await alice.getByTestId("wall-live-camera").click();
  await host.getByTestId("wall-live-toggle").click();
  await host.getByTestId((await host.getByTestId("wall-live-screen").count()) ? "wall-live-screen" : "wall-live-camera").click();
  for (const p of [alice, mobile, host]) await expect(p.getByTestId("wall-live-tile")).toHaveCount(2, { timeout: 20_000 });
  await expect.poll(() => alice.getByTestId("wall-live-video").evaluateAll((vs: HTMLVideoElement[]) => vs.filter((v) => v.videoWidth > 0).length), { timeout: 20_000 }).toBe(2);
  await alice.waitForTimeout(800);
  await shot(alice, "04-live-stream-desktop");

  // Agent participants (side panel + provider warning).
  await shot(host, "05-agents-participants-desktop");
  await host.locator(".sw2-side, aside").first().screenshot({ path: `${DIR}/05b-agents-panel.png` }).catch(() => undefined);

  // Mobile: feed, then the collapsible members panel.
  await mobile.waitForTimeout(500);
  await shot(mobile, "06-mobile-feed");
  await mobile.getByTestId("wall-members-toggle").click();
  await mobile.waitForTimeout(400);
  await shot(mobile, "07-mobile-members");
  await mobile.getByTestId("wall-members-toggle").click().catch(() => undefined);

  // Light theme (same as the site).
  const light = await open(browser, relay.url, { viewport: desk, colorScheme: "light" });
  await join(light.page, link);
  await expect(light.page.getByTestId("wall-live-tile")).toHaveCount(2, { timeout: 20_000 });
  await light.page.waitForTimeout(800);
  await shot(light.page, "08-light-theme-desktop");
});
