#!/usr/bin/env node
/**
 * Validate i18n keys used in src against locale JSON files.
 * - Reports missing keys (used in code, absent from locale)
 * - Reports unused keys (in locale, never referenced)
 * - Reports empty EN values
 *
 * Usage: node scripts/i18n-check.mjs [--strict]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "src");
const localesDir = path.join(root, "src/i18n/locales");
const strict = process.argv.includes("--strict");

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walk(full, acc);
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

function flatten(obj, prefix = "", out = new Set()) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    if (prefix) out.add(prefix);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      flatten(v, key, out);
    } else {
      out.add(key);
    }
  }
  return out;
}

function emptyLeaves(obj, prefix = "", out = []) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      emptyLeaves(v, key, out);
    } else if (v === "" || v === null || v === undefined) {
      out.push(key);
    }
  }
  return out;
}

// Match t("key"), t('key'), t(`key`) — static keys only
const T_CALL =
  /\bt\s*\(\s*["'`]([a-zA-Z0-9_.-]+)["'`]/g;

const used = new Set();
for (const file of walk(srcDir)) {
  const text = fs.readFileSync(file, "utf8");
  let m;
  while ((m = T_CALL.exec(text))) {
    used.add(m[1]);
  }
}

const locales = ["fr", "en"];
let exit = 0;

for (const lng of locales) {
  const file = path.join(localesDir, `${lng}.json`);
  if (!fs.existsSync(file)) {
    console.error(`❌ Missing locale file: ${file}`);
    exit = 1;
    continue;
  }
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  const keys = flatten(json);

  const missing = [...used].filter((k) => !keys.has(k)).sort();
  const unused = [...keys].filter((k) => !used.has(k)).sort();
  const empty = emptyLeaves(json).sort();

  console.log(`\n══ ${lng.toUpperCase()} (${keys.size} keys in catalog, ${used.size} used in code) ══`);

  if (missing.length) {
    console.log(`\n  Missing (${missing.length}):`);
    for (const k of missing) console.log(`    - ${k}`);
    exit = 1;
  } else {
    console.log("  ✓ No missing keys");
  }

  if (empty.length) {
    console.log(`\n  Empty values (${empty.length}):`);
    for (const k of empty.slice(0, 30)) console.log(`    - ${k}`);
    if (empty.length > 30) console.log(`    … +${empty.length - 30} more`);
    if (lng === "en") exit = 1;
  }

  if (unused.length) {
    console.log(`\n  Unused in code (${unused.length}) — kept for future panels:`);
    for (const k of unused.slice(0, 20)) console.log(`    · ${k}`);
    if (unused.length > 20) console.log(`    … +${unused.length - 20} more`);
  }
}

console.log("\nTip: run `npm run i18n:extract` to sync catalogs from t() calls.\n");

if (strict && exit) process.exit(exit);
process.exit(0);
