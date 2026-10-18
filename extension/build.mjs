/**
 * Builds the Filenymous browser extension for Chrome (Manifest V3, offscreen
 * document) and Firefox (Manifest V2, persistent background page) from one
 * codebase, then zips each for store submission.
 *
 *   node build.mjs              → dist/chrome, dist/firefox, dist/filenymous-{chrome,firefox}-<version>.zip
 *   node build.mjs --e2e        → dist-e2e/chrome (local relay + app, test hooks)
 *
 * Env overrides: FN_APP_URL, FN_SIGNAL_URL.
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const e2e = process.argv.includes("--e2e");
const APP_URL = process.env.FN_APP_URL || (e2e ? "http://localhost:5173/" : "https://filenymous.eu/app/");
const SIGNAL_URL = process.env.FN_SIGNAL_URL || (e2e ? "ws://127.0.0.1:8789" : "wss://www.opendpe.net/filenymous-signal/");
const outRoot = join(here, e2e ? "dist-e2e" : "dist");
const targets = e2e ? ["chrome"] : ["chrome", "firefox"];

const NAME = "Filenymous : partage chiffré en 2 clics";
const DESCRIPTION = "Partage chiffré de bout en bout en un clic droit : fichiers en pair-à-pair, textes en lien secret à usage unique. Sans compte.";
const icons = { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" };

function manifest(target) {
  if (target === "chrome") {
    return {
      manifest_version: 3,
      name: NAME,
      short_name: "Filenymous",
      version: pkg.version,
      description: DESCRIPTION,
      homepage_url: "https://filenymous.eu/app/fonctionnalites/extension-navigateur/",
      icons,
      action: { default_popup: "popup.html", default_title: "Filenymous", default_icon: icons },
      background: { service_worker: "background.js", type: "module" },
      permissions: ["contextMenus", "clipboardWrite", "notifications", "offscreen", "activeTab", "scripting"],
      optional_host_permissions: ["https://*/*", "http://*/*"],
      minimum_chrome_version: "116",
    };
  }
  return {
    manifest_version: 2,
    name: NAME,
    short_name: "Filenymous",
    version: pkg.version,
    description: DESCRIPTION,
    homepage_url: "https://filenymous.eu/app/fonctionnalites/extension-navigateur/",
    icons,
    browser_action: { default_popup: "popup.html", default_title: "Filenymous", default_icon: icons },
    background: { page: "background.html", persistent: true },
    permissions: ["contextMenus", "clipboardWrite", "notifications", "activeTab"],
    optional_permissions: ["https://*/*", "http://*/*"],
    browser_specific_settings: {
      gecko: { id: "extension@filenymous.eu", strict_min_version: "115.0", data_collection_permissions: { required: ["none"] } },
    },
  };
}

// The web app's ui/src/p2p code is bundled as-is; only the device label is swapped.
const devicePlugin = {
  name: "extension-device",
  setup(b) {
    b.onResolve({ filter: /^\.\/device$/ }, (args) => (args.importer.includes("/ui/src/p2p/") ? { path: join(here, "src/device.ts") } : undefined));
  },
};

function walk(dir) {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
}

for (const target of targets) {
  const out = join(outRoot, target);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "icons"), { recursive: true });
  const entries = target === "chrome"
    ? { background: "src/background-chrome.ts", offscreen: "src/offscreen.ts", popup: "src/popup.ts", grant: "src/grant.ts" }
    : { background: "src/background-firefox.ts", popup: "src/popup.ts", grant: "src/grant.ts" };
  await build({
    entryPoints: Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, join(here, v)])),
    outdir: out,
    bundle: true,
    format: "esm",
    splitting: false,
    target: target === "chrome" ? "chrome116" : "firefox115",
    // Not minified: store reviewers (AMO) read the shipped code.
    minify: false,
    legalComments: "none",
    charset: "utf8",
    logLevel: "warning",
    define: {
      __APP_URL__: JSON.stringify(APP_URL),
      __SIGNAL_URL__: JSON.stringify(SIGNAL_URL),
      __BROWSER__: JSON.stringify(target),
      __VERSION__: JSON.stringify(pkg.version),
      __E2E__: JSON.stringify(e2e),
    },
    plugins: [devicePlugin],
  });
  for (const f of ["popup.html", "popup.css", "grant.html", target === "chrome" ? "offscreen.html" : "background.html"]) cpSync(join(here, "static", f), join(out, f));
  const iconSrc = resolve(here, "../ui/public/icons");
  cpSync(join(iconSrc, "favicon-16.png"), join(out, "icons/icon-16.png"));
  cpSync(join(iconSrc, "favicon-32.png"), join(out, "icons/icon-32.png"));
  cpSync(join(iconSrc, "icon-48.png"), join(out, "icons/icon-48.png"));
  cpSync(join(iconSrc, "icon-128.png"), join(out, "icons/icon-128.png"));
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest(target), null, 2)}\n`);

  if (!e2e) {
    const files = Object.fromEntries(walk(out).map((p) => [relative(out, p).split("\\").join("/"), [readFileSync(p), { mtime: new Date("2026-01-01T00:00:00Z") }]]));
    const zipPath = join(outRoot, `filenymous-${target}-${pkg.version}.zip`);
    writeFileSync(zipPath, zipSync(files, { level: 9 }));
    console.log(`${target}: ${relative(here, out)} → ${relative(here, zipPath)} (${(statSync(zipPath).size / 1024).toFixed(1)} Kio)`);
  } else console.log(`${target} (e2e): ${relative(here, out)} · app ${APP_URL} · relay ${SIGNAL_URL}`);
}
