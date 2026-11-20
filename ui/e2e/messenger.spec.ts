/**
 * Messenger M1: the 💬 drawer opens over any app, a profile is created with a
 * photo (re-encoded to a small WebP with no EXIF/GPS), and two browsers become
 * friends through an invite link + reply link (mutual acceptance).
 * Set MSG_SHOTS=<dir> to save screenshots.
 */
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const SHOTS = process.env.MSG_SHOTS;
async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), animations: "disabled" });
}

/** A large camera-like JPEG (noise defeats compression) carrying the GPS EXIF block of the fixture. */
async function photoWithGps(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 1600;
    c.height = 1200;
    const ctx = c.getContext("2d")!;
    const g = ctx.createLinearGradient(0, 0, 1600, 1200);
    g.addColorStop(0, "#f59e0b");
    g.addColorStop(1, "#6366f1");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1600, 1200);
    const img = ctx.getImageData(0, 0, 1600, 1200);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (Math.random() - 0.5) * 90;
      img.data[i] += n;
      img.data[i + 1] += n;
      img.data[i + 2] += n;
    }
    ctx.putImageData(img, 0, 0);
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(800, 600, 300, 0, Math.PI * 2);
    ctx.fill();
    const blob = await new Promise<Blob>((ok) => c.toBlob((b) => ok(b!), "image/jpeg", 0.92));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  });
  const jpeg = Buffer.from(b64, "base64");
  const fixture = readFileSync(path.join(here, "fixtures/exif-gps.jpg"));
  // Copy the fixture's APP1 (Exif) segment right after SOI.
  let i = 2;
  let app1: Buffer | null = null;
  while (i < fixture.length && fixture[i] === 0xff) {
    const marker = fixture[i + 1]!;
    const len = fixture.readUInt16BE(i + 2);
    if (marker === 0xe1) app1 = fixture.subarray(i, i + 2 + len);
    i += 2 + len;
  }
  if (!app1) throw new Error("fixture has no EXIF");
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

async function storedAvatar(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((ok, ko) => {
      const r = indexedDB.open("fny-profile");
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ko(r.error);
    });
    const p = await new Promise<{ avatar?: Blob }>((ok) => {
      const r = db.transaction("kv").objectStore("kv").get("profile");
      r.onsuccess = () => ok(r.result);
    });
    const blob = p.avatar!;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const bmp = await createImageBitmap(blob);
    let ascii = "";
    for (const b of bytes) ascii += String.fromCharCode(b);
    return { type: blob.type, size: blob.size, w: bmp.width, h: bmp.height, hasExif: ascii.includes("Exif"), hasGpsRef: ascii.includes("GPS") };
  });
}

