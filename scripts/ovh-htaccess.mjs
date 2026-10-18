#!/usr/bin/env node
/**
 * Manage the web-root .htaccess on OVH (filenymous.eu) over SFTP.
 *
 *   node scripts/ovh-htaccess.mjs inspect  --out <dir>
 *       Download /home/filenyb/www/.htaccess and /home/filenyb/www/app/.htaccess
 *       (read-only) plus the root directory listing (names only) into <dir>.
 *   node scripts/ovh-htaccess.mjs apply    --file deploy/ovh-root/.htaccess
 *       Copy the current root .htaccess to .htaccess.bak-<ts> (same dir, verified),
 *       then upload the repo file. Prints the backup path.
 *   node scripts/ovh-htaccess.mjs rollback --backup /home/filenyb/www/.htaccess.bak-<ts>
 *       Restore the given backup over the root .htaccess.
 *
 * Credentials: OVH_SFTP_PASS env var only. Host/user as deploy-ovh-sftp.mjs.
 */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const SftpClient = require("ssh2-sftp-client");
const [mode, ...rest] = process.argv.slice(2);
const arg = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
const ROOT = "/home/filenyb/www";
const TARGET = `${ROOT}/.htaccess`;
const password = process.env.OVH_SFTP_PASS;
if (!password) { console.error("OVH_SFTP_PASS missing"); process.exit(1); }

const c = new SftpClient("filenymous-htaccess");
await c.connect({ host: "ftp.cluster129.hosting.ovh.net", port: 22, username: "filenyb", password });
try {
  if (mode === "inspect") {
    const out = arg("--out"); mkdirSync(out, { recursive: true });
    for (const [remote, local] of [[TARGET, "root.htaccess"], [`${ROOT}/app/.htaccess`, "app.htaccess"]]) {
      if (await c.exists(remote)) { writeFileSync(join(out, local), await c.get(remote)); console.log(`got ${remote}`); }
      else console.log(`absent ${remote}`);
    }
    const ls = (await c.list(ROOT)).map((e) => `${e.type} ${e.name}`).sort().join("\n");
    writeFileSync(join(out, "root-listing.txt"), ls + "\n");
  } else if (mode === "apply") {
    const next = readFileSync(arg("--file"));
    const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const bak = `${TARGET}.bak-${ts}`;
    if (await c.exists(TARGET)) {
      const cur = await c.get(TARGET);
      await c.put(cur, bak);
      const check = await c.get(bak);
      if (Buffer.compare(cur, check) !== 0) throw new Error("backup verification failed");
      console.log(`BACKUP=${bak} (${cur.length} bytes, verified)`);
    } else console.log("no existing root .htaccess; nothing to back up");
    await c.put(next, TARGET);
    console.log(`uploaded ${TARGET} (${next.length} bytes)`);
  } else if (mode === "rollback") {
    const bak = arg("--backup");
    if (!bak || !bak.startsWith(`${TARGET}.bak-`)) throw new Error("--backup must be a root .htaccess.bak-<ts>");
    await c.put(await c.get(bak), TARGET);
    console.log(`restored ${TARGET} from ${bak}`);
  } else throw new Error("mode: inspect | apply | rollback");
} finally { await c.end().catch(() => {}); }
