/**
 * E2E: Sharewall — live multi-peer wall, star topology around the host's tab,
 * through a locally started p2p-signal relay. Three browser contexts.
 */
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createWall as create, fixture, guarded, item, items, join, local, msg, newPage as open, say, sendNote, sha, snippet, startRelay, type Relay } from "./wall-helpers";
import type { Browser, Page } from "@playwright/test";

let relay: Relay;
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  relay = await startRelay();
});
test.afterAll(() => {
  relay?.proc.kill();
});
const newPage = (browser: Browser, opts: { fakeClock?: boolean } = {}) => open(browser, relay.url, opts);
const createWall = (p: Page, o: Parameters<typeof create>[1] = {}) => create(p, o);

test("3 contexts: live grid, snippets, previews, identical downloads, kill switch", async ({ browser }) => {
  test.setTimeout(120_000);
  const host = await newPage(browser);
  const { link } = await createWall(host.page, { ttl: "h1", hostLeave: false });
  expect(link).toMatch(/\/#wall:wall-[a-f0-9]{24}\/[A-Za-z0-9_-]{43}\/[0-9a-z]+\/n$/);
  const key = link.split("/").slice(-3)[0]!;
  const hostSecret = host.page.url().split("#wall-host:")[1]!.split("/")[0]!;
  const code = await host.page.getByTestId("wall-code").locator("strong").textContent();
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  // Nobody connected yet: closing the host tab is not guarded.
  expect(await guarded(host.page)).toBe(false);

  const [a, b] = await Promise.all([newPage(browser), newPage(browser)]);
  await join(a.page, link);
  await join(b.page, link);
  await expect(host.page.getByTestId("wall-host")).toHaveAttribute("data-peers", "2");
  // Same verification code everywhere.
  await expect(a.page.getByTestId("wall-code").locator("strong")).toHaveText(code!);
  await expect(b.page.getByTestId("wall-code").locator("strong")).toHaveText(code!);
  // With peers connected, the host's tab asks before closing.
  expect(await guarded(host.page)).toBe(true);

  // Peers drop files and a snippet; the host drops an image.
  const big = randomBytes(900 * 1024 + 123);
  const note = "Bonjour le mur !\nligne 2 <script>alert(1)</script>";
  const secret = "API_KEY=sk-test-" + randomBytes(8).toString("hex");
  await a.page.getByTestId("wall-file-input").setInputFiles([
    { name: "big.bin", mimeType: "application/octet-stream", buffer: big },
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from(note) },
  ]);
  await sendNote(a.page, secret);
  await b.page.getByTestId("wall-file-input").setInputFiles([
    { name: "clip.webm", mimeType: "video/webm", buffer: fixture("stream-sample.webm") },
    { name: "doc.pdf", mimeType: "application/pdf", buffer: fixture("author.pdf") },
  ]);
  await sendNote(b.page, "note de B");
  await host.page.getByTestId("wall-file-input").setInputFiles([{ name: "photo.jpg", mimeType: "image/jpeg", buffer: fixture("exif-gps.jpg") }]);

  // Everyone sees the same live grid of 7 items.
  for (const p of [host.page, a.page, b.page]) await expect(items(p)).toHaveCount(7, { timeout: 30_000 });

  // Snippets are masked until revealed, then readable and copyable.
  const aSecretOnB = snippet(b.page).and(b.page.locator('[data-by="peer:1"]'));
  await expect(aSecretOnB.locator(".is-masked")).toBeVisible();
  await expect(b.page.getByText(secret)).toHaveCount(0);
  await aSecretOnB.getByTestId("wall-reveal").click();
  await expect(aSecretOnB.getByTestId("wall-secret-text")).toHaveText(secret);
  await aSecretOnB.getByTestId("wall-copy").click();
  expect(await b.page.evaluate(() => navigator.clipboard.readText())).toBe(secret);
  await aSecretOnB.getByTestId("wall-hide").click();
  await expect(aSecretOnB.locator(".is-masked")).toBeVisible();

  // Images/videos appear inline in the feed for everyone (non-burn wall), from memory.
  const inline = item(b.page, "photo.jpg").getByTestId("wall-inline-img");
  await expect(inline).toBeVisible({ timeout: 15_000 });
  expect(await inline.getAttribute("src")).toMatch(/^blob:/);
  await expect(item(host.page, "clip.webm").getByTestId("wall-inline-video")).toBeVisible();

  // Previews from memory: image, video, text (as text, script not executed), PDF download only.
  await item(a.page, "photo.jpg").getByTestId("wall-preview").click();
  const img = a.page.getByTestId("wall-preview-img");
  await expect(img).toBeVisible();
  expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  expect(await img.getAttribute("src")).toMatch(/^blob:/);
  const imgUrl = (await img.getAttribute("src"))!;
  await a.page.getByTestId("wall-preview-close").click();
  // The Blob URL is revoked when the previewer closes.
  expect(await a.page.evaluate((u) => fetch(u).then(() => "alive", () => "revoked"), imgUrl)).toBe("revoked");

  await item(a.page, "clip.webm").getByTestId("wall-preview").click();
  const video = a.page.getByTestId("wall-preview-video");
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  await a.page.keyboard.press("Escape");
  await expect(a.page.getByTestId("wall-previewer")).toHaveCount(0);

  let dialogs = 0;
  b.page.on("dialog", (d) => {
    dialogs++;
    void d.accept();
  });
  await item(b.page, "notes.txt").getByTestId("wall-preview").click();
  await expect(b.page.getByTestId("wall-preview-text")).toHaveText(note);
  expect(await b.page.evaluate(() => document.querySelectorAll(".sw-modal script").length)).toBe(0);
  await b.page.getByTestId("wall-preview-close").click();
  await expect(item(b.page, "doc.pdf").getByTestId("wall-preview")).toHaveCount(0);

  // Downloads are byte-identical (sha256) for another peer and for the host.
  const dl = b.page.waitForEvent("download");
  await item(b.page, "big.bin").getByTestId("wall-download").click();
  const got = readFileSync((await (await dl).path())!);
  expect(sha(got)).toBe(sha(big));
  const dl2 = host.page.waitForEvent("download");
  await item(host.page, "clip.webm").getByTestId("wall-download").click();
  const d2 = await dl2;
  expect(d2.suggestedFilename()).toBe("clip.webm");
  expect(sha(readFileSync((await d2.path())!))).toBe(sha(fixture("stream-sample.webm")));
  expect(dialogs).toBe(0); // no burn on this wall: no confirmation

  // The relay never received the key, the host secret from a peer, a file name or any content.
  for (const c of [host, a, b]) {
    const all = c.sent.join("\n");
    expect(all).not.toContain(key);
    expect(all).not.toContain(secret);
    expect(all).not.toContain("big.bin");
    if (c !== host) expect(all).not.toContain(hostSecret);
  }
  // Nothing about the wall was written to browser storage.
  for (const p of [host.page, a.page, b.page]) {
    const stored = await p.evaluate(async () => {
      const ls = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
      const dbs = (await indexedDB.databases?.())?.map((d) => d.name) ?? [];
      return { ls, dbs };
    });
    expect(stored.ls).not.toContain(key);
    expect(stored.ls).not.toContain(secret);
    expect(stored.dbs.filter((n) => /wall/i.test(n ?? ""))).toEqual([]);
  }

  // A peer can leave: it wipes its copy, the others keep going.
  b.page.removeAllListeners("dialog");
  b.page.once("dialog", (d) => void d.accept());
  await b.page.getByTestId("wall-leave").click();
  await expect(b.page.getByTestId("wall-ended")).toHaveAttribute("data-reason", "left");
  await expect(host.page.getByTestId("wall-host")).toHaveAttribute("data-peers", "1");

  // Kill switch: the host destroys the wall, peers wipe, the relay closes the room.
  host.page.once("dialog", (d) => void d.accept());
  await host.page.getByTestId("wall-destroy").click();
  await expect(host.page.getByTestId("wall-ended")).toHaveAttribute("data-reason", "destroyed");
  await expect(a.page.getByTestId("wall-ended")).toHaveAttribute("data-reason", "destroyed", { timeout: 10_000 });
  await expect(a.page.getByTestId("wall-item")).toHaveCount(0);
  expect(await guarded(host.page)).toBe(false);
  // The link is dead: a new visitor gets "destroyed" from the relay.
  await b.page.goto("about:blank");
  await b.page.goto(local(link));
  await expect(b.page.getByTestId("wall-ended")).toHaveAttribute("data-reason", "destroyed", { timeout: 10_000 });
});

