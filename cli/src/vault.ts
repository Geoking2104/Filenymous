/**
 * `filenymous vault …` — Doppler-style runtime injection of an AI agent's
 * credentials from the owner's Filenymous Coffre-fort (Agent Vault DNA).
 *
 *   vault enroll --name <label>         create this agent's keys, print the enrollment code
 *   vault run [--token f] -- <cmd…>     fetch the sealed bundle, open it, run <cmd> with the
 *                                       secrets in its environment only (never on disk)
 *   vault status [--token f]            token metadata (no secret values)
 *   vault mcp [--token f]               read-only MCP server: env var names + token status
 *
 * Security model: docs/agent-vault/ARCHITECTURE.md. The owner's conductor
 * only ever holds ciphertext sealed to this agent's X25519 key; zome calls
 * are signed with this agent's Ed25519 key, which the owner's capability
 * grant is assigned to (read-only functions, expiring, revocable, audited).
 */
import { spawn } from "node:child_process";
import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, webcrypto } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  agentPubKeyFromEd25519,
  b64u,
  decodeTokenFile,
  encodeEnrollment,
  enrollmentFingerprint,
  fromB64u,
  openAgentBundle,
  sealAgentBundle,
  type AgentTokenFile,
  type SealedBundleWire,
  type X25519Impl,
} from "../../ui/src/safe/agentSeal";

declare const __VERSION__: string;

if (!globalThis.crypto) (globalThis as { crypto?: unknown }).crypto = webcrypto;

export interface VaultOptions {
  name?: string;
  token?: string;
  "key-file"?: string;
  "app-token"?: string;
  "admin-url"?: string;
  force?: boolean;
  json?: boolean;
  quiet?: boolean;
}

const err = (s: string) => process.stderr.write(`${s}\n`);
const SECRET_ENV = ["FNY_AGENT_TOKEN", "FNY_APP_TOKEN", "FNY_AGENT_KEY_FILE", "FNY_ADMIN_URL"];

/* ── X25519 via node:crypto (no extra dependency) ─────────────────────────── */

function xPriv(secret: Uint8Array) {
  // Derive x from d via a throwaway import (JWK import requires both).
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), Buffer.from(secret)]);
  return createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
}

export const nodeX25519: X25519Impl = {
  randomSecretKey: () => fromB64u(generateKeyPairSync("x25519").privateKey.export({ format: "jwk" }).d!),
  getPublicKey: (s) => fromB64u(createPublicKey(xPriv(s)).export({ format: "jwk" }).x!),
  getSharedSecret: (s, p) =>
    new Uint8Array(diffieHellman({ privateKey: xPriv(s), publicKey: createPublicKey({ key: { kty: "OKP", crv: "X25519", x: b64u(p) }, format: "jwk" }) })),
};

/* ── Agent key file ────────────────────────────────────────────────────────── */

interface KeyFile {
  v: 1;
  label: string;
  /** libsodium crypto_sign keypair (Ed25519): 32-byte public, 64-byte secret. */
  edPublic: string;
  edSecret: string;
  xSecret: string;
}

const safeLabel = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "agent";
const defaultKeyFile = (label: string) => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "filenymous", "agents", `${safeLabel(label)}.json`);

function keyFilePath(o: VaultOptions, label?: string): string {
  return o["key-file"] || process.env.FNY_AGENT_KEY_FILE || defaultKeyFile(label || o.name || "agent");
}

function loadKeys(path: string): KeyFile {
  if (!existsSync(path)) throw new Error(`no agent key file at ${path} (run: filenymous vault enroll --name <label>)`);
  if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) throw new Error(`${path} must not be readable by group/others (chmod 600)`);
  const k = JSON.parse(readFileSync(path, "utf8")) as KeyFile;
  if (k.v !== 1 || !k.edPublic || !k.edSecret || !k.xSecret) throw new Error(`invalid agent key file ${path}`);
  return k;
}

async function enroll(o: VaultOptions): Promise<number> {
  const label = (o.name || "agent").slice(0, 64);
  const path = keyFilePath(o, label);
  if (existsSync(path) && !o.force) throw new Error(`${path} already exists (use --force to replace it, which invalidates tokens issued to it)`);
  const { generateSigningKeyPair } = await import("@holochain/client");
  const [kp] = await generateSigningKeyPair();
  const xSecret = nodeX25519.randomSecretKey();
  const file: KeyFile = { v: 1, label, edPublic: b64u(kp.publicKey), edSecret: b64u(kp.privateKey), xSecret: b64u(xSecret) };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
  const pub = { ed: kp.publicKey, x: nodeX25519.getPublicKey(xSecret), label };
  const code = encodeEnrollment(pub);
  const fp = await enrollmentFingerprint(pub);
  if (o.json) process.stdout.write(`${JSON.stringify({ event: "enrolled", code, fingerprint: fp, keyFile: path })}\n`);
  else {
    process.stdout.write(`${code}\n`);
    if (!o.quiet) err(`Agent keys saved to ${path} (keep it private).\nFingerprint: ${fp}\nPaste the code above into Coffre-fort › Agents › Issue a token, check the fingerprint, then run:\n  FNY_AGENT_TOKEN='<token>' filenymous vault run --key-file ${path} -- <agent command>`);
  }
  return 0;
}