test("drawer on every app, profile with photo, friends by invite + reply", async ({ browser, baseURL }) => {
  const writes: string[] = [];
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  for (const c of [ctxA, ctxB]) c.on("request", (r) => ["POST", "PUT"].includes(r.method()) && writes.push(r.url()));
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  // 1. Document app: the drawer opens over it, the app stays mounted.
  await a.goto("/#document");
  await expect(a.getByTestId("doc-drop")).toBeVisible();
  await a.getByTestId("msg-button").click();
  await expect(a.getByTestId("msg-drawer")).toBeVisible();
  await expect(a.getByTestId("msg-profile-form")).toBeVisible();
  await expect(a.getByTestId("doc-drop")).toBeAttached();
  await shot(a, "1-document-drawer-empty");
  await a.keyboard.press("Escape");
  await expect(a.getByTestId("msg-drawer")).toHaveCount(0);

  // 2. Sharewall (host screen) has the button too.
  await a.goto("/#wall-new");
  await expect(a.getByTestId("service-head")).toHaveAttribute("data-service", "wall");
  await a.getByTestId("msg-button").click();
  await expect(a.getByTestId("msg-drawer")).toBeVisible();

  // 3. Profile with a GPS-tagged photo.
  await a.getByTestId("msg-name").fill("Alice");
  await a.getByTestId("msg-photo-input").setInputFiles({ name: "photo.jpg", mimeType: "image/jpeg", buffer: await photoWithGps(a) });
  await expect(a.getByTestId("msg-photo-preview")).toHaveJSProperty("tagName", "IMG");
  await shot(a, "2-profile-form-photo");
  await a.getByTestId("msg-create-profile").click();
  await expect(a.getByTestId("msg-friends")).toBeVisible();
  const av = await storedAvatar(a);
  expect(av.type).toBe("image/webp");
  expect(av.size).toBeLessThanOrEqual(48 * 1024);
  expect([av.w, av.h]).toEqual([256, 256]);
  expect(av.hasExif).toBe(false);
  expect(av.hasGpsRef).toBe(false);

  // 4. Invite link.
  await a.getByTestId("msg-tab-profile").click();
  await expect(a.getByTestId("msg-my-name")).toHaveText("Alice");
  await a.getByTestId("msg-make-invite").click();
  const invite = await a.getByTestId("msg-invite-link").inputValue();
  expect(invite).toContain("#contact:");
  await shot(a, "3-profile-invite-qr");

  // 5. Second browser opens it: invitation, profile, accept.
  await b.goto(new URL(invite.slice(invite.indexOf("#")), baseURL).toString());
  await expect(b.getByTestId("msg-drawer")).toBeVisible();
  expect(new URL(b.url()).hash).toBe("");
  await expect(b.getByTestId("msg-invites").getByTestId("msg-friend")).toHaveAttribute("data-name", "Alice");
  await shot(b, "4-invite-received");
  await b.getByTestId("msg-name").fill("Bob");
  await b.getByTestId("msg-create-profile").click();
  await b.getByTestId("msg-accept").click();
  const reply = await b.getByTestId("msg-reply-link").inputValue();
  await shot(b, "5-accepted-reply-link");
  await b.getByTestId("msg-tab-friends").click();
  await expect(b.getByTestId("msg-friends").getByTestId("msg-friend")).toHaveAttribute("data-name", "Alice");

  // 6. Back on A (still on Sharewall): the reply needs a confirmation.
  await a.getByTestId("msg-close").click();
  await a.evaluate((h) => (location.hash = h), reply.slice(reply.indexOf("#")));
  await expect(a.getByTestId("msg-drawer")).toBeVisible();
  await expect(a.getByTestId("service-head")).toHaveAttribute("data-service", "wall");
  await expect(a.getByTestId("msg-invites").getByTestId("msg-friend")).toHaveAttribute("data-status", "reply");
  await a.getByTestId("msg-confirm").click();
  await a.getByTestId("msg-tab-friends").click();
  const friendA = a.getByTestId("msg-friends").getByTestId("msg-friend");
  await expect(friendA).toHaveCount(1);
  await expect(friendA).toHaveAttribute("data-name", "Bob");
  await expect(friendA).toHaveAttribute("data-status", "friend");
  await shot(a, "6-friends-list");

  // 7. Persisted across reloads; B sees A as a friend.
  await b.reload();
  await b.getByTestId("msg-button").click();
  await expect(b.getByTestId("msg-friends").getByTestId("msg-friend")).toHaveAttribute("data-status", "friend");
  await shot(b, "7-friend-side-b");

  // Nothing was uploaded: invites travel in the # fragment only.
  expect(writes).toEqual([]);
  await ctxA.close();
  await ctxB.close();
});

test("mobile: drawer is a full-screen sheet", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true });
  const p = await ctx.newPage();
  await p.goto("/");
  await expect(p.getByTestId("msg-button")).toBeVisible();
  await shot(p, "0-mobile-header");
  await p.goto("/#document");
  await p.getByTestId("msg-button").click();
  const box = await p.getByTestId("msg-drawer").boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(388);
  await shot(p, "8-mobile-sheet");
  await ctx.close();
});
