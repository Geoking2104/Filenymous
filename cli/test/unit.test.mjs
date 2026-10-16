import { test } from "node:test";
import assert from "node:assert/strict";
import { importSrc } from "./helpers.mjs";

const opts = await importSrc("options");
const sink = await importSrc("fsSink");

test("parseDuration", () => {
  assert.equal(opts.parseDuration("90s"), 90_000);
  assert.equal(opts.parseDuration("15m"), 900_000);
  assert.equal(opts.parseDuration("1h"), 3_600_000);
  assert.equal(opts.parseDuration("2d"), 172_800_000);
  assert.equal(opts.parseDuration("30"), 30_000);
  assert.throws(() => opts.parseDuration("soon"));
  assert.throws(() => opts.parseDuration("10ms"));
  assert.throws(() => opts.parseDuration("8d"));
});

test("webhook payload: --webhook-no-link drops link and code", () => {
  const p = { event: "share.created", link: "https://x/#p2p:123-456-ABC/sec", code: "123-456-ABC", file: "a.zip", size: 1, expiresAt: "t", downloads: 0, maxDownloads: 1, protected: false };
  assert.deepEqual(opts.webhookPayload(p, false), p);
  const safe = opts.webhookPayload(p, true);
  assert.equal(safe.link, undefined);
  assert.equal(safe.code, undefined);
  assert.equal(safe.file, "a.zip");
});

test("uniquePath sanitises names and never overwrites", () => {
  const taken = new Set(["/d/report.pdf", "/d/report (1).pdf"]);
  assert.equal(sink.uniquePath("/d", "report.pdf", (p) => taken.has(p)), "/d/report (2).pdf");
  assert.equal(sink.uniquePath("/d", "../../etc/passwd", () => false), "/d/_.._etc_passwd");
  assert.equal(sink.uniquePath("/d", "", () => false), "/d/file");
});

test("formatBytes", () => {
  assert.equal(opts.formatBytes(512), "512 B");
  assert.equal(opts.formatBytes(3 * 1024 * 1024), "3.0 MB");
});