test("password + burn after one download; the host sees the item disappear", async ({ browser }) => {
  test.setTimeout(90_000);
  const host = await newPage(browser);
  const { link } = await createWall(host.page, { burn: true, password: "pa55-wall" });
  expect(link).toMatch(/\/p1h$/);
  expect(link).not.toContain("pa55-wall");
  const [a, b] = await Promise.all([newPage(browser), newPage(browser)]);

  // Wrong password is refused, the right one joins.
  await a.page.goto(local(link));
  await a.page.getByTestId("drop-password-input").fill("wrong");
  await a.page.getByTestId("drop-password-submit").click();
  await expect(a.page.getByTestId("drop-password-gate").getByRole("alert")).toBeVisible({ timeout: 20_000 });
  await a.page.getByTestId("drop-password-input").fill("pa55-wall");
  await a.page.getByTestId("drop-password-submit").click();
  await expect(a.page.getByTestId("wall-peer-status")).toHaveAttribute("data-status", "online", { timeout: 20_000 });
  await join(b.page, link, "pa55-wall");

  const payload = randomBytes(200 * 1024);
  await a.page.getByTestId("wall-file-input").setInputFiles([{ name: "once.bin", mimeType: "application/octet-stream", buffer: payload }]);
  for (const p of [host.page, a.page, b.page]) await expect(item(p, "once.bin")).toHaveCount(1, { timeout: 20_000 });

  // The author re-downloading its own item does not burn it.
  const own = a.page.waitForEvent("download");
  await item(a.page, "once.bin").getByTestId("wall-download").click();
  await own;
  await expect(item(host.page, "once.bin")).toHaveCount(1);

  // B downloads it (after a confirmation): gone from the wall for everyone else.
  let confirmText = "";
  b.page.once("dialog", (d) => {
    confirmText = d.message();
    void d.accept();
  });
  const dl = b.page.waitForEvent("download");
  await item(b.page, "once.bin").getByTestId("wall-download").click();
  expect(sha(readFileSync((await (await dl).path())!))).toBe(sha(payload));
  expect(confirmText).toContain("s'autodétruit");
  await expect(item(host.page, "once.bin")).toHaveCount(0, { timeout: 10_000 });
  // Those who already fetched it (B, and A who re-downloaded its own file) keep a
  // local in-memory copy, marked as such, until the wall is wiped.
  await expect(item(b.page, "once.bin").locator(".sw-chip")).toBeVisible();
  await expect(item(a.page, "once.bin").locator(".sw-chip")).toBeVisible({ timeout: 10_000 });

  host.page.once("dialog", (d) => void d.accept());
  await host.page.getByTestId("wall-destroy").click();
  await expect(b.page.getByTestId("wall-ended")).toHaveAttribute("data-reason", "destroyed", { timeout: 10_000 });
});

