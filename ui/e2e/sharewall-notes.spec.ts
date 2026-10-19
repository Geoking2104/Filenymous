/**
 * E2E: Sharewall shared notes with 3 browser contexts (host + 2 peers):
 * create/rename/edit, live propagation, "X est en train d'écrire",
 * concurrent edits (last writer wins + overwritten toast), delete
 * permissions, host pin, search over note text, export with notes.
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createWall, join, newPage as open, startRelay, type Relay } from "./wall-helpers";

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
const notesTab = (p: Page) => p.getByTestId("wall-tab-notes").click();
const row = (p: Page, title: string) => p.locator(`[data-testid="note-row"][data-title="${title}"]`);
const openNote = async (p: Page, title: string) => {
  await notesTab(p);
  await row(p, title).click();
  await expect(p.getByTestId("note-editor")).toBeVisible();
};

async function setup(browser: Browser) {
  const host = await newPage(browser);
  const { link } = await createWall(host.page, { name: "Notes" });
  const a = await newPage(browser);
  const b = await newPage(browser);
  await join(a.page, link);
  await join(b.page, link);
  return { host: host.page, a: a.page, b: b.page };
}

test("create, edit, live propagation, writing indicator, search and pin", async ({ browser }) => {
  const { host, a, b } = await setup(browser);
  await notesTab(a);
  await expect(a.getByTestId("notes-empty")).toBeVisible();
  await a.getByTestId("note-new").click();
  await expect(a.getByTestId("note-editor")).toBeVisible();
  await a.getByTestId("note-title").fill("Ordre du jour");
  await a.getByTestId("note-text").fill("1. **Budget** 2026\n2. Planning <b>pas de HTML</b>");
  for (const p of [host, b]) {
    await notesTab(p);
    await expect(row(p, "Ordre du jour")).toBeVisible();
  }
  // The writing indicator shows for the others while A holds the soft lock.
  await expect(row(b, "Ordre du jour").getByTestId("note-row-writing")).toBeVisible();
  await openNote(b, "Ordre du jour");
  await expect(b.getByTestId("note-text")).toHaveValue("1. **Budget** 2026\n2. Planning <b>pas de HTML</b>");
  await expect(b.getByTestId("note-writing")).toBeVisible();
  await b.getByTestId("note-preview-toggle").click();
  await expect(b.getByTestId("note-preview").locator("strong")).toHaveText("Budget");
  await expect(b.getByTestId("note-preview").locator("b")).toHaveCount(0); // HTML stays text
  await expect(b.getByTestId("note-preview")).toContainText("<b>pas de HTML</b>");
  await shot(b, "local-note-preview-peer");
  // A closes its editor: the soft lock is released for everyone.
  await a.getByTestId("note-close").click();
  await expect(b.getByTestId("note-writing")).toHaveCount(0);
  await expect(b.getByTestId("note-meta")).toContainText(/Modifiée par/);

  // Search finds note text and opens it.
  await host.getByTestId("wall-search").fill("budget");
  await expect(host.getByTestId("wall-search-note")).toHaveCount(1);
  await expect(host.getByTestId("wall-search-count")).toHaveAttribute("data-count", "1");
  await expect(host.getByTestId("wall-search-note").getByTestId("wall-search-hl").first()).toHaveText("Budget");
  await shot(host, "local-note-search");
  await host.getByTestId("wall-search-note").click();
  await expect(host.getByTestId("note-editor")).toBeVisible();
  await host.getByTestId("wall-search-clear").click();

  // Host pin: pinned notes come first for everyone; peers have no pin button.
  await b.getByTestId("note-close").click();
  await notesTab(b);
  await b.getByTestId("note-new").click();
  await b.getByTestId("note-title").fill("Note de B");
  await expect(row(host, "Note de B")).toBeVisible();
  await expect(b.getByTestId("note-pin")).toHaveCount(0);
  await host.getByTestId("note-pin").click();
  await expect(a.getByTestId("note-row").first()).toHaveAttribute("data-title", "Ordre du jour");
  await expect(a.getByTestId("note-row").first().getByTestId("note-pinned")).toBeVisible();
  await shot(host, "local-notes-host");
});

test("concurrent edits converge (last writer wins) and the overwritten editor is told", async ({ browser }) => {
  const { host, a, b } = await setup(browser);
  await notesTab(a);
  await a.getByTestId("note-new").click();
  await a.getByTestId("note-title").fill("Brouillon");
  await openNote(b, "Brouillon");
  // Sequential edit: B's editor (not dirty) adopts A's text.
  await a.getByTestId("note-text").fill("version A");
  await expect(b.getByTestId("note-text")).toHaveValue("version A");
  // Concurrent edits inside the debounce window: both are dirty at once.
  await Promise.all([a.getByTestId("note-text").fill("A écrit ceci"), b.getByTestId("note-text").fill("B écrit cela")]);
  await openNote(host, "Brouillon");
  await expect(async () => {
    const h = await host.getByTestId("note-text").inputValue();
    expect(["A écrit ceci", "B écrit cela"]).toContain(h);
  }).toPass();
  // The loser is told (toast) and everyone converges on the winner's text once idle.
  const toasts = async () => (await a.getByTestId("wall-notice").filter({ hasText: /remplacée/ }).count()) + (await b.getByTestId("wall-notice").filter({ hasText: /remplacée/ }).count());
  await expect.poll(toasts, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  const winner = await host.getByTestId("note-text").inputValue();
  const loser = winner === "A écrit ceci" ? b : a;
  await expect(loser.getByTestId("wall-notice")).toContainText(/a été remplacée/);
  await shot(loser, "local-note-overwritten");
  // The loser's editor shows the winner's text when it next receives an update; a fresh open shows it too.
  await loser.getByTestId("note-close").click();
  await openNote(loser, "Brouillon");
  await expect(loser.getByTestId("note-text")).toHaveValue(winner);
});

test("a peer can't lock others out, and deletes need author or host", async ({ browser }) => {
  const { host, a, b } = await setup(browser);
  await notesTab(a);
  await a.getByTestId("note-new").click();
  await a.getByTestId("note-title").fill("Note de A");
  await a.getByTestId("note-text").fill("A tient le verrou");
  await openNote(b, "Note de A");
  await expect(b.getByTestId("note-writing")).toBeVisible();
  // B is not blocked by A's soft lock: its edit lands everywhere.
  await b.getByTestId("note-text").fill("B passe quand même");
  await openNote(host, "Note de A");
  await expect(host.getByTestId("note-text")).toHaveValue("B passe quand même");
  // Delete: B (not the author) has no delete button; the host and A do.
  await expect(b.getByTestId("note-delete")).toHaveCount(0);
  await expect(host.getByTestId("note-delete")).toBeVisible();
  await expect(a.getByTestId("note-delete")).toBeVisible();
  await a.getByTestId("note-delete").click();
  await a.getByTestId("leave-confirm").click();
  for (const p of [host, a, b]) await expect(row(p, "Note de A")).toHaveCount(0);
  await expect(b.getByTestId("note-editor")).toHaveCount(0);
  // The host can delete a peer's note.
  await notesTab(b);
  await b.getByTestId("note-new").click();
  await b.getByTestId("note-title").fill("Note de B");
  await openNote(host, "Note de B");
  await host.getByTestId("note-delete").click();
  await host.getByTestId("leave-confirm").click();
  await expect(row(b, "Note de B")).toHaveCount(0);
});

test("host export contains the notes (JSON + Markdown)", async ({ browser }) => {
  const { host, a } = await setup(browser);
  await notesTab(a);
  await a.getByTestId("note-new").click();
  await a.getByTestId("note-title").fill("Compte rendu");
  await a.getByTestId("note-text").fill("On garde le **café**.");
  await notesTab(host);
  await expect(row(host, "Compte rendu")).toBeVisible();
  await expect.poll(async () => (await host.getByTestId("note-row").first().textContent()) ?? "").toContain("Compte rendu");
  await a.getByTestId("note-close").click(); // flush
  await host.getByTestId("wall-tab-members").click();
  await host.getByTestId("wall-export").click();
  const [dl] = await Promise.all([host.waitForEvent("download"), host.getByTestId("wall-export-confirm").click()]);
  const snap = JSON.parse(readFileSync((await dl.path())!, "utf8"));
  expect(snap.notes).toHaveLength(1);
  expect(snap.notes[0]).toMatchObject({ title: "Compte rendu", text: "On garde le **café**.", by: expect.stringMatching(/^peer:/) });
  await host.getByTestId("wall-export").click();
  await host.getByTestId("wall-export-format-md").check();
  const [md] = await Promise.all([host.waitForEvent("download"), host.getByTestId("wall-export-confirm").click()]);
  const text = readFileSync((await md.path())!, "utf8");
  expect(text).toContain("## Notes partagées");
  expect(text).toContain("On garde le **café**.");
});

test("mobile: notes live in the drawer and the editor opens in the main column", async ({ browser }) => {
  const host = await open(browser, relay.url, { viewport: { width: 390, height: 820 } });
  await createWall(host.page, { name: "Mobile" });
  await host.page.getByTestId("wall-members-toggle").click();
  await host.page.getByTestId("wall-tab-notes").click();
  await host.page.getByTestId("note-new").click();
  await expect(host.page.getByTestId("note-editor")).toBeVisible();
  await host.page.getByTestId("note-title").fill("Sur mobile");
  await host.page.getByTestId("note-text").fill("Liste de courses");
  await shot(host.page, "local-mobile-note");
});
