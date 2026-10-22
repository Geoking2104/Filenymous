/**
 * Every service screen shows the icon of the home card that leads to it
 * (same <ServiceIcon> component, same `data-service-icon`, same markup),
 * next to the service title — including recipient / joiner screens reached
 * by links. One local relay serves signaling, vault and reports.
 * ICON_SHOTS=<dir> saves one screenshot per screen.
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 25789 + Math.floor(Math.random() * 1000);
const SHOTS = process.env.ICON_SHOTS;
let relay: ChildProcess;

test.beforeAll(async () => {
  relay = spawn(process.execPath, [resolve(here, "../../p2p-signal/server.js")], {
    env: { ...process.env, PORT: String(PORT), STUN_URLS: "", REDIS_URL: "", RATE_LIMIT_MAX_MESSAGES: "5000", VAULT_CREATE_PER_MIN: "1000", VAULT_READ_PER_MIN: "1000" },
    stdio: "pipe",
  });
  await new Promise<void>((ok, ko) => {
    const t = setTimeout(() => ko(new Error("relay did not start")), 10_000);
    relay.stdout!.on("data", (d) => String(d).includes("listening") && (clearTimeout(t), ok()));
  });
});
test.afterAll(() => relay?.kill());

const local = (link: string) => link.replace(/^https?:\/\/[^/]+/, "");

async function open(browser: Browser, opts: { mobile?: boolean; dark?: boolean } = {}): Promise<Page> {
  const ctx = await browser.newContext({
    acceptDownloads: true,
    viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1280, height: 860 },
    ...(opts.mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    colorScheme: opts.dark ? "dark" : "light",
  });
  const page = await ctx.newPage();
  page.on("dialog", (d) => void d.accept());
  await page.addInitScript((port) => {
    const w = window as unknown as Record<string, unknown>;
    w.__FILENYMOUS_SIGNAL_URL__ = `ws://127.0.0.1:${port}`;
    w.__FILENYMOUS_VAULT_URL__ = `http://127.0.0.1:${port}`;
    delete w.showSaveFilePicker;
    delete w.showDirectoryPicker;
  }, PORT);
  return page;
}

/** Card icon markup by service, read from the home carousel. */
async function cardIcons(page: Page): Promise<Record<string, string>> {
  await page.goto("/");
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>("article[data-service]")].map((a) => {
        const icon = a.querySelector<HTMLElement>(".pz-service-head [data-service-icon]")!;
        if (icon.dataset.serviceIcon !== a.dataset.service) throw new Error(`card ${a.dataset.service} has icon ${icon.dataset.serviceIcon}`);
        return [a.dataset.service!, icon.outerHTML];
      }),
    ),
  );
}

let icons: Record<string, string> = {};
const seen: string[] = [];

async function expectIcon(page: Page, service: string, shot: string, title?: RegExp) {
  const head = page.getByTestId("service-head");
  await expect(head).toHaveAttribute("data-service", service);
  const icon = head.locator("[data-service-icon]");
  await expect(icon).toHaveAttribute("data-service-icon", service);
  expect(await icon.evaluate((el) => el.outerHTML), `${shot}: same icon markup as the ${service} card`).toBe(icons[service]);
  if (title) await expect(head.locator("h1")).toHaveText(title);
  // Next to the title, same row, card-size tile.
  const [ib, hb] = [await icon.boundingBox(), await head.locator("h1").boundingBox()];
  expect(ib!.width).toBe(44);
  expect(ib!.x + ib!.width).toBeLessThanOrEqual(hb!.x);
  expect(Math.abs(ib!.y + ib!.height / 2 - (hb!.y + hb!.height / 2))).toBeLessThan(20);
  await expect(icon, `${shot}: header visible without scrolling`).toBeInViewport();
  seen.push(`${shot}:${service}`);
  if (SHOTS) {
    await page.waitForTimeout(700); // let the fy-in entrance animation finish
    await page.screenshot({ path: `${SHOTS}/${shot}.png` });
  }
}