test("TTL expiry (fake clock) wipes host and peers", async ({ browser }) => {
  test.setTimeout(90_000);
  const host = await newPage(browser, { fakeClock: true });
  const { link } = await createWall(host.page, { ttl: "m15", hostLeave: false });
  const a = await newPage(browser, { fakeClock: true });
  await join(a.page, link);
  await sendNote(a.page, "éphémère");
  await expect(snippet(host.page)).toHaveCount(1, { timeout: 15_000 });
  await expect(host.page.getByTestId("wall-countdown")).toContainText(/1[45]:\d\d/);

  await a.page.clock.fastForward("16:00");
  await host.page.clock.fastForward("16:00");
  await expect(a.page.getByTestId("wall-ended")).toHaveAttribute("data-reason", "expired", { timeout: 10_000 });
  await expect(host.page.getByTestId("wall-ended")).toHaveAttribute("data-reason", "expired", { timeout: 10_000 });
  await expect(a.page.getByTestId("wall-item")).toHaveCount(0);
});

test("destroy-on-host-leave: closing the host tab wipes every peer", async ({ browser }) => {
  test.setTimeout(90_000);
  const host = await newPage(browser);
  const { link } = await createWall(host.page, { ttl: "h1" }); // option on by default
  expect(link).toMatch(/\/nh$/);
  const [a, b] = await Promise.all([newPage(browser), newPage(browser)]);
  await join(a.page, link);
  await join(b.page, link);
  await a.page.getByTestId("wall-file-input").setInputFiles([{ name: "x.txt", mimeType: "text/plain", buffer: Buffer.from("x") }]);
  await expect(item(b.page, "x.txt")).toHaveCount(1, { timeout: 15_000 });
  await host.page.close({ runBeforeUnload: false });
  for (const p of [a.page, b.page]) {
    await expect(p.getByTestId("wall-ended")).toHaveAttribute("data-reason", "host-left", { timeout: 15_000 });
    await expect(p.getByTestId("wall-item")).toHaveCount(0);
  }
  // After the grace period the relay has closed the room for good.
  await a.page.waitForTimeout(1500);
  await a.page.goto("about:blank");
  await a.page.goto(local(link));
  await expect(a.page.getByTestId("wall-ended")).toHaveAttribute("data-reason", "destroyed", { timeout: 10_000 });
});

