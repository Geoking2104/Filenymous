/**
 * Vite plugin: prerendered, crawlable content and agent-discoverability files.
 *  - index.html: FR meta/OG/canonical/hreflang/JSON-LD + static home content
 *    inside #root (React replaces it on mount; dev and build alike).
 *  - build: static feature/FAQ/EN pages under the app base, /app/llms*.txt,
 *    and ui/dist-root/ (robots.txt, sitemap.xml, llms.txt, llms-full.txt) for
 *    the web root, uploaded separately by deploy-ovh-ui.yml.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appHead, homeBody, STATIC_CSS, staticPages, sitemapXml, robotsTxt, llmsTxt, llmsFullTxt } from "./render.mjs";
import { UI } from "./content.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export function rootFiles() {
  return { "robots.txt": robotsTxt(), "sitemap.xml": sitemapXml(), "llms.txt": llmsTxt(), "llms-full.txt": llmsFullTxt() };
}

/** The privacy-guarded Umami block of index.html (guard + tracker), or "". */
export function umamiSnippet(html) {
  const m = html.match(/<script>\s*window\.__fnUmamiBeforeSend[\s\S]*?<\/script>\s*<script[^>]*umami\/script\.js[\s\S]*?<\/script>/);
  return m ? m[0] : "";
}

export default function filenymousSeo() {
  let isBuild = false;
  // Same privacy-guarded Umami snippet as the app (copied from index.html).
  let analytics = "";
  return {
    name: "filenymous-seo",
    configResolved(c) {
      isBuild = c.command === "build";
      analytics = umamiSnippet(readFileSync(resolve(c.root, "index.html"), "utf8"));
    },
    transformIndexHtml(html) {
      return html
        .replace(/<meta name="description"[^>]*\/>\s*/, "")
        .replace("<title>Filenymous</title>", `<title>${UI.fr.homeTitle}</title>\n    ${appHead()}\n    <style>${STATIC_CSS}</style>`)
        .replace('<div id="root"></div>', `<div id="root">${homeBody("fr", { isApp: true })}</div>`);
    },
    generateBundle() {
      if (!isBuild) return;
      for (const [fileName, source] of Object.entries(staticPages({ analytics }))) this.emitFile({ type: "asset", fileName, source });
      this.emitFile({ type: "asset", fileName: "llms.txt", source: llmsTxt() });
      this.emitFile({ type: "asset", fileName: "llms-full.txt", source: llmsFullTxt() });
    },
    closeBundle() {
      if (!isBuild) return;
      const out = resolve(here, "../dist-root");
      mkdirSync(out, { recursive: true });
      for (const [name, body] of Object.entries(rootFiles())) writeFileSync(resolve(out, name), body);
    },
  };
}
