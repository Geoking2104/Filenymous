/**
 * E2E: "Envoyer des fichiers" with several files — picker, add more, drag-drop
 * onto the review step, duplicate skipping, removal, summary — then a real
 * WebRTC transfer of every selected file through a local p2p-signal relay.
 */
import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 20789 + Math.floor(Math.random() * 1000);
const SIGNAL = `ws://127.0.0.1:${PORT}`;
let relay: ChildProcess;

test.beforeAll(async () => {
  relay = spawn(process.execPath, [resolve(here, "../../p2p-signal/server.js")], {
    env: { ...process.env, PORT: String(PORT), STUN_URLS: "" },
    stdio: "pipe",
  });
  await new Promise<void>((ok, ko) => {
    const t = setTimeout(() => ko(new Error("relay did not start")), 10_000);
    relay.stdout!.on("data", (d) => {
      if (String(d).includes("listening")) {
        clearTimeout(t);
        ok();
      }
    });
  });
});
test.afterAll(() => relay?.kill());

async function prepare(page: Page, noPicker = false) {
  await page.addInitScript(
    ([url, strip]) => {
      (window as unknown as { __FILENYMOUS_SIGNAL_URL__: string }).__FILENYMOUS_SIGNAL_URL__ = url as string;
      try { localStorage.setItem("i18nextLng", "fr"); } catch { /* ignore */ }
      if (strip) {
        delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
        delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
      }
    },
    [SIGNAL, noPicker] as const,
  );
}

/** Dispatches a real drag-and-drop of in-memory files onto `selector`. */
async function dropFiles(page: Page, selector: string, files: { name: string; text: string }[]) {
  const dt = await page.evaluateHandle((list) => {
    const d = new DataTransfer();
    for (const f of list) d.items.add(new File([f.text], f.name, { type: "text/plain", lastModified: 1_700_000_000_000 }));
    return d;
  }, files);
  await page.dispatchEvent(selector, "dragenter", { dataTransfer: dt });
  await page.dispatchEvent(selector, "dragover", { dataTransfer: dt });
  await page.dispatchEvent(selector, "drop", { dataTransfer: dt });
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

test("home drop zone invites several files and points at it", async ({ page }) => {
  await prepare(page);
  await page.goto("/");
  const zone = page.getByTestId("dropzone");
  await expect(zone).toContainText("Glissez-déposez un ou plusieurs fichiers ici");
  await expect(zone).toContainText("Ajouter des fichiers");
  await expect(page.getByTestId("drop-cue")).toContainText("Ajoutez un ou plusieurs fichiers");
  await expect(zone.locator('input[type="file"]')).toHaveAttribute("multiple", "");
  const anim = await page.locator(".pz-drop-arrow").evaluate((el) => getComputedStyle(el).animationName);
  expect(anim).toBe("pz-drop-nudge");
});

test("arrow stays still with prefers-reduced-motion", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await prepare(page);
  await page.goto("/");
  const anim = await page.locator(".pz-drop-arrow").evaluate((el) => getComputedStyle(el).animationName);
  expect(anim).toBe("none");
  await ctx.close();
});

test("drop several files on the home zone, add more, skip duplicates, remove, then send them all", async ({ browser }) => {
  const sender = await (await browser.newContext()).newPage();
  await prepare(sender);
  await sender.goto("/");

  // 1. Drag-drop two files onto the home drop zone.
  await dropFiles(sender, '[data-testid="dropzone"]', [
    { name: "un.txt", text: "premier fichier" },
    { name: "deux.txt", text: "deuxième fichier" },
  ]);
  const list = sender.getByTestId("review-files");
  await expect(list.locator("li")).toHaveCount(2);
  await expect(sender.getByTestId("files-summary")).toHaveText(/^2 fichiers · .+ au total$/);

  // 2. "Ajouter des fichiers" button (picker, multiple) — one duplicate is skipped.
  const big = randomBytes(300 * 1024);
  await expect(sender.getByTestId("add-files")).toHaveText(/Ajouter des fichiers/);
  await sender.getByTestId("add-files-input").setInputFiles([
    { name: "gros.bin", mimeType: "application/octet-stream", buffer: big },
    { name: "trois.txt", mimeType: "text/plain", buffer: Buffer.from("troisième") },
  ]);
  await expect(list.locator("li")).toHaveCount(4);
  await dropFiles(sender, '[data-testid="review-step"]', [
    { name: "un.txt", text: "premier fichier" }, // same name/size/date → skipped
    { name: "quatre.txt", text: "quatrième" },
  ]);
  await expect(list.locator("li")).toHaveCount(5);
  await expect(sender.getByTestId("review-step")).toContainText("Vous allez envoyer 5 fichiers.");

  // 3. Remove one file individually.
  await sender.getByRole("button", { name: "Retirer trois.txt" }).click();
  await expect(list.locator("li")).toHaveCount(4);
  await expect(list).not.toContainText("trois.txt");
  await expect(sender.getByTestId("files-summary")).toHaveText(/^4 fichiers · /);

  // 4. Send and receive everything.
  await sender.getByTestId("start-send").click();
  const link = await sender.getByTestId("p2p-link").inputValue();
  const receiver = await (await browser.newContext({ acceptDownloads: true })).newPage();
  await prepare(receiver, true);
  await receiver.goto(link.replace(/^https?:\/\/[^/]+/, ""));
  await expect(receiver.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "ready", { timeout: 45_000 });
  for (const n of ["un.txt", "deux.txt", "gros.bin", "quatre.txt"]) await expect(receiver.getByTestId("p2p-files")).toContainText(n);
  await expect(receiver.getByTestId("p2p-files")).not.toContainText("trois.txt");

  const got: import("@playwright/test").Download[] = [];
  receiver.on("download", (d) => got.push(d));
  await receiver.getByTestId("p2p-download").click();
  await expect(receiver.getByTestId("p2p-recv-status")).toHaveAttribute("data-status", "complete", { timeout: 45_000 });
  await expect.poll(() => got.length).toBe(4);
  const byName = Object.fromEntries(await Promise.all(got.map(async (d) => [d.suggestedFilename(), readFileSync((await d.path())!)])));
  expect(sha(byName["gros.bin"])).toBe(sha(big));
  expect(byName["un.txt"].toString()).toBe("premier fichier");
  expect(byName["deux.txt"].toString()).toBe("deuxième fichier");
  expect(byName["quatre.txt"].toString()).toBe("quatrième");
});
