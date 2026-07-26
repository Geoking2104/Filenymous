#!/usr/bin/env node
/**
 * Heuristic scan for likely hardcoded UI strings not wrapped in t().
 * Does not modify files — reports candidates for i18n.
 *
 * Usage: node scripts/i18n-scan-hardcoded.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, "../src");

const IGNORE_DIRS = new Set(["i18n", "crypto", "holochain", "rooms"]);
const IGNORE_FILES = /\.(test|spec)\.(tsx?|jsx?)$/;

// JSX text nodes and string props that look like user-facing copy
const JSX_TEXT = />\s*([A-ZÀ-ÖØ-Þ][^<>{\n]{3,80})\s*</g;
const STRING_PROP =
  /\b(?:placeholder|title|aria-label|label|alt)=["']([^"']{3,80})["']/g;
const ALERT_STRING = /\balert\(\s*["'`]([^"'`]{3,120})["'`]/g;

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name) || entry.name === "node_modules") continue;
      walk(path.join(dir, entry.name), acc);
    } else if (/\.(tsx|jsx)$/.test(entry.name) && !IGNORE_FILES.test(entry.name)) {
      acc.push(path.join(dir, entry.name));
    }
  }
  return acc;
}

const hits = [];

for (const file of walk(srcDir)) {
  const rel = path.relative(srcDir, file);
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");

  const patterns = [
    ["jsx-text", JSX_TEXT],
    ["prop", STRING_PROP],
    ["alert", ALERT_STRING],
  ];

  for (const [kind, re] of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const snippet = m[1].trim();
      // Skip code-like / technical noise
      if (/^(https?:|var\(|#[0-9a-f]|[a-z]+\.[a-z]|import |export )/i.test(snippet))
        continue;
      if (/^[{}\[\]().,;]+$/.test(snippet)) continue;
      if (snippet.startsWith("t(") || snippet.includes("${")) continue;

      const before = text.slice(0, m.index);
      const line = before.split("\n").length;
      // Skip if same line already has t(
      if (lines[line - 1]?.includes("t(")) continue;

      hits.push({ file: rel, line, kind, snippet });
    }
  }
}

hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

console.log(`\nHardcoded UI string candidates: ${hits.length}\n`);
let current = "";
for (const h of hits) {
  if (h.file !== current) {
    current = h.file;
    console.log(`\n── ${h.file}`);
  }
  console.log(`  L${h.line} [${h.kind}] ${JSON.stringify(h.snippet)}`);
}

console.log(
  "\nNext: wrap candidates with t('namespace.key') then run npm run i18n:extract\n",
);