test("3 contexts: live feed, emoji picker, reactions, replies, mentions, poll, raise hand, bursts, pin, typing, rate limit", async ({ browser }) => {
  test.setTimeout(120_000);
  const host = await newPage(browser);
  const { link } = await createWall(host.page, { hostLeave: false });
  const [a, b] = await Promise.all([newPage(browser), newPage(browser)]);
  await join(a.page, link);
  await join(b.page, link);
  for (const p of [host.page, a.page, b.page]) await expect(p.getByTestId("wall-member")).toHaveCount(3);

  // A renames itself; everyone sees the new name, with a host badge on the host.
  await a.page.locator('[data-testid="wall-member"][data-label="peer:1"]').getByTestId("wall-name-edit").click();
  await a.page.getByTestId("wall-name-input").fill("Alice");
  await a.page.getByTestId("wall-name-input").press("Enter");
  await expect(b.page.locator('[data-testid="wall-member"][data-label="peer:1"]')).toContainText("Alice");
  await expect(b.page.locator('[data-testid="wall-member"][data-host="true"]')).toContainText("Hôte");

  // Typing indicator, then a message with markdown-lite; HTML stays text.
  await a.page.getByTestId("wall-msg-input").pressSequentially("Sal", { delay: 30 });
  await expect(b.page.getByTestId("wall-typing")).toContainText("Alice", { timeout: 5000 });
  await a.page.getByTestId("wall-msg-input").fill('Salut **tout le monde** <img src=x onerror="window.__pwned=1"> `code`');
  await a.page.getByTestId("wall-msg-send").click();
  await expect(msg(b.page, "tout le monde")).toBeVisible();
  const m1Id = (await msg(b.page, "tout le monde").getAttribute("data-id"))!;
  const byId = (p: Page) => p.locator(`[data-id="${m1Id}"]`);
  const m1 = byId(b.page);
  await expect(m1.locator("strong")).toHaveText("tout le monde");
  await expect(m1.locator("code")).toHaveText("code");
  expect(await b.page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(await m1.locator("img").count()).toBe(0);
  // Consecutive messages are grouped under one author header.
  await say(a.page, "deuxième message");
  await expect(msg(b.page, "deuxième message")).toBeVisible();
  await expect(msg(b.page, "deuxième message")).not.toHaveClass(/is-first/);

  // Emoji picker (bundled): search, insert into the composer, send.
  await b.page.getByTestId("wall-emoji-toggle").click();
  await expect(b.page.getByTestId("wall-emoji-picker")).toBeVisible();
  await b.page.getByTestId("wall-emoji-search").fill("fusée");
  await b.page.locator('[data-testid="wall-emoji"][data-emoji="🚀"]').click();
  await b.page.keyboard.press("Escape");
  await expect(b.page.getByTestId("wall-msg-input")).toHaveValue("🚀");
  await b.page.getByTestId("wall-msg-input").press("End");
  await b.page.getByTestId("wall-msg-input").pressSequentially(" on décolle");
  await b.page.getByTestId("wall-msg-input").press("Enter");
  await expect(msg(host.page, "🚀 on décolle")).toBeVisible();

  // Reactions: quick bar + picker; counts and who reacted, live for everyone.
  const m1a = byId(a.page);
  const m1h = byId(host.page);
  await m1h.hover();
  await m1h.locator('[data-testid="wall-quick-react"][data-emoji="👍"]').click();
  await m1.hover();
  await m1.locator('[data-testid="wall-quick-react"][data-emoji="👍"]').click();
  await m1.getByTestId("wall-react-more").click();
  await b.page.getByTestId("wall-emoji-search").fill("party");
  await b.page.locator('[data-testid="wall-emoji"][data-emoji="🎉"]').click();
  const thumbs = m1a.locator('[data-testid="wall-reaction"][data-emoji="👍"]');
  await expect(thumbs).toHaveAttribute("data-count", "2");
  await expect(thumbs).toHaveAttribute("title", /Hôte|Loutre|Renard|Hibou|Lynx|Panda|Koala|Faucon|Dauphin|Castor|Hérisson|Lama|Tigre|Manchot|Écureuil|Baleine|Colibri/);
  await expect(m1a.locator('[data-testid="wall-reaction"][data-emoji="🎉"]')).toHaveAttribute("data-count", "1");
  // Toggling off.
  await m1.locator('[data-testid="wall-reaction"][data-emoji="🎉"]').click();
  await expect(m1a.locator('[data-testid="wall-reaction"][data-emoji="🎉"]')).toHaveCount(0);

  // Reply + @mention: the mentioned member sees the message highlighted.
  await m1h.hover();
  await m1h.getByTestId("wall-reply").click();
  await expect(host.page.getByTestId("wall-replying")).toContainText("Alice");
  await host.page.getByTestId("wall-msg-input").pressSequentially("Bienvenue @Ali");
  await expect(host.page.getByTestId("wall-mention-list")).toBeVisible();
  await host.page.getByTestId("wall-msg-input").press("Enter"); // picks the suggestion
  await expect(host.page.getByTestId("wall-msg-input")).toHaveValue("Bienvenue @Alice ");
  await host.page.getByTestId("wall-msg-input").press("Enter");
  const reply = msg(a.page, "Bienvenue");
  await expect(reply).toHaveClass(/is-mention/);
  await expect(reply.locator(".sw2-replyref")).toContainText("tout le monde");
  await expect(reply.locator('.sw2-mention.is-me')).toHaveText("@Alice");

  // Quick poll created by a peer, votes from all three, live results, closed by its author.
  await b.page.getByTestId("wall-poll-toggle").click();
  await b.page.getByTestId("wall-poll-question").fill("On commande quoi ?");
  await b.page.getByTestId("wall-poll-option").nth(0).fill("Pizza");
  await b.page.getByTestId("wall-poll-option").nth(1).fill("Sushi");
  await b.page.getByTestId("wall-poll-add").click();
  await b.page.getByTestId("wall-poll-option").nth(2).fill("Salade");
  await b.page.getByTestId("wall-poll-submit").click();
  for (const p of [host.page, a.page, b.page]) await expect(p.getByTestId("wall-poll")).toHaveCount(1);
  await host.page.locator('[data-testid="wall-poll-vote"][data-index="0"]').click();
  await a.page.locator('[data-testid="wall-poll-vote"][data-index="0"]').click();
  await b.page.locator('[data-testid="wall-poll-vote"][data-index="1"]').click();
  await expect(b.page.locator('[data-testid="wall-poll-vote"][data-index="0"]')).toHaveAttribute("data-count", "2");
  await expect(a.page.getByTestId("wall-poll-total")).toHaveText("3 votes");
  // Changing one's vote moves it.
  await a.page.locator('[data-testid="wall-poll-vote"][data-index="2"]').click();
  await expect(host.page.locator('[data-testid="wall-poll-vote"][data-index="2"]')).toHaveAttribute("data-count", "1");
  await b.page.getByTestId("wall-poll-close").click();
  await expect(a.page.locator('[data-testid="wall-poll-vote"][data-index="0"]')).toBeDisabled();

  // Raise hand: visible to the others in the member list.
  await a.page.getByTestId("wall-hand").click();
  await expect(host.page.locator('[data-testid="wall-member"][data-label="peer:1"]')).toHaveAttribute("data-hand", "true");
  await a.page.getByTestId("wall-hand").click();
  await expect(host.page.locator('[data-testid="wall-member"][data-label="peer:1"]')).toHaveAttribute("data-hand", "false");

  // Applause burst: animated on the others' screens.
  await b.page.getByTestId("wall-burst-applause").click();
  await expect(host.page.getByTestId("wall-burst-layer").locator(".sw2-burst-p").first()).toBeVisible();
  await expect(a.page.getByTestId("wall-burst-layer").locator(".sw2-burst-p").first()).toBeVisible();

  // Pin (host only): peers see the pinned bar and have no pin button.
  await m1h.hover();
  await m1h.getByTestId("wall-pin").click();
  await expect(b.page.getByTestId("wall-pinned")).toContainText("tout le monde");
  await m1.hover();
  await expect(m1.getByTestId("wall-pin")).toHaveCount(0);

  // Per-participant rate limit at the host (loops/spam): a burst of 15 messages is cut.
  for (let i = 0; i < 15; i++) {
    await b.page.getByTestId("wall-msg-input").fill(`spam ${i}`);
    await b.page.getByTestId("wall-msg-input").press("Enter");
  }
  await expect(b.page.getByTestId("wall-notice")).toContainText("Doucement", { timeout: 5000 });
  await expect.poll(async () => host.page.getByTestId("wall-msg").filter({ hasText: /^.*spam \d+/ }).count(), { timeout: 5000 }).toBeLessThan(15);

  // Kick: the host disconnects B.
  host.page.once("dialog", (d) => void d.accept());
  await host.page.locator('[data-testid="wall-member"][data-label="peer:2"]').getByTestId("wall-kick").click();
  await expect(b.page.getByTestId("wall-ended")).toHaveAttribute("data-reason", "kicked", { timeout: 10_000 });
  await expect(host.page.getByTestId("wall-host")).toHaveAttribute("data-peers", "1");

  // Nothing of the conversation reached the relay.
  for (const c of [host, a, b]) {
    const all = c.sent.join("\n");
    for (const s of ["tout le monde", "Alice", "On commande", "Pizza", "🚀"]) expect(all).not.toContain(s);
  }
  host.page.once("dialog", (d) => void d.accept());
  await host.page.getByTestId("wall-destroy").click();
  await expect(a.page.getByTestId("wall-ended")).toHaveAttribute("data-reason", "destroyed", { timeout: 10_000 });
});