/* ── Conductor connection ─────────────────────────────────────────────────── */

function readToken(o: VaultOptions): AgentTokenFile {
  const raw = o.token ? readFileSync(o.token, "utf8") : process.env.FNY_AGENT_TOKEN;
  if (!raw) throw new Error("no agent token: pass --token <file> or set FNY_AGENT_TOKEN");
  const t = decodeTokenFile(raw);
  if (t.expiresAt && Date.now() >= t.expiresAt) throw new Error(`token expired at ${new Date(t.expiresAt).toISOString()}`);
  return t;
}

type Client = { callZome(req: unknown, timeout?: number): Promise<unknown>; client?: { close(): Promise<unknown> } };

async function connect(t: AgentTokenFile, keys: KeyFile, o: VaultOptions): Promise<{ app: Client; cellId: [Uint8Array, Uint8Array] }> {
  const hc = await import("@holochain/client");
  const origin = "filenymous-cli";
  let appToken: number[] | undefined;
  const given = o["app-token"] || process.env.FNY_APP_TOKEN;
  const adminUrl = o["admin-url"] || process.env.FNY_ADMIN_URL;
  if (given) appToken = Array.from(fromB64u(given));
  else if (adminUrl) {
    // Local node only: a short-lived, single-use app-interface token.
    const admin = await hc.AdminWebsocket.connect({ url: new URL(adminUrl), wsClientOptions: { origin } });
    const issued = await admin.issueAppAuthenticationToken({ installed_app_id: t.installedAppId, expiry_seconds: 30, single_use: true });
    appToken = issued.token;
    await admin.client.close();
  } else throw new Error("no app-interface token: pass --app-token / FNY_APP_TOKEN, or --admin-url ws://127.0.0.1:<admin port> on the owner's machine");
  const app = await hc.AppWebsocket.connect({ url: new URL(t.appUrl), token: appToken, wsClientOptions: { origin } });
  const cellId: [Uint8Array, Uint8Array] = [fromB64u(t.cellId[0]), fromB64u(t.cellId[1])];
  const ed = fromB64u(keys.edPublic);
  hc.setSigningCredentials(cellId as never, {
    capSecret: fromB64u(t.capSecret),
    keyPair: { publicKey: ed, privateKey: fromB64u(keys.edSecret), keyType: "ed25519" },
    signingKey: agentPubKeyFromEd25519(ed),
  });
  return { app: app as unknown as Client, cellId };
}

type FetchResult = { status: "granted"; bundle: SealedBundleWire & { version: number }; expires_at: number } | { status: "denied"; reason: string };

async function fetchEnv(o: VaultOptions): Promise<{ env: Record<string, string>; token: AgentTokenFile; version: number }> {
  const token = readToken(o);
  const keys = loadKeys(keyFilePath(o, token.label));
  const { app, cellId } = await connect(token, keys, o);
  try {
    const r = (await app.callZome({ cell_id: cellId, zome_name: "agent_vault", fn_name: "fetch_bundle", payload: { token_id: token.tokenId } })) as FetchResult;
    if (r.status !== "granted") throw new Error(`access denied by the vault: ${r.reason}`);
    const xSecret = fromB64u(keys.xSecret);
    const env = await openAgentBundle(nodeX25519, xSecret, r.bundle, { tokenId: token.tokenId, version: r.bundle.version });
    xSecret.fill(0);
    return { env, token, version: r.bundle.version };
  } finally {
    await app.client?.close().catch(() => undefined);
  }
}

/** Child environment: parent env minus our own secrets, plus the bundle. */
export function childEnv(parent: NodeJS.ProcessEnv, bundle: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent };
  for (const k of SECRET_ENV) delete env[k];
  Object.assign(env, bundle);
  env.FNY_AGENT_ENV_NAMES = Object.keys(bundle).sort().join(",");
  return env;
}

