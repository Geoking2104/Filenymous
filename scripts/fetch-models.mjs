// Downloads the pinned on-device models listed in models.manifest.json from
// Hugging Face (exact revision), checks size + sha256, and lays them out as
// <out>/<repo>/<file> (transformers.js localModelPath layout). No secrets.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const out = process.argv[process.argv.indexOf("--out") + 1] || "models-dist";
const { models } = JSON.parse(readFileSync(new URL("./models.manifest.json", import.meta.url)));
let total = 0;
for (const m of models) {
  const dst = join(out, m.repo, m.file);
  mkdirSync(dirname(dst), { recursive: true });
  if (!existsSync(dst) || statSync(dst).size !== m.size) {
    const r = await fetch(`https://huggingface.co/${m.repo}/resolve/${m.rev}/${m.file}`);
    if (!r.ok) throw new Error(`${m.repo}/${m.file}: HTTP ${r.status}`);
    writeFileSync(dst, Buffer.from(await r.arrayBuffer()));
  }
  const buf = readFileSync(dst);
  const sha = createHash("sha256").update(buf).digest("hex");
  if (buf.length !== m.size || sha !== m.sha256) throw new Error(`${m.repo}/${m.file}: size/sha256 mismatch`);
  total += m.size;
  console.log(`ok ${(m.size / 1e6).toFixed(1).padStart(6)} MB  ${m.repo}/${m.file}`);
}
console.log(`total ${(total / 1e6).toFixed(1)} MB in ${models.length} files`);
