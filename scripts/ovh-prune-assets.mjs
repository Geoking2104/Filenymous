/**
 * Prune stale hashed files from the OVH app's assets/ folder (deploys run in
 * --merge mode and never delete, so every build's chunks pile up).
 * Keep-list = every file in <dist>/assets of each --keep-dist build (entry,
 * lazy chunks, workers, fonts, CSS, wasm…) plus, with --grace-days N, any
 * remote file modified in the last N days (so tabs still open on the previous
 * build can lazy-load their chunks). Sanity checks before deleting: every
 * assets/ file referenced by the live HTML pages and their JS/CSS (fetched
 * from --live-url) must be in the keep-list, and the keep-list must exist on
 * the server; otherwise it aborts. Never prints secrets.
 *   node scripts/ovh-prune-assets.mjs --mode inspect|apply --keep-dist ui/dist [--keep-dist other/dist]
 *        [--remote /home/filenyb/www/app] [--live-url https://filenymous.eu/app/] [--grace-days 0]
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);


const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const all = (n) => argv.flatMap((a, i) => (a === n ? [argv[i + 1]] : []));
const mode = arg("--mode", "inspect");
const remote = arg("--remote", "/home/filenyb/www/app");
const liveUrl = arg("--live-url", "https://filenymous.eu/app/");
const graceDays = Number(arg("--grace-days", "0"));
const dists = all("--keep-dist");
const password = process.env.OVH_SFTP_PASS;
const checkOnly = argv.includes("--check-only");
if (!password && !checkOnly) { console.error("OVH_SFTP_PASS missing"); process.exit(1); }
if (!["inspect", "apply"].includes(mode) || !dists.length) { console.error("usage: --mode inspect|apply --keep-dist <dist> [...]"); process.exit(1); }

const walk = (root) => readdirSync(root).flatMap((n) => (statSync(join(root, n)).isDirectory() ? walk(join(root, n)) : [join(root, n)]));
const keep = new Set();
const pages = new Set();
for (const d of dists) {
  for (const f of walk(join(d, "assets"))) keep.add(relative(join(d, "assets"), f).split(sep).join("/"));
  for (const f of walk(d)) if (f.endsWith(".html")) pages.add(relative(d, f).split(sep).join("/"));
}
console.log(`keep-list: ${keep.size} files from ${dists.join(", ")}; ${pages.size} HTML pages`);

// Sanity: live import graph (HTML → JS/CSS → assets/…) must be covered by the keep-list.
const REF = /(?<![\w-])assets\/([A-Za-z0-9._\-/]+\.[a-z0-9]{2,6})/g;
const seen = new Set();
const missing = new Set();
const queue = [...pages].map((p) => new URL(p === "index.html" ? "" : p.replace(/index\.html$/, ""), liveUrl).href);
const fetched = new Set();
while (queue.length) {
  const u = queue.shift();
  if (fetched.has(u) || fetched.size > 400) continue;
  fetched.add(u);
  const r = await fetch(u).catch(() => null);
  if (!r?.ok) { if (u.includes("/assets/")) missing.add(u); continue; }
  const ct = r.headers.get("content-type") ?? "";
  if (!/html|javascript|css|json/.test(ct)) continue;
  const text = await r.text();
  for (const m of text.matchAll(REF)) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    if (!keep.has(name)) missing.add(name);
    if (/\.(js|mjs|css)$/.test(name)) queue.push(new URL(`assets/${name}`, liveUrl).href);
  }
}
console.log(`live graph: ${fetched.size} resources fetched, ${seen.size} assets/ references`);
if (missing.size) {
  console.error(`ABORT: live references not in keep-list: ${[...missing].slice(0, 20).join(", ")}`);
  process.exit(2);
}

if (checkOnly) process.exit(0);
const sftp = new (require("ssh2-sftp-client"))();
await sftp.connect({ host: "ftp.cluster129.hosting.ovh.net", port: 22, username: "filenyb", password });
try {
  const dir = `${remote}/assets`;
  const list = [];
  const rec = async (sub) => {
    for (const e of await sftp.list(sub ? `${dir}/${sub}` : dir)) {
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.type === "d") await rec(rel);
      else list.push({ rel, size: e.size, mtime: e.modifyTime });
    }
  };
  await rec("");
  const remoteNames = new Set(list.map((f) => f.rel));
  const absent = [...keep].filter((k) => !remoteNames.has(k));
  const cutoff = Date.now() - graceDays * 86400_000;
  const del = list.filter((f) => !keep.has(f.rel) && !seen.has(f.rel) && !(graceDays > 0 && f.mtime >= cutoff));
  const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;
  const total = list.reduce((s, f) => s + f.size, 0);
  const freed = del.reduce((s, f) => s + f.size, 0);
  console.log(`remote assets/: ${list.length} files, ${mb(total)}; keep-list files absent remotely: ${absent.length}`);
  console.log(`to delete: ${del.length} files, ${mb(freed)} (grace ${graceDays} d)`);
  for (const f of del.slice(0, 15)) console.log(`  DELETE ${f.rel}  ${(f.size / 1024).toFixed(0)} KB`);
  if (del.length > 15) console.log(`  … ${del.length - 15} more`);
  if (mode === "apply") {
    if (del.length === list.length) throw new Error("refusing to delete every asset");
    for (const f of del) {
      if (!/^[A-Za-z0-9._\-/]+$/.test(f.rel) || f.rel.includes("..")) throw new Error(`refusing ${f.rel}`);
      await sftp.delete(`${dir}/${f.rel}`);
    }
    console.log(`deleted ${del.length} files, freed ${mb(freed)}`);
  }
} finally {
  await sftp.end().catch(() => {});
}
