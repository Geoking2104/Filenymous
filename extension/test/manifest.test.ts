/** Built manifests: minimal permissions, no required host access, no third-party references. */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(__dirname, "..");
execFileSync(process.execPath, [join(root, "build.mjs")], { stdio: "ignore" });
const read = (t: string) => JSON.parse(readFileSync(join(root, "dist", t, "manifest.json"), "utf8"));
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));

describe("manifests", () => {
  it("Chrome: MV3 service worker + offscreen, no host permission required", () => {
    const m = read("chrome");
    expect(m.manifest_version).toBe(3);
    expect(m.background).toEqual({ service_worker: "background.js", type: "module" });
    expect(m.permissions.sort()).toEqual(["activeTab", "clipboardWrite", "contextMenus", "notifications", "offscreen", "scripting"]);
    expect(m.host_permissions).toBeUndefined();
    expect(m.optional_host_permissions).toEqual(["https://*/*", "http://*/*"]);
  });
  it("Firefox: persistent background page (WebRTC must outlive the popup)", () => {
    const m = read("firefox");
    expect(m.manifest_version).toBe(2);
    expect(m.background).toEqual({ page: "background.html", persistent: true });
    expect(m.permissions.sort()).toEqual(["activeTab", "clipboardWrite", "contextMenus", "notifications"]);
    expect(m.optional_permissions).toEqual(["https://*/*", "http://*/*"]);
    expect(m.browser_specific_settings.gecko.id).toBe("extension@filenymous.eu");
  });
  it("ships every referenced file and the zips", () => {
    for (const t of ["chrome", "firefox"]) {
      const m = read(t);
      const files = [m.action?.default_popup ?? m.browser_action.default_popup, ...Object.values(m.icons), "grant.html", "popup.js", "grant.js", "background.js"];
      for (const f of files) expect(existsSync(join(root, "dist", t, f as string)), `${t}/${f}`).toBe(true);
      expect(existsSync(join(root, "dist", `filenymous-${t}-${JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version}.zip`))).toBe(true);
    }
    expect(existsSync(join(root, "dist/chrome/offscreen.html"))).toBe(true);
  });
  it("all user-facing pages are in French", () => {
    for (const f of walk(join(root, "dist")).filter((p) => p.endsWith(".html"))) expect(readFileSync(f, "utf8"), f).toContain('lang="fr"');
  });
});
