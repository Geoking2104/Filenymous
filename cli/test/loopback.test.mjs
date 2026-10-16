/** CLI sender → CLI receiver through a local p2p-signal relay (no external network). */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstJson, runCli, startRelay } from "./helpers.mjs";

let relay;
const dir = mkdtempSync(join(tmpdir(), "fncli-e2e-"));
const sha = (b) => createHash("sha256").update(b).digest("hex");
before(async () => (relay = await startRelay()));
after(() => relay?.stop());

const common = () => ["--signal", relay.url, "--app-url", "http://localhost:5173/"];

test("upload → receive, 2 downloads, webhook events", { timeout: 90_000 }, async () => {
  const hooks = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => { hooks.push(JSON.parse(body)); res.end("ok"); });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const hook = `http://127.0.0.1:${srv.address().port}/hook`;
  const data = randomBytes(1_500_000 + 7);
  writeFileSync(join(dir, "app.zip"), data);
  const created = firstJson((o) => o.event === "share.created");
  const up = runCli(["upload", join(dir, "app.zip"), "--ttl", "60s", "--max-downloads", "2", "--json", "--webhook", hook, "--webhook-no-link", ...common()], { onLine: created.onLine });
  const { link, code } = await created.promise;
  assert.match(link, /^http:\/\/localhost:5173\/#p2p:\d{3}-\d{3}-[A-Z]{3}\/[A-Za-z0-9_-]{16,}$/);

  const r1 = await runCli(["receive", link, "-o", join(dir, "r1"), ...common()]).done;
  assert.equal(r1.code, 0, r1.stderr);
  assert.equal(sha(readFileSync(join(dir, "r1/app.zip"))), sha(data));
  // Second recipient with the typed code only (secret unwrapped over the channel).
  const r2 = await runCli(["receive", code, "-o", join(dir, "r2"), ...common()]).done;
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(sha(readFileSync(join(dir, "r2/app.zip"))), sha(data));

  const u = await up.done;
  assert.equal(u.code, 0, u.stderr);
  srv.close();
  assert.deepEqual(hooks.map((h) => h.event), ["share.created", "download.completed", "download.completed"]);
  for (const h of hooks) {
    assert.equal(h.link, undefined);
    assert.equal(h.code, undefined);
    assert.equal(h.file, "app.zip");
    assert.equal(h.size, data.length);
  }
});

test("password-protected share: wrong password fails, right one works", { timeout: 90_000 }, async () => {
  writeFileSync(join(dir, "secret.txt"), "top secret\n");
  const created = firstJson((o) => o.event === "share.created");
  const up = runCli(["upload", join(dir, "secret.txt"), "--ttl", "60s", "--json", ...common()], { env: { FILENYMOUS_PASSWORD: "correct horse" }, onLine: created.onLine });
  const { link, protected: prot } = await created.promise;
  assert.equal(prot, true);
  const bad = await runCli(["receive", link, "-o", join(dir, "p0"), "--password", "nope", ...common()]).done;
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /wrong password/);
  const good = await runCli(["receive", link, "-o", join(dir, "p1"), ...common()], { env: { FILENYMOUS_PASSWORD: "correct horse" } }).done;
  assert.equal(good.code, 0, good.stderr);
  assert.equal(readFileSync(join(dir, "p1/secret.txt"), "utf8"), "top secret\n");
  assert.equal((await up.done).code, 0);
});

test("TTL expiry with zero downloads exits 2, or 0 with --allow-empty", { timeout: 30_000 }, async () => {
  writeFileSync(join(dir, "x.bin"), "x");
  const a = await runCli(["upload", join(dir, "x.bin"), "--ttl", "2s", "--json", ...common()]).done;
  assert.equal(a.code, 2);
  assert.match(a.stdout, /"event":"share.expired"/);
  const b = await runCli(["upload", join(dir, "x.bin"), "--ttl", "2s", "--allow-empty", "-q", ...common()]).done;
  assert.equal(b.code, 0);
});

test("--expires: bound into the link; edited expiry fails; expired link refused", { timeout: 60_000 }, async () => {
  writeFileSync(join(dir, "exp.txt"), "expiring\n");
  const at = new Date(Date.now() + 8000).toISOString();
  const created = firstJson((o) => o.event === "share.created");
  const up = runCli(["upload", join(dir, "exp.txt"), "--expires", at, "--max-downloads", "3", "--json", ...common()], { onLine: created.onLine });
  const { link, expiresAt } = await created.promise;
  assert.match(link, /\/e[0-9a-z]+$/);
  assert.equal(new Date(expiresAt).getTime(), Math.floor(new Date(at).getTime() / 1000) * 1000);
  // Tampered expiry in the link → refused (integrity), file not written.
  const tampered = link.replace(/\/e([0-9a-z]+)$/, (_, e) => `/e${(parseInt(e, 36) + 3600).toString(36)}`);
  const bad = await runCli(["receive", tampered, "-o", join(dir, "e0"), ...common()]).done;
  assert.equal(bad.code, 1);
  const good = await runCli(["receive", link, "-o", join(dir, "e1"), ...common()]).done;
  assert.equal(good.code, 0, good.stderr);
  assert.equal(readFileSync(join(dir, "e1/exp.txt"), "utf8"), "expiring\n");
  const u = await up.done; // ends at expiry
  assert.equal(u.code, 0);
  assert.match(u.stdout, /"share.expired"/);
  const late = await runCli(["receive", link, "-o", join(dir, "e2"), ...common()]).done;
  assert.equal(late.code, 1);
  assert.match(late.stderr, /expired/);
});
