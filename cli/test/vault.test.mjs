/** `filenymous vault` (Agent Vault runner): enrollment, key file hygiene, fail-closed run, read-only MCP. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI } from "./helpers.mjs";

const b64u = (b) => Buffer.from(b).toString("base64url");
const clean = { ...process.env, FNY_AGENT_TOKEN: "", FNY_APP_TOKEN: "", FNY_AGENT_KEY_FILE: "", FNY_ADMIN_URL: "" };
const cli = (args, env = {}) => spawnSync(process.execPath, [CLI, "vault", ...args], { env: { ...clean, ...env }, encoding: "utf8", timeout: 30_000 });
const tokenFile = (over = {}) =>
  "fny-agent-token:v1:" +
  b64u(JSON.stringify({ v: 1, appUrl: "ws://127.0.0.1:1", installedAppId: "filenymous", cellId: [b64u(new Uint8Array(39)), b64u(new Uint8Array(39))], tokenId: "tok_AAAAAAAAAAAAAAAA", capSecret: b64u(new Uint8Array(64)), expiresAt: Date.now() + 3600_000, label: "ci", ...over }));

function enrolled() {
  const dir = mkdtempSync(join(tmpdir(), "fny-vault-"));
  const keyFile = join(dir, "agent.json");
  const r = cli(["enroll", "--name", "ci-bot", "--key-file", keyFile]);
  assert.equal(r.status, 0, r.stderr);
  return { dir, keyFile, code: r.stdout.trim(), stderr: r.stderr };
}

test("enroll: private key file, decodable code, fingerprint matches, no silent overwrite", () => {
  const { keyFile, code, stderr } = enrolled();
  if (process.platform !== "win32") assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  assert.match(code, /^fny-agent:v1:[A-Za-z0-9_-]+$/);
  const e = JSON.parse(Buffer.from(code.slice("fny-agent:v1:".length), "base64url").toString());
  assert.equal(e.l, "ci-bot");
  const k = JSON.parse(readFileSync(keyFile, "utf8"));
  assert.equal(Buffer.from(e.ed, "base64url").length, 32);
  assert.equal(e.ed, k.edPublic);
  assert.ok(!code.includes(k.edSecret) && !code.includes(k.xSecret), "code must only carry public keys");
  // X25519 public key in the code derives from the stored secret (node:crypto, independent of the CLI).
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), Buffer.from(k.xSecret, "base64url")]);
  assert.equal(createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })).export({ format: "jwk" }).x, e.x);
  const d = createHash("sha256").update(Buffer.concat([Buffer.from(e.ed, "base64url"), Buffer.from(e.x, "base64url")])).digest("hex");
  assert.ok(stderr.includes(`fny-${d.slice(0, 4)}-${d.slice(4, 8)}-${d.slice(8, 12)}-${d.slice(12, 16)}`));
  const again = cli(["enroll", "--name", "ci-bot", "--key-file", keyFile]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists/);
});

test("selftest: seal → open round-trip with the enrolled key", () => {
  const { keyFile } = enrolled();
  const r = cli(["selftest", "--key-file", keyFile]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { event: "selftest", ok: true });
});

test("run fails closed: no token, bad token, expired token, world-readable key, unreachable node", () => {
  const { dir, keyFile } = enrolled();
  const marker = join(dir, "child-ran");
  const child = ["--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`];
  let r = cli(["run", "--key-file", keyFile, ...child]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no agent token/);
  r = cli(["run", "--key-file", keyFile, ...child], { FNY_AGENT_TOKEN: "nope" });
  assert.equal(r.status, 1);
  r = cli(["run", "--key-file", keyFile, ...child], { FNY_AGENT_TOKEN: tokenFile({ expiresAt: Date.now() - 1000 }) });
  assert.match(r.stderr, /token expired/);
  r = cli(["run", "--key-file", keyFile, "--app-token", b64u(new Uint8Array(32)), ...child], { FNY_AGENT_TOKEN: tokenFile() });
  assert.equal(r.status, 1, "unreachable conductor must fail");
  if (process.platform !== "win32") {
    const loose = join(dir, "loose.json");
    writeFileSync(loose, readFileSync(keyFile), { mode: 0o644 });
    r = cli(["run", "--key-file", loose, "--app-token", "AA", ...child], { FNY_AGENT_TOKEN: tokenFile() });
    assert.match(r.stderr, /chmod 600/);
  }
  assert.ok(!existsSync(marker), "the agent command must never start without a granted bundle");
});

test("mcp: lists env var names only, never values", { timeout: 20_000 }, async () => {
  const proc = spawn(process.execPath, [CLI, "vault", "mcp"], { env: { ...clean, FNY_AGENT_ENV_NAMES: "GITHUB_TOKEN,OPENAI_API_KEY", GITHUB_TOKEN: "ghp_supersecretvalue", OPENAI_API_KEY: "sk-supersecret" }, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const replies = new Map();
  proc.stdout.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0; ) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      replies.set(m.id, m);
    }
  });
  const ask = (id, method, params = {}) => {
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((ok) => { const t = setInterval(() => replies.has(id) && (clearInterval(t), ok(replies.get(id)))); });
  };
  assert.equal((await ask(1, "initialize", { protocolVersion: "2025-06-18" })).result.serverInfo.name, "filenymous-vault");
  const tools = (await ask(2, "tools/list")).result.tools.map((t) => t.name);
  assert.deepEqual(tools.sort(), ["vault_list_env_names", "vault_token_status"]);
  const names = await ask(3, "tools/call", { name: "vault_list_env_names", arguments: {} });
  assert.deepEqual(JSON.parse(names.result.content[0].text), { names: ["GITHUB_TOKEN", "OPENAI_API_KEY"] });
  const status = await ask(4, "tools/call", { name: "vault_token_status", arguments: {} });
  assert.equal(status.result.isError, true);
  proc.stdin.end();
  await new Promise((ok) => proc.on("exit", ok));
  const all = JSON.stringify([...replies.values()]);
  assert.ok(!all.includes("supersecret"), "MCP output must never contain secret values");
});
