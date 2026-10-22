/**
 * List (inspect) or delete (apply) old deploy backups on OVH shared hosting.
 * Targets: /home/filenyb/www/app.bak-<ts> and /home/filenyb/www.bak-<ts>
 * (both created by deploy-ovh-sftp.mjs). Keeps the KEEP most recent
 * *complete* backups of each kind; everything else of that kind is deleted
 * (incl. partial copies left by failed runs). Prints sizes and, when the host
 * allows SSH exec, disk usage/quota before and after. Never prints secrets.
 * Also reports the size of the live app folders, and with --prune-xiaolai
 * removes the unused Xiaolai (CJK) Excalidraw font folder (dropped from the
 * build in #58; only partial uploads remain) in apply mode.
 *   node scripts/ovh-cleanup-backups.mjs --mode inspect|apply [--keep 2] [--prune-xiaolai]
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const SftpClient = require("ssh2-sftp-client");
const { Client } = require("ssh2");

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const mode = arg("--mode", "inspect");
const keep = Number(arg("--keep", "2"));
const cfg = { host: "ftp.cluster129.hosting.ovh.net", port: 22, username: "filenyb", password: process.env.OVH_SFTP_PASS };
if (!cfg.password) { console.error("OVH_SFTP_PASS missing"); process.exit(1); }
if (!["inspect", "apply"].includes(mode)) { console.error("mode must be inspect|apply"); process.exit(1); }

const HOME = "/home/filenyb";
const KINDS = [
  { kind: "app", parent: `${HOME}/www`, re: /^app\.bak-(\d{14})$/, complete: (names) => names.has("index.html") && names.has("assets") },
  { kind: "www", parent: HOME, re: /^www\.bak-(\d{14})$/, complete: (names) => names.has("llms.txt") && names.has("sitemap.xml") && names.has("robots.txt") },
];

function sshExec(cmd) {
  return new Promise((resolve) => {
    const c = new Client();
    let out = "";
    const t = setTimeout(() => { c.end(); resolve("(ssh exec timeout)"); }, 60_000);
    c.on("ready", () => c.exec(cmd, (err, s) => {
      if (err) { clearTimeout(t); c.end(); return resolve(`(ssh exec unavailable: ${err.message})`); }
      s.on("data", (d) => (out += d)).stderr.on("data", (d) => (out += d));
      s.on("close", () => { clearTimeout(t); c.end(); resolve(out.trim() || "(no output)"); });
    })).on("error", (e) => { clearTimeout(t); resolve(`(ssh exec unavailable: ${e.message})`); }).connect(cfg);
  });
}

const sftp = new SftpClient();
async function du(path) {
  let bytes = 0, files = 0;
  for (const e of await sftp.list(path)) {
    if (e.type === "d") { const r = await du(`${path}/${e.name}`); bytes += r.bytes; files += r.files; }
    else { bytes += e.size; files++; }
  }
  return { bytes, files };
}
const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;

const usage = async (label) => console.log(`\n== Disk ${label} ==\n${await sshExec("quota -s 2>/dev/null; df -h ~ 2>/dev/null; du -sh ~/www ~ 2>/dev/null")}`);

await usage("before");
await sftp.connect(cfg);
const plan = [];
for (const k of KINDS) {
  const entries = (await sftp.list(k.parent)).filter((e) => e.type === "d" && k.re.test(e.name)).sort((a, b) => b.name.localeCompare(a.name));
  let kept = 0;
  console.log(`\n== ${k.kind} backups in ${k.parent} (${entries.length}) ==`);
  for (const e of entries) {
    const path = `${k.parent}/${e.name}`;
    const names = new Set((await sftp.list(path)).map((x) => x.name));
    const size = await du(path);
    const complete = k.complete(names);
    const action = complete && kept < keep ? "KEEP" : "DELETE";
    if (action === "KEEP") kept++;
    console.log(`${action.padEnd(6)} ${e.name}  ${mb(size.bytes)}  ${size.files} files  ${complete ? "complete" : "partial"}`);
    if (action === "DELETE") plan.push({ path, bytes: size.bytes });
  }
}
const APP = `${HOME}/www/app`;
console.log(`\n== live app folders in ${APP} ==`);
for (const e of (await sftp.list(APP)).filter((x) => x.type === "d")) {
  const size = await du(`${APP}/${e.name}`);
  console.log(`${e.name.padEnd(24)} ${mb(size.bytes)}  ${size.files} files`);
}
const XIAOLAI = `${APP}/excalidraw-assets/fonts/Xiaolai`;
if (process.argv.includes("--prune-xiaolai") && (await sftp.exists(XIAOLAI)) === "d") {
  const size = await du(XIAOLAI);
  console.log(`DELETE ${XIAOLAI}  ${mb(size.bytes)}  ${size.files} files (unused since #58)`);
  plan.push({ path: XIAOLAI, bytes: size.bytes });
}
console.log(`\nTo delete: ${plan.length} dirs, ${mb(plan.reduce((s, p) => s + p.bytes, 0))}`);
if (mode === "apply") {
  for (const p of plan) {
    if (!/^\/home\/filenyb\/(www\/app|www)\.bak-\d{14}$/.test(p.path) && p.path !== XIAOLAI) throw new Error(`refusing ${p.path}`);
    await sftp.rmdir(p.path, true);
    console.log(`deleted ${p.path}`);
  }
}
await sftp.end();
if (mode === "apply") await usage("after");
