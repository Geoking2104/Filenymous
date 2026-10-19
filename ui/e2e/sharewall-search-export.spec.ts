/**
 * E2E: Sharewall search (client-only) and host export (JSON / Markdown),
 * with the in-feed "the host exported the wall" notice. Local relay.
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createWall, join, msg, newPage as open, say, startRelay, type Relay } from "./wall-helpers";

let relay: Relay;
test.beforeAll(async () => {
  relay = await startRelay();
});
test.afterAll(() => {
  relay?.proc.kill();
});
const newPage = (browser: Browser) => open(browser, relay.url);
const SHOTS = process.env.SHOTS_DIR;
const shot = async (p: Page, n: string) => SHOTS && (await p.screenshot({ path: `${SHOTS}/${n}.png`, animations: "disabled" }));

test("search filters the feed for host and peer, highlights and clears", async ({ browser }) => {
  const host = await newPage(browser);
  const { link } = await createWall(host.page, { name: "Recherche" });
  const peer = await newPage(browser);
  await join(peer.page, link);
  await say(host.page, "Le café est prêt");
  await say(peer.page, "Rien à voir ici");
  await peer.page.getByTestId("wall-file-input").setInputFiles([{ name: "Rapport-Été.txt", mimeType: "text/plain", buffer: Buffer.from("x") }]);
  for (const p of [host.page, peer.page]) await expect(msg(p, "Rien à voir ici")).toHaveCount(1);
  await expect(host.page.getByText("Rapport-Été.txt").first()).toBeVisible();

  for (const p of [host.page, peer.page]) {
    await p.getByTestId("wall-search").fill("CAFE");
    await expect(p.getByTestId("wall-search-count")).toHaveAttribute("data-count", "1");
    await expect(msg(p, "Le café est prêt")).toHaveCount(1);
    await expect(msg(p, "Rien à voir ici")).toHaveCount(0);
    await expect(p.getByTestId("wall-search-hl").first()).toHaveText("café");
    await p.getByTestId("wall-search").fill("ete");
    await expect(p.getByTestId("wall-search-count")).toHaveAttribute("data-count", "1");
    await expect(p.getByText("Rapport-Été.txt").first()).toBeVisible();
    await expect(msg(p, "Le café est prêt")).toHaveCount(0);
  }
  await host.page.getByTestId("wall-search").fill("café");
  await shot(host.page, "local-search-host");
  await peer.page.getByTestId("wall-search-clear").click();
  await expect(peer.page.getByTestId("wall-search")).toHaveValue("");
  await expect(peer.page.getByTestId("wall-search-count")).toHaveCount(0);
  await expect(msg(peer.page, "Rien à voir ici")).toHaveCount(1);
  // Ctrl/Cmd+F focuses the wall search.
  await peer.page.getByTestId("wall-msg-input").click();
  await peer.page.keyboard.press("ControlOrMeta+f");
  await expect(peer.page.getByTestId("wall-search")).toBeFocused();
});

test("host exports JSON and Markdown; peer sees the notice and has no export", async ({ browser }) => {
  const host = await newPage(browser);
  const { link } = await createWall(host.page, { name: "Équipe Q4" });
  const peer = await newPage(browser);
  await join(peer.page, link);
  await say(peer.page, "message du pair");
  await host.page.getByTestId("wall-file-input").setInputFiles([{ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("bonjour export") }]);
  await expect(msg(host.page, "message du pair")).toHaveCount(1);
  await expect(peer.page.getByText("notes.txt").first()).toBeVisible();

  await expect(peer.page.getByTestId("wall-export")).toHaveCount(0);

  await host.page.getByTestId("wall-export").click();
  const dialog = host.page.getByTestId("wall-export-dialog");
  await expect(dialog).toBeVisible();
  await expect(host.page.getByTestId("wall-export-warning")).toContainText(/copie permanente|permanent copy/);
  await expect(dialog).toContainText(/permanent copy|copie permanente/);
  await shot(host.page, "local-export-dialog");
  await host.page.getByTestId("wall-export-cancel").click();
  await expect(dialog).toHaveCount(0);
  await expect(peer.page.getByTestId("wall-system")).toHaveCount(0);

  await host.page.getByTestId("wall-export").click();
  const [dl] = await Promise.all([host.page.waitForEvent("download"), host.page.getByTestId("wall-export-confirm").click()]);
  expect(dl.suggestedFilename()).toMatch(/^filenymous-mur-equipe-q4-\d{4}-\d{2}-\d{2}\.json$/);
  const snap = JSON.parse(readFileSync((await dl.path())!, "utf8"));
  expect(snap).toMatchObject({ format: "filenymous-wall-snapshot", v: 1, title: "Équipe Q4", burn: false, skipped: [] });
  expect(snap.posts.some((p: { text?: string }) => p.text === "message du pair")).toBe(true);
  expect(snap.members.length).toBe(2);
  expect(Buffer.from(snap.items[0].dataB64, "base64").toString()).toBe("bonjour export");
  expect(JSON.stringify(snap)).not.toContain(link.split("#")[1]!); // the wall key is not in the file

  for (const p of [host.page, peer.page]) {
    await expect(p.getByTestId("wall-system")).toHaveCount(1);
    await expect(p.getByTestId("wall-system")).toContainText(/L'hôte a exporté le mur|The host exported the wall/);
  }
  await shot(peer.page, "local-peer-notice");
  await expect(peer.page.getByTestId("wall-system").getByRole("button")).toHaveCount(0);

  await host.page.getByTestId("wall-export").click();
  await host.page.getByTestId("wall-export-format-md").check();
  const [md] = await Promise.all([host.page.waitForEvent("download"), host.page.getByTestId("wall-export-confirm").click()]);
  expect(md.suggestedFilename()).toMatch(/^filenymous-mur-equipe-q4-.*\.md$/);
  const text = readFileSync((await md.path())!, "utf8");
  expect(text).toContain("message du pair");
  expect(text).toContain("notes.txt");
  expect(text).not.toContain("bonjour export");
  await expect(peer.page.getByTestId("wall-system")).toHaveCount(2);
});

test("burn wall: export is disabled with an explanation", async ({ browser }) => {
  const host = await newPage(browser);
  await createWall(host.page, { burn: true });
  await expect(host.page.getByTestId("wall-export")).toBeDisabled();
  await expect(host.page.getByTestId("wall-export-blocked")).toContainText(/autodestruction|self-destructs/);
  await shot(host.page, "local-burn-blocked");
});

test("mobile: search opens from the icon button", async ({ browser }) => {
  const host = await open(browser, relay.url, { viewport: { width: 390, height: 800 } });
  await createWall(host.page, { name: "Mobile" });
  await say(host.page, "bonjour mobile");
  await expect(host.page.getByTestId("wall-search")).toBeHidden();
  await host.page.getByTestId("wall-search-toggle").click();
  await host.page.getByTestId("wall-search").fill("mobile");
  await expect(host.page.getByTestId("wall-search-count")).toHaveAttribute("data-count", "1");
  await shot(host.page, "local-mobile-search");
});
