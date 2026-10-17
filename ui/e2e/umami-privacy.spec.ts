/**
 * E2E (network): the Umami tracker never sends URL fragments (keys live there)
 * nor query strings, stays silent on secret/report pages and under DNT/GPC,
 * and leaves no cookie or storage. The app is served under its production
 * origin (https://filenymous.eu/app/ → local Vite) so data-domains matches; the
 * real tracker is loaded from www.opendpe.net and every /api/send is captured
 * and answered locally (nothing reaches the stats). Skipped when offline.
 */
import { test, expect, type BrowserContext, type Page } from "@playwright/test";

const SCRIPT = "https://www.opendpe.net/umami/script.js";
const LOCAL = "http://localhost:5173";

type Sent = { url: string; headers: Record<string, string>; body: { type: string; payload: Record<string, unknown> } };

async function online() {
  try {
    const r = await fetch(SCRIPT, { method: "GET" });
    return r.ok;
  } catch {
    return false;
  }
}

async function setup(ctx: BrowserContext, sent: Sent[]) {
  await ctx.route("https://filenymous.eu/**", async (route) => {
    const u = new URL(route.request().url());
    const path = u.pathname.replace(/^\/app(\/|$)/, "/");
    const r = await fetch(LOCAL + path + u.search, { headers: { accept: route.request().headers()["accept"] ?? "*/*" } });
    const body = Buffer.from(await r.arrayBuffer());
    await route.fulfill({ status: r.status, body, headers: { "content-type": r.headers.get("content-type") ?? "text/html" } });
  });
  await ctx.route("https://www.opendpe.net/umami/api/send", async (route) => {
    const req = route.request();
    if (req.method() === "POST") sent.push({ url: req.url(), headers: req.headers(), body: JSON.parse(req.postData() ?? "{}") });
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" }, body: "{}" });
  });
}

async function visit(ctx: BrowserContext, url: string, opts: { referer?: string } = {}): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(url, { referer: opts.referer, waitUntil: "load" });
  await page.waitForFunction(() => !!(window as unknown as { umami?: unknown }).umami, null, { timeout: 15_000 });
  await page.waitForTimeout(1200);
  return page;
}

const leaks = (s: Sent) => JSON.stringify(s.body);

test.describe("Umami tracker privacy", () => {
  test.beforeEach(async () => {
    test.skip(!(await online()), "tracker not reachable (offline)");
  });

  test("pageviews carry the path only — no #fragment, no ?query, no cookie", async ({ browser }) => {
    const ctx = await browser.newContext();
    const sent: Sent[] = [];
    await setup(ctx, sent);

    const p1 = await visit(ctx, "https://filenymous.eu/app/", { referer: "https://www.example.org/forum/thread?user=alice&token=t0k#anchor" });
    const p2p = "https://filenymous.eu/app/?utm_source=mail&token=Q5ecret#p2p:123-456-ABC/Zm9vYmFyU2VjcmV0S2V5MTIz/ekq2b8x";
    const p2 = await visit(ctx, p2p);
    // In-app navigation through history (tracker hooks pushState/replaceState).
    await p2.evaluate(() => history.pushState(null, "", "/app/?x=QS2#drop:abc/def"));
    await p2.waitForTimeout(800);

    expect(sent.length).toBeGreaterThanOrEqual(2);
    for (const s of sent) {
      const raw = leaks(s);
      expect(s.body.type).toBe("event");
      expect(s.body.payload.url).toBe("/app/");
      expect(raw).not.toMatch(/#|%23|\?|p2p:|drop:|Zm9vYmFy|Q5ecret|QS2|utm_|token|alice|anchor/);
      expect(s.headers["cookie"]).toBeUndefined();
      expect(s.body.payload.title).toBe("Filenymous");
      expect(s.body.payload.hostname).toBe("filenymous.eu");
    }
    expect(sent[0].body.payload.referrer).toBe("https://www.example.org/forum/thread");
    expect(await p1.evaluate(() => document.cookie)).toBe("");
    expect(await p1.evaluate(() => Object.keys(localStorage).filter((k) => /umami/i.test(k)))).toEqual([]);
    expect(await p1.evaluate(() => Object.keys(sessionStorage).filter((k) => /umami/i.test(k)))).toEqual([]);
    expect((await ctx.cookies()).length).toBe(0);
    console.log("sample payloads:\n" + sent.map((s) => JSON.stringify(s.body)).join("\n"));
    await ctx.close();
  });

  test("nothing is sent on secret-reveal and report pages", async ({ browser }) => {
    const ctx = await browser.newContext();
    const sent: Sent[] = [];
    await setup(ctx, sent);
    await visit(ctx, "https://filenymous.eu/app/#s:AbCdEf123/c2VjcmV0LWtleQ");
    await visit(ctx, "https://filenymous.eu/app/#report:org123/cHVibGljS2V5");
    await visit(ctx, "https://filenymous.eu/app/#report-inbox");
    expect(sent).toEqual([]);
    await ctx.close();
  });

  test("Do Not Track and Global Privacy Control switch it off", async ({ browser }) => {
    for (const flag of ["dnt", "gpc"] as const) {
      const ctx = await browser.newContext();
      await ctx.addInitScript((f) => {
        if (f === "dnt") Object.defineProperty(Navigator.prototype, "doNotTrack", { get: () => "1" });
        else Object.defineProperty(Navigator.prototype, "globalPrivacyControl", { get: () => true });
      }, flag);
      const sent: Sent[] = [];
      await setup(ctx, sent);
      await visit(ctx, "https://filenymous.eu/app/");
      expect(sent, flag).toEqual([]);
      await ctx.close();
    }
  });

  test("off on other hosts (localhost, previews)", async ({ page }) => {
    const sent: string[] = [];
    await page.route("https://www.opendpe.net/umami/api/send", (r) => (sent.push(r.request().url()), r.fulfill({ status: 200, body: "{}" })));
    await page.goto("/");
    await page.waitForTimeout(2000);
    expect(sent).toEqual([]);
  });
});