async function run(cmd: string[], o: VaultOptions): Promise<number> {
  if (!cmd.length) throw new Error("usage: filenymous vault run [--token <file>] -- <command> [args…]");
  const { env, token, version } = await fetchEnv(o);
  if (!o.quiet) err(`filenymous vault: injected ${Object.keys(env).length} variable(s) for "${token.label}" (v${version}, token expires ${new Date(token.expiresAt).toISOString()})`);
  const child = spawn(cmd[0]!, cmd.slice(1), { stdio: "inherit", env: childEnv(process.env, env) });
  for (const k of Object.keys(env)) env[k] = "";
  const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  return new Promise((done) => {
    child.on("error", (e) => { err(`filenymous vault: ${e.message}`); done(127); });
    child.on("exit", (code, signal) => done(code ?? (signal ? 128 : 1)));
  });
}

async function status(o: VaultOptions): Promise<Record<string, unknown>> {
  const token = readToken(o);
  const keys = loadKeys(keyFilePath(o, token.label));
  const { app, cellId } = await connect(token, keys, o);
  try {
    const s = (await app.callZome({ cell_id: cellId, zome_name: "agent_vault", fn_name: "token_status", payload: { token_id: token.tokenId } })) as Record<string, unknown>;
    return {
      label: s.label,
      token_id: s.token_id,
      revoked: s.revoked,
      expired: s.expired,
      uses: s.uses,
      max_uses: s.max_uses,
      expires_at: new Date(Number(s.expires_at) / 1000).toISOString(),
      latest_version: s.latest_version,
    };
  } finally {
    await app.client?.close().catch(() => undefined);
  }
}

/* ── Read-only MCP (stdio, JSON-RPC) ──────────────────────────────────────── */

const MCP_TOOLS = [
  { name: "vault_list_env_names", description: "Names (never values) of the credentials injected into this agent's environment by `filenymous vault run`.", inputSchema: { type: "object", properties: {} } },
  { name: "vault_token_status", description: "Status of this agent's Filenymous vault token: expiry, revocation, launches used. No secret values.", inputSchema: { type: "object", properties: {} } },
];

function mcp(o: VaultOptions): Promise<number> {
  const send = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
  const text = (v: unknown, isError = false) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }], isError });
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      if (!line.trim()) return;
      let m: { id?: string | number | null; method?: string; params?: Record<string, unknown> };
      try {
        m = JSON.parse(line);
      } catch {
        return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      }
      const id = m.id;
      const reply = (result: unknown) => id !== undefined && send({ jsonrpc: "2.0", id, result });
      switch (m.method) {
        case "initialize":
          return reply({
            protocolVersion: String(m.params?.protocolVersion ?? "2025-06-18"),
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "filenymous-vault", version: __VERSION__ },
            instructions: "Read-only view of the credentials Filenymous injected into your environment. Use the variables by name from your environment; never print, log, commit or send their values.",
          });
        case "notifications/initialized":
        case "notifications/cancelled":
          return;
        case "ping":
          return reply({});
        case "tools/list":
          return reply({ tools: MCP_TOOLS });
        case "tools/call": {
          const name = String(m.params?.name ?? "");
          try {
            if (name === "vault_list_env_names") return reply(text({ names: (process.env.FNY_AGENT_ENV_NAMES || "").split(",").filter(Boolean) }));
            if (name === "vault_token_status") return reply(text(await status(o)));
            return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${name}` } });
          } catch (e) {
            return reply(text(`error: ${String((e as Error).message || e)}`, true));
          }
        }
        default:
          if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${m.method}` } });
      }
    });
    rl.on("close", () => done(0));
  });
}

/** Offline check that this build seals and opens bundles for the enrolled key (no network). */
async function selftest(o: VaultOptions): Promise<number> {
  const keys = loadKeys(keyFilePath(o));
  const x = fromB64u(keys.xSecret);
  const sealed = await sealAgentBundle(nodeX25519, nodeX25519.getPublicKey(x), { FNY_SELFTEST: "ok" }, { tokenId: "selftest-token-0001", version: 1 });
  const env = await openAgentBundle(nodeX25519, x, sealed, { tokenId: "selftest-token-0001", version: 1 });
  process.stdout.write(`${JSON.stringify({ event: "selftest", ok: env.FNY_SELFTEST === "ok" })}\n`);
  return env.FNY_SELFTEST === "ok" ? 0 : 1;
}

export async function vault(args: string[], o: VaultOptions): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "enroll") return enroll(o);
  if (sub === "run") return run(rest, o);
  if (sub === "status") {
    process.stdout.write(`${JSON.stringify(await status(o), null, o.json ? 0 : 2)}\n`);
    return 0;
  }
  if (sub === "mcp") return mcp(o);
  if (sub === "selftest") return selftest(o);
  throw new Error("usage: filenymous vault enroll|run|status|mcp (see --help)");
}
