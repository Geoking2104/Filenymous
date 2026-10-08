#!/usr/bin/env node
/**
 * Deploy a built directory to filenymous.eu (OVH shared hosting) over SFTP.
 *
 * Node equivalent of deploy-ui.ps1, for machines without WinSCP or
 * PowerShell 7 (which the .ps1 SFTP fallback requires).
 *
 * Usage:
 *   OVH_SFTP_PASS='...' node scripts/deploy-ovh-sftp.mjs \
 *       --dist ui/dist --remote /home/filenyb/www/app
 *
 *   # For the web root (keeps the existing app/ subdirectory):
 *   OVH_SFTP_PASS='...' node scripts/deploy-ovh-sftp.mjs \
 *       --dist ui/dist --remote /home/filenyb/www --merge
 *
 * Modes:
 *   default   full-dir swap: rename <remote> -> <remote>.bak-<ts>, recreate,
 *             upload everything (clean, removes stale assets).
 *   --merge   per-file backup into <remote>.bak-<ts>/ then overwrite/upload;
 *             existing unrelated files (e.g. app/) are untouched.
 *
 * Credentials: OVH_SFTP_PASS env var (never stored in the repo).
 * Host: ftp.cluster129.hosting.ovh.net (SFTP port 22), user filenyb.
 *
 * Requires: cd scripts && npm install  (ssh2-sftp-client)
 */

import { createRequire } from "node:module";
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, posix } from "node:path";

const require = createRequire(import.meta.url);
let SftpClient;
try {
  SftpClient = require("ssh2-sftp-client");
} catch {
  console.error("Missing dependency 'ssh2-sftp-client'. Run:  cd scripts && npm install");
  process.exit(1);
}

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const dist = arg("--dist");
const remote = arg("--remote");
const merge = args.includes("--merge");
const host = arg("--host", "ftp.cluster129.hosting.ovh.net");
const port = Number(arg("--port", "22"));
const user = arg("--user", "filenyb");
const password = process.env.OVH_SFTP_PASS;

if (!dist || !remote) {
  console.error("Usage: node scripts/deploy-ovh-sftp.mjs --dist <dir> --remote <dir> [--merge]");
  process.exit(1);
}
if (!existsSync(dist)) {
  console.error(`Local dir not found: ${dist}`);
  process.exit(1);
}
if (!password) {
  console.error("Set OVH_SFTP_PASS (OVH SFTP password for user 'filenyb'). It is never stored.");
  process.exit(1);
}

const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
const backupDir = `${remote}.bak-${ts}`;

/** Collect files recursively as [relativePosixPath, absolutePath]. */
function walk(root, sub = "") {
  const out = [];
  for (const name of readdirSync(join(root, sub))) {
    const rel = sub ? `${sub}/${name}` : name;
    const abs = join(root, rel);
    if (statSync(abs).isDirectory()) out.push(...walk(root, rel));
    else out.push([rel, abs]);
  }
  return out;
}

const files = walk(dist);
if (!files.length) {
  console.error("Nothing to upload.");
  process.exit(1);
}

console.log(`Deploy ${dist} -> ${user}@${host}:${remote}`);
console.log(`Files: ${files.length}  Mode: ${merge ? "merge (per-file backup)" : "dir swap"}`);

const client = new SftpClient("filenymous-deploy");
try {
  await client.connect({ host, port, username: user, password });

  if (!merge) {
    console.log(`Rename ${remote} -> ${backupDir}`);
    await client.rename(remote, backupDir);
  }

  // Ensure remote directories exist.
  const dirs = new Set(files.map(([rel]) => posix.dirname(rel)).filter((d) => d && d !== "."));
  await client.mkdir(remote, true).catch(() => {});
  for (const d of dirs) {
    await client.mkdir(posix.join(remote, d), true).catch(() => {});
  }

  let done = 0;
  for (const [rel, abs] of files) {
    const target = posix.join(remote, rel);
    if (merge) {
      // Back up the existing file (if any) before overwriting.
      try {
        const existing = await client.get(target);
        if (existing) {
          await client.mkdir(posix.dirname(posix.join(backupDir, rel)), true).catch(() => {});
          await client.put(existing, posix.join(backupDir, rel));
        }
      } catch {
        /* file does not exist remotely — nothing to back up */
      }
    }
    await client.put(readFileSync(abs), target);
    done++;
    if (done % 10 === 0 || done === files.length) console.log(`  ${done}/${files.length}`);
  }

  const list = await client.list(remote);
  console.log(`Done. ${list.length} entries at ${remote}. Backup: ${backupDir}`);
} finally {
  await client.end().catch(() => {});
}