test("each card's icon is shown on every screen of its service (desktop, light)", async ({ browser }) => {
  test.setTimeout(180_000);
  const home = await open(browser);
  icons = await cardIcons(home);
  expect(Object.keys(icons).sort()).toEqual(["cli", "drop", "pro", "report", "secret", "send", "stream", "wall"]);
  if (SHOTS) await home.screenshot({ path: `${SHOTS}/00-home-cards.png` });

  // Direct transfer: review → sending → recipient (by link).
  await home.locator('[data-testid="dropzone"] input[type="file"]').setInputFiles([{ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("hello icons") }]);
  await expectIcon(home, "send", "01-send-review", /Envoyer des fichiers/);
  await home.getByTestId("start-send").click();
  await expect(home.getByTestId("p2p-send-status")).toHaveAttribute("data-status", "waiting", { timeout: 15_000 });
  await expectIcon(home, "send", "02-send-waiting");
  const rx = await open(browser);
  await rx.goto(local(await home.getByTestId("p2p-link").inputValue()));
  await expectIcon(rx, "send", "03-send-recipient", /Recevoir un fichier/);

  // Streaming: card picker → review (stream mode) → sending → recipient sees the streaming icon.
  const st = await open(browser);
  await st.goto("/");
  await st.getByTestId("stream-input").setInputFiles([resolve(here, "fixtures/stream-sample.webm")]);
  await expect(st.getByTestId("send-stream")).toBeChecked();
  await expectIcon(st, "stream", "04-stream-review", /Partage streamé/);
  await st.getByTestId("start-send").click();
  await expect(st.getByTestId("p2p-send-status")).toHaveAttribute("data-status", "waiting", { timeout: 15_000 });
  await expectIcon(st, "stream", "05-stream-waiting");
  const srx = await open(browser);
  await srx.goto(local(await st.getByTestId("p2p-link").inputValue()));
  await expect(srx.getByTestId("service-head")).toHaveAttribute("data-service", "stream", { timeout: 30_000 });
  await expectIcon(srx, "stream", "06-stream-recipient", /Partage streamé/);

  // Dropzone: create → owner → contributor (by link); the Pro card opens Dropzone with its own icon.
  const dz = await open(browser);
  await dz.goto("/");
  await dz.getByTestId("dropzone-entry").click();
  await expectIcon(dz, "drop", "07-drop-create", /Recevoir des fichiers/);
  await dz.getByTestId("drop-create-submit").click();
  const dropLink = await dz.getByTestId("drop-link").inputValue();
  await expectIcon(dz, "drop", "08-drop-owner");
  const contrib = await open(browser);
  await contrib.goto(local(dropLink));
  await expectIcon(contrib, "drop", "09-drop-contributor");
  const pro = await open(browser);
  await pro.goto("/");
  await pro.getByTestId("pro-entry").click();
  await expectIcon(pro, "pro", "10-pro-create", /Espace Client-Prestataire/);

  // One-time secret: create → link → reveal page.
  const vs = await open(browser);
  await vs.goto("/");
  await vs.getByTestId("vault-entry").click();
  await expectIcon(vs, "secret", "11-secret-create", /Envoyer un secret/);
  await vs.getByTestId("vault-text").fill("icône identique");
  await vs.getByRole("button", { name: /Générer le lien secret/ }).click();
  const secretLink = await vs.getByTestId("vault-link").inputValue();
  await expectIcon(vs, "secret", "12-secret-created");
  const reveal = await open(browser);
  await reveal.goto(local(secretLink));
  await expectIcon(reveal, "secret", "13-secret-reveal");

  // Reporting channel: create → reporter page (by link) → inbox → follow-up.
  const org = await open(browser);
  await org.goto("/");
  await org.getByTestId("report-entry").click();
  await expectIcon(org, "report", "14-report-create", /Canal de signalement/);
  await org.getByTestId("report-passphrase").fill("phrase de passe très longue 2026");
  await org.getByTestId("report-passphrase2").fill("phrase de passe très longue 2026");
  await org.getByTestId("report-create-submit").click();
  await expect(org.getByTestId("report-created")).toBeVisible({ timeout: 20_000 });
  await expectIcon(org, "report", "15-report-created");
  const reporter = await open(browser);
  await reporter.goto(local(await org.getByTestId("report-public-link").inputValue()));
  await expectIcon(reporter, "report", "16-report-reporter");
  await org.goto("/#report-inbox");
  await expectIcon(org, "report", "17-report-inbox");
  const follow = await open(browser);
  await follow.goto("/");
  await follow.getByTestId("report-follow-entry").click();
  await expectIcon(follow, "report", "18-report-follow");

  // Sharewall: create → host room → peer (by link) → destroyed (host + peer).
  const host = await open(browser);
  await host.goto("/");
  await host.getByTestId("wall-entry").click();
  await expectIcon(host, "wall", "19-wall-create", /Mur de partage/);
  await host.getByTestId("wall-ack-leave").check();
  await host.getByTestId("wall-create-submit").click();
  await expect(host.getByTestId("wall-host-status")).toHaveAttribute("data-status", "online", { timeout: 15_000 });
  const wallLink = await host.getByTestId("wall-link").inputValue();
  await expectIcon(host, "wall", "20-wall-host");
  const peer = await open(browser);
  await peer.goto(local(wallLink));
  await expect(peer.getByTestId("wall-peer-status")).toHaveAttribute("data-status", "online", { timeout: 20_000 });
  await expectIcon(peer, "wall", "21-wall-peer");
  await host.getByTestId("wall-actions").click();
  await host.getByTestId("wall-destroy").click();
  await host.getByTestId("leave-confirm").click();
  await expect(peer.getByTestId("wall-ended")).toHaveAttribute("data-reason", "destroyed", { timeout: 10_000 });
  await expectIcon(peer, "wall", "22-wall-peer-destroyed");
  await expect(host.getByTestId("wall-ended")).toHaveAttribute("data-reason", "destroyed");
  await expectIcon(host, "wall", "23-wall-host-destroyed");

  // CLI card: documentation link (no in-app screen).
  await home.goto("/");
  await expect(home.getByTestId("cli-docs")).toHaveAttribute("href", /github\.com\/Geoking2104\/Filenymous\/tree\/main\/cli/);
  console.log(`service-icons: ${seen.length} screens checked`);
});

test("mobile + dark: same icon, next to the title, no overflow", async ({ browser }) => {
  const page = await open(browser, { mobile: true, dark: true });
  icons = await cardIcons(page);
  for (const [entry, service, shot] of [["wall-entry", "wall", "m1-wall-create"], ["vault-entry", "secret", "m2-secret-create"], ["report-entry", "report", "m3-report-create"], ["dropzone-entry", "drop", "m4-drop-create"]] as const) {
    await page.goto("/");
    await page.getByTestId(entry).scrollIntoViewIfNeeded();
    await page.getByTestId(entry).click();
    await expectIcon(page, service, shot);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.goto("/");
  await page.getByTestId("stream-input").setInputFiles([resolve(here, "fixtures/stream-sample.webm")]);
  await expectIcon(page, "stream", "m5-stream-review");
  expect(readFileSync(resolve(here, "fixtures/stream-sample.webm")).length).toBeGreaterThan(0);
});
