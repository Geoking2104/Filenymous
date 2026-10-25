#!/usr/bin/env node
/**
 * Remove the retired Whisper (live captions) model folder from OVH:
 * /home/filenyb/www/app/models/Xenova/whisper-tiny — and nothing else
 * (MiniLM and every other models/ entry are left alone).
 *   node scripts/ovh-remove-whisper.mjs --mode inspect|apply
 * Prints file names and sizes, never secrets.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const SftpClient = require("ssh2-sftp-client");

const i = process.argv.indexOf("--mode");
const mode = i > 0 ? process.argv[i + 1] : "inspect";
if (!["inspect", "apply"].includes(mode)) { console.error("mode must be inspect|apply"); process.exit(1); }
if (!process.env.OVH_SFTP_PASS) { console.error("OVH_SFTP_PASS missing"); process.exit(1); }

const MODELS = "/home/filenyb/www/app/models";
const TARGET = `${MODELS}/Xenova/whisper-tiny`;
const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;
const sftp = new SftpClient("filenymous-whisper");
async function du(path, print) {
  let bytes = 0, files = 0;
  for (const e of await sftp.list(path)) {
    const p = `${path}/${e.name}`;
    if (e.type === "d") { const r = await du(p, print); bytes += r.bytes; files += r.files; }
    else { bytes += e.size; files++; if (print) console.log(`  ${p.slice(MODELS.length + 1)}  ${e.size}`); }
  }
  return { bytes, files };
}
await sftp.connect({ host: "ftp.cluster129.hosting.ovh.net", port: 22, username: "filenyb", password: process.env.OVH_SFTP_PASS });
try {
  console.log("== models/ before ==");
  const before = await du(MODELS, true);
  console.log(`models/ total ${mb(before.bytes)}, ${before.files} files`);
  if ((await sftp.exists(TARGET)) !== "d") { console.log(`absent: ${TARGET}`); }
  else {
    const t = await du(TARGET, false);
    console.log(`${mode === "apply" ? "DELETE" : "would delete"} ${TARGET}  ${mb(t.bytes)}  ${t.files} files`);
    if (mode === "apply") {
      await sftp.rmdir(TARGET, true);
      const after = await du(MODELS, true);
      console.log(`models/ after ${mb(after.bytes)}, ${after.files} files (freed ${mb(before.bytes - after.bytes)})`);
    }
  }
} finally { await sftp.end(); }
