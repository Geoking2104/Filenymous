/**
 * E2E: "Canal de signalement" — the org creates a mailbox, a reporter submits a
 * report with attachments (metadata stripped), the org decrypts it, replies and
 * changes the status, the reporter reads the reply with the follow-up key;
 * wrong keys/passphrases are refused. Local p2p-signal relay, in-memory store.
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 23789 + Math.floor(Math.random() * 1000);
const API = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.REPORT_SHOTS_DIR;
const PASS = "phrase de passe très longue 2026";
let relay: ChildProcess;

test.beforeAll(async () => {
  relay = spawn(process.execPath, [resolve(here, "../../p2p-signal/server.js")], { env: { ...process.env, PORT: String(PORT), REDIS_URL: "" }, stdio: "pipe" });
  await new Promise<void>((ok, ko) => {
    const t = setTimeout(() => ko(new Error("relay did not start")), 10_000);
    relay.stdout!.on("data", (d) => String(d).includes("listening") && (clearTimeout(t), ok()));
  });
});
test.afterAll(() => relay?.kill());

async function newPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ acceptDownloads: true });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await ctx.newPage();
  await page.addInitScript((url) => { (window as unknown as { __FILENYMOUS_VAULT_URL__: string }).__FILENYMOUS_VAULT_URL__ = url; }, API);
  return page;
}
const shot = async (p: Page, name: string) => SHOTS && p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const local = (link: string) => link.replace(/^https?:\/\/[^/]+/, "");

test("mailbox → report with files → org reads, replies, sets status → reporter reads reply; wrong keys refused", async ({ browser }) => {
  test.setTimeout(120_000);
  // --- organisation creates the channel from the home card -----------------
  const org = await newPage(browser);
  await org.goto("/");
  const card = org.getByTestId("whistle-card");
  await expect(card).toContainText("Nouveau");
  await expect(card).not.toContainText("Bientôt");
  await org.getByTestId("carousel-dot").nth(3).click();
  await expect(card).toBeInViewport();
  await org.waitForTimeout(500);
  if (SHOTS) await org.screenshot({ path: `${SHOTS}/report-01-card.png` });
  await card.getByTestId("report-entry").click();
  await expect(org.getByTestId("report-create")).toBeVisible();
  await org.getByTestId("report-passphrase").fill(PASS);
  await org.getByTestId("report-passphrase2").fill(PASS);
  await shot(org, "report-02-create");
  await org.getByTestId("report-create-submit").click();
  await expect(org.getByTestId("report-created")).toBeVisible({ timeout: 20_000 });
  const link = await org.getByTestId("report-public-link").inputValue();
  expect(link).toMatch(/#report:[A-Za-z0-9_-]{22}\/[A-Za-z0-9_-]{87}$/);
  const fp = await org.getByTestId("report-fingerprint").innerText();
  const [dl] = await Promise.all([org.waitForEvent("download"), org.getByTestId("report-keyfile-download").click()]);
  const keyFile = readFileSync((await dl.path())!, "utf8");
  expect(keyFile).toContain("filenymous-report-key");
  expect(keyFile).not.toMatch(/"d"\s*:/); // the private key is only inside the encrypted blob
  await shot(org, "report-03-created");

  // --- reporter submits (fresh browser, no shared state) ---------------------
  const rep = await newPage(browser);
  await rep.goto(local(link));
  await expect(rep.getByTestId("report-submit")).toBeVisible({ timeout: 15_000 });
  await expect(rep.getByTestId("report-guidance")).toContainText("Tor Browser");
  await expect(rep.getByTestId("report-fingerprint")).toHaveText(fp);
  await rep.getByTestId("report-text").fill("Des factures fictives sont validées au service achats depuis mars.");
  await rep.getByTestId("report-files").setInputFiles([
    { name: "IMG_20260312_DSC.jpg", mimeType: "image/jpeg", buffer: readFileSync(resolve(here, "fixtures/exif-gps.jpg")) },
    { name: "rapport-jean-dupont.pdf", mimeType: "application/pdf", buffer: readFileSync(resolve(here, "fixtures/author.pdf")) },
    { name: "notes.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from("PK\x03\x04 fake docx") },
  ]);
  const metas = rep.getByTestId("report-file-meta");
  await expect(metas).toHaveCount(3);
  await expect(metas.nth(0)).toHaveAttribute("data-status", "cleaned");
  await expect(metas.nth(0)).toContainText("GPS");
  await expect(metas.nth(1)).toContainText("Author");
  await expect(metas.nth(2)).toHaveAttribute("data-status", "unsupported");
  await expect(metas.nth(2)).toContainText("NON retirées");
  await shot(rep, "report-04-reporter-form");
  await rep.getByTestId("report-send").click();
  await expect(rep.getByTestId("report-sent")).toBeVisible({ timeout: 20_000 });
  const followKey = (await rep.getByTestId("report-follow-key").innerText()).trim();
  expect(followKey).toMatch(/^([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/);
  await shot(rep, "report-05-follow-key");

  // --- organisation: wrong passphrase, then unlock with the key file ---------
  const inbox = await newPage(browser); // a different browser: uses the downloaded key file
  await inbox.goto("/#report-inbox");
  await inbox.getByTestId("report-keyfile-input").setInputFiles({ name: "key.json", mimeType: "application/json", buffer: Buffer.from(keyFile) });
  await inbox.getByTestId("report-inbox-passphrase").fill("pas la bonne phrase");
  await inbox.getByTestId("report-inbox-unlock").click();
  await expect(inbox.getByTestId("report-inbox-error")).toContainText("incorrecte", { timeout: 15_000 });
  await inbox.getByTestId("report-inbox-passphrase").fill(PASS);
  await inbox.getByTestId("report-inbox-unlock").click();
  await expect(inbox.getByTestId("report-row")).toHaveCount(1, { timeout: 15_000 });
  await expect(inbox.getByTestId("report-row")).toContainText("Reçu");
  await shot(inbox, "report-06-inbox");
  await inbox.getByTestId("report-row").click();
  await expect(inbox.getByTestId("report-body")).toContainText("factures fictives");
  const atts = inbox.getByTestId("report-attachment");
  await expect(atts).toHaveCount(3);
  await expect(atts.nth(0)).toContainText("piece-1.jpg"); // renamed by default
  const [jpg] = await Promise.all([inbox.waitForEvent("download"), atts.nth(0).click()]);
  const jpgBytes = readFileSync((await jpg.path())!);
  expect(jpgBytes[0]).toBe(0xff);
  expect(jpgBytes.toString("latin1")).not.toContain("Exif");
  expect(jpgBytes.toString("latin1")).not.toContain("Jean Dupont");
  const [pdf] = await Promise.all([inbox.waitForEvent("download"), atts.nth(1).click()]);
  const pdfText = readFileSync((await pdf.path())!).toString("latin1");
  expect(pdfText).toContain("(Rapport interne)");
  expect(pdfText).not.toContain("Jean Dupont");
  await inbox.getByTestId("report-reply-text").fill("Merci. Pouvez-vous préciser le montant approximatif ?");
  await inbox.getByTestId("report-reply-send").click();
  await expect(inbox.getByTestId("inbox-msg-org")).toContainText("montant approximatif");
  await expect(inbox.getByTestId("report-open").getByTestId("report-status")).toHaveAttribute("data-status", "en-cours");
  await shot(inbox, "report-07-org-reply");

  // --- reporter: wrong key refused, right key shows the reply ---------------
  await rep.getByTestId("report-key-noted").check();
  await rep.getByTestId("report-go-follow").click();
  await expect(rep.getByTestId("report-follow")).toBeVisible();
  const wrong = followKey.replace(/^[A-Z2-7]/, (c) => (c === "A" ? "B" : "A"));
  await rep.getByTestId("report-follow-input").fill(wrong);
  await rep.getByTestId("report-follow-open").click();
  await expect(rep.getByTestId("report-follow-error")).toContainText("Clé incorrecte");
  await rep.getByTestId("report-follow-input").fill("trop-court");
  await rep.getByTestId("report-follow-open").click();
  await expect(rep.getByTestId("report-follow-error")).toContainText("Format");
  await shot(rep, "report-08-wrong-key");
  await rep.getByTestId("report-follow-input").fill(followKey.toLowerCase());
  await rep.getByTestId("report-follow-open").click();
  await expect(rep.getByTestId("report-follow-view")).toBeVisible({ timeout: 15_000 });
  await expect(rep.getByTestId("report-status")).toHaveAttribute("data-status", "en-cours");
  await expect(rep.getByTestId("report-msg-org")).toContainText("montant approximatif");
  await rep.getByTestId("report-followup-text").fill("Environ 40 000 € par trimestre.");
  await rep.getByTestId("report-followup-send").click();
  await expect(rep.getByTestId("report-msg-reporter")).toHaveCount(1);
  await shot(rep, "report-09-reporter-thread");

  // --- organisation reads the follow-up and closes --------------------------
  await inbox.getByText("Tous les signalements").click();
  await inbox.getByTestId("report-row").click();
  await expect(inbox.getByTestId("inbox-msg-reporter")).toContainText("40 000 €");
  await inbox.getByTestId("report-set-clos").click();
  await expect(inbox.getByTestId("report-open").getByTestId("report-status")).toHaveAttribute("data-status", "clos");
  await shot(inbox, "report-10-org-closed");
  await rep.getByRole("button", { name: "Fermer" }).click();
  await rep.getByTestId("report-follow-input").fill(followKey);
  await rep.getByTestId("report-follow-open").click();
  await expect(rep.getByTestId("report-status")).toHaveAttribute("data-status", "clos");
  await expect(rep.getByTestId("report-followup-text")).toHaveCount(0);
});

test("a link whose public key was swapped is refused before anything is sent", async ({ browser }) => {
  const org = await newPage(browser);
  await org.goto("/#report-new");
  await org.getByTestId("report-passphrase").fill(PASS);
  await org.getByTestId("report-passphrase2").fill(PASS);
  await org.getByTestId("report-create-submit").click();
  const link = await org.getByTestId("report-public-link").inputValue();
  const other = await newPage(browser);
  await other.goto("/#report-new");
  await other.getByTestId("report-passphrase").fill(PASS);
  await other.getByTestId("report-passphrase2").fill(PASS);
  await other.getByTestId("report-create-submit").click();
  const otherPub = (await other.getByTestId("report-public-link").inputValue()).split("/").pop()!;
  const rep = await newPage(browser);
  await rep.goto(local(link.replace(/\/[A-Za-z0-9_-]{87}$/, `/${otherPub}`)));
  await expect(rep.getByTestId("report-unavailable")).toContainText("ne correspond pas");
  await expect(rep.getByTestId("report-send")).toHaveCount(0);
});
