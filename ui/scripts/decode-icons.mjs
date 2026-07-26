#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const base = dirname(fileURLToPath(import.meta.url));
const src = join(base, "icon-data");
const dest = join(base, "..", "public", "icons");
mkdirSync(dest, { recursive: true });
for (const f of readdirSync(src).filter((x) => x.endsWith(".b64"))) {
  const name = f.replace(/\.b64$/, "");
  writeFileSync(join(dest, name), Buffer.from(readFileSync(join(src, f), "utf8"), "base64"));
  console.log("wrote", name);
}
