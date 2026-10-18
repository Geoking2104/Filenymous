import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM module without types
import * as seo from "../seo/render.mjs";
// @ts-expect-error plain ESM module without types
import { FEATURES, SITE } from "../seo/content.mjs";

const ORIGIN = "https://filenymous.eu";
const urlsIn = (s: string) => s.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];

describe("SEO / agent discoverability output", () => {
  it("sitemap lists absolute public URLs only: no fragment, no query, reciprocal hreflang", () => {
    const xml: string = seo.sitemapXml();
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs.length).toBe(2 * (2 + FEATURES.length));
    expect(new Set(locs).size).toBe(locs.length);
    for (const u of urlsIn(xml).filter((u) => u.startsWith(ORIGIN))) {
      expect(u).not.toMatch(/[#?]/);
      expect(u.startsWith(`${ORIGIN}/app/`)).toBe(true);
    }
    for (const { alt } of seo.pages()) {
      for (const l of ["fr", "en"]) expect(xml).toContain(`hreflang="${l}" href="${ORIGIN}${alt[l]}"`);
    }
  });

  it("every sitemap URL has a static page (or is the app)", () => {
    const pages = seo.staticPages() as Record<string, string>;
    for (const { alt } of seo.pages()) {
      for (const l of ["fr", "en"]) {
        const p: string = alt[l];
        if (p === SITE.app) continue;
        expect(pages[p.slice(SITE.app.length) + "index.html"], p).toBeTruthy();
      }
    }
  });

  it("static pages are self-contained HTML with canonical, hreflang, valid JSON-LD and no fragment links but documented entry points", () => {
    const pages = seo.staticPages() as Record<string, string>;
    for (const [name, html] of Object.entries(pages)) {
      expect(html, name).toMatch(/^<!DOCTYPE html>/);
      expect(html).toMatch(/<html lang="(fr|en)">/);
      expect(html).toContain('rel="canonical"');
      expect(html).toContain('hreflang="x-default"');
      expect(html).toMatch(/<h1>[^<]+<\/h1>/);
      for (const m of html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)) expect(() => JSON.parse(m[1])).not.toThrow();
      for (const u of urlsIn(html)) {
        const hash = u.split("#")[1]?.replace(/[.,;:]+$/, "");
        if (hash !== undefined) expect(["drop-new", "secret-new", "report-new", "wall-new"]).toContain(hash);
      }
      expect(html).not.toMatch(/file\.?pizza/i);
    }
  });

  it("robots.txt allows all public pages and names the main AI crawlers", () => {
    const r: string = seo.robotsTxt();
    expect(r).not.toMatch(/Disallow:\s*\/\S*/);
    for (const a of ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "PerplexityBot", "Google-Extended", "Applebot-Extended", "MistralAI-User", "GrokBot"]) expect(r).toContain(`User-agent: ${a}`);
    expect(r).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
  });

  it("llms.txt follows the llmstxt.org shape and warns about secrets and AI-created secrets", () => {
    const t: string = seo.llmsTxt();
    expect(t.split("\n")[0]).toBe("# Filenymous");
    expect(t).toMatch(/\n> .+/);
    expect(t).toMatch(/\n## Features\n/);
    expect(t).toMatch(/assistant and its provider see the plaintext/);
    const full: string = seo.llmsFullTxt();
    expect(full).toContain("#s:<id>/<key>");
    expect(full).not.toMatch(/#s:[A-Za-z0-9_-]{22}\//); // patterns only, never a real id
    expect(full.length).toBeLessThan(60_000);
  });

  it("app head carries FR title/description, OG image and parseable JSON-LD", () => {
    const h: string = seo.appHead();
    expect(h).toContain('<link rel="canonical" href="https://filenymous.eu/app/" />');
    expect(h).toContain('property="og:image" content="https://filenymous.eu/app/og/filenymous-og.png"');
    for (const m of h.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)) expect(JSON.parse(m[1])["@context"]).toBe("https://schema.org");
    expect(seo.homeBody("fr", { isApp: true })).toContain("<h1>Partagez en toute confiance, sans compte ni nuage.</h1>");
    expect(seo.homeBody("en", { isApp: false })).toContain("<h1>Share with confidence, no account, no cloud.</h1>");
  });
});

describe("static pages analytics", () => {
  it("reuse the exact privacy-guarded Umami block of index.html", async () => {
    // @ts-expect-error plain ESM module without types
    const { umamiSnippet } = await import("../seo/vite-plugin.mjs");
    const { readFileSync } = await import("node:fs");
    const snip: string = umamiSnippet(readFileSync(`${process.cwd()}/index.html`, "utf8"));
    expect(snip).toContain('data-exclude-hash="true"');
    expect(snip).toContain('data-exclude-search="true"');
    expect(snip).toContain('data-do-not-track="true"');
    expect(snip).toContain("/^#(s:|report|wall)/");
    const pages = seo.staticPages({ analytics: snip }) as Record<string, string>;
    for (const html of Object.values(pages)) expect(html).toContain(snip);
  });
});
