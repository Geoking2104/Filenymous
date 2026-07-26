#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const base = dirname(fileURLToPath(import.meta.url));
const src = join(base, "icon-data");
const dest = join(base, "..", "public", "icons");
mkdirSync(dest, { recursive: true });

if (existsSync(src)) {
  for (const f of readdirSync(src).filter((x) => x.endsWith(".b64"))) {
    const name = f.replace(/\.b64$/, "");
    try {
      const buf = Buffer.from(readFileSync(join(src, f), "utf8").trim(), "base64");
      if (buf.length < 200) {
        console.warn("skip tiny", name);
        continue;
      }
      writeFileSync(join(dest, name), buf);
      console.log("wrote", name, buf.length, "bytes");
    } catch (e) {
      console.warn("failed", name, e.message);
    }
  }
}

const required = [
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "icon-180.png",
  "favicon-32.png",
];
const fallback = join(dest, "icon-192.png");
for (const name of required) {
  const path = join(dest, name);
  if (!existsSync(path) && existsSync(fallback)) {
    copyFileSync(fallback, path);
    console.log("fallback copy", name, "from icon-192.png");
  }
}
