/**
 * Agent Vault wire formats, shared by the web app (Coffre-fort worker) and the
 * CLI runner (`filenymous vault run`). No npm imports on purpose: the CLI
 * bundles this file and only needs WebCrypto plus an X25519 implementation
 * (noble in the browser, node:crypto in the CLI).
 *
 * Sealed bundle: ephemeral X25519 → ECDH with the agent's X25519 key →
 * HKDF-SHA256(salt = eph ‖ agentX, info = "fny-agent/bundle/v1") →
 * AES-256-GCM, AAD = "fny-agent/v1|<token_id>|<version>" (binds a bundle to
 * one token and one version; a swapped or replayed blob fails to open).
 */

export const AGENT_SEAL_ALG = "x25519-hkdf-sha256-aes256gcm/v1";
const INFO = "fny-agent/bundle/v1";
const ENROLL_PREFIX = "fny-agent:v1:";
const TOKEN_PREFIX = "fny-agent-token:v1:";
/** Must match MAX_BUNDLE_BYTES in the integrity zome. */
export const MAX_BUNDLE_BYTES = 64 * 1024;
export const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;

export interface X25519Impl {
  randomSecretKey(): Uint8Array;
  getPublicKey(secret: Uint8Array): Uint8Array;
  getSharedSecret(secret: Uint8Array, pub: Uint8Array): Uint8Array;
}

export interface SealedBundleWire {
  alg: string;
  eph_pub: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

export interface Binding {
  tokenId: string;
  version: number;
}

const te = new TextEncoder();
const td = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;
const ab = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;

export function b64u(bytes: Uint8Array): string {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64u(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export function randomId(bytes = 16): string {
  return b64u(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
}

function aad(b: Binding): Uint8Array {
  return te.encode(`fny-agent/v1|${b.tokenId}|${b.version}`);
}

async function contentKey(shared: Uint8Array, eph: Uint8Array, agentX: Uint8Array): Promise<CryptoKey> {
  const salt = new Uint8Array(eph.length + agentX.length);
  salt.set(eph);
  salt.set(agentX, eph.length);
  const ikm = await subtle().importKey("raw", ab(shared), "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: te.encode(INFO) }, ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export function validateEnv(env: Record<string, string>): void {
  const names = Object.keys(env);
  if (!names.length) throw new Error("empty-bundle");
  for (const n of names) if (!ENV_NAME.test(n)) throw new Error(`bad-env-name:${n}`);
}

export async function sealAgentBundle(x: X25519Impl, agentX: Uint8Array, env: Record<string, string>, binding: Binding): Promise<SealedBundleWire> {
  if (agentX.length !== 32) throw new Error("bad-agent-key");
  validateEnv(env);
  const plain = te.encode(JSON.stringify({ v: 1, env }));
  if (plain.length + 16 > MAX_BUNDLE_BYTES) throw new Error("bundle-too-large");
  const ephSecret = x.randomSecretKey();
  const eph = x.getPublicKey(ephSecret);
  const shared = x.getSharedSecret(ephSecret, agentX);
  ephSecret.fill(0);
  const key = await contentKey(shared, eph, agentX);
  shared.fill(0);
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: nonce, additionalData: ab(aad(binding)) }, key, plain));
  plain.fill(0);
  return { alg: AGENT_SEAL_ALG, eph_pub: eph, nonce, ciphertext: ct };
}

export async function openAgentBundle(x: X25519Impl, agentSecret: Uint8Array, bundle: SealedBundleWire, binding: Binding): Promise<Record<string, string>> {
  if (bundle.alg !== AGENT_SEAL_ALG) throw new Error("unsupported-alg");
  const agentX = x.getPublicKey(agentSecret);
  const eph = new Uint8Array(bundle.eph_pub);
  const shared = x.getSharedSecret(agentSecret, eph);
  const key = await contentKey(shared, eph, agentX);
  shared.fill(0);
  const plain = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: ab(new Uint8Array(bundle.nonce)), additionalData: ab(aad(binding)) }, key, ab(new Uint8Array(bundle.ciphertext))));
  const parsed = JSON.parse(td.decode(plain)) as { v: number; env: Record<string, string> };
  plain.fill(0);
  if (parsed.v !== 1 || typeof parsed.env !== "object" || !parsed.env) throw new Error("bad-bundle");
  validateEnv(parsed.env);
  return parsed.env;
}

/* ── Agent identity (enrollment code) ─────────────────────────────────────── */

export interface Enrollment {
  /** Ed25519 public key used to sign zome calls (32 bytes). */
  ed: Uint8Array;
  /** X25519 public key the bundle is sealed to (32 bytes). */
  x: Uint8Array;
  label: string;
}

/**
 * Holochain AgentPubKey for an Ed25519 key, as built by
 * `@holochain/client` generateSigningKeyPair(): 3-byte prefix, key, 4 zero
 * location bytes.
 */
export function agentPubKeyFromEd25519(ed: Uint8Array): Uint8Array {
  if (ed.length !== 32) throw new Error("bad-ed25519");
  const out = new Uint8Array(39);
  out.set([132, 32, 36]);
  out.set(ed, 3);
  return out;
}

export function encodeEnrollment(e: Enrollment): string {
  return ENROLL_PREFIX + b64u(te.encode(JSON.stringify({ ed: b64u(e.ed), x: b64u(e.x), l: e.label })));
}

export function decodeEnrollment(code: string): Enrollment {
  const s = code.trim();
  if (!s.startsWith(ENROLL_PREFIX)) throw new Error("bad-enrollment");
  const j = JSON.parse(td.decode(fromB64u(s.slice(ENROLL_PREFIX.length)))) as { ed: string; x: string; l?: string };
  const ed = fromB64u(j.ed);
  const x = fromB64u(j.x);
  if (ed.length !== 32 || x.length !== 32) throw new Error("bad-enrollment");
  return { ed, x, label: String(j.l ?? "").slice(0, 64) };
}

/** Short human check value shown on both sides (owner UI and runner). */
export async function enrollmentFingerprint(e: Pick<Enrollment, "ed" | "x">): Promise<string> {
  const d = new Uint8Array(await subtle().digest("SHA-256", ab(new Uint8Array([...e.ed, ...e.x]))));
  const h = Array.from(d.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
  return `fny-${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}`;
}

/* ── Token file handed to the runner (shown once in the UI) ───────────────── */

export interface AgentTokenFile {
  v: 1;
  /** App websocket of the owner's conductor, e.g. ws://127.0.0.1:8888 */
  appUrl: string;
  installedAppId: string;
  /** [dna_hash, owner_agent_pubkey], base64url */
  cellId: [string, string];
  tokenId: string;
  /** 64-byte capability secret, base64url */
  capSecret: string;
  /** Unix ms */
  expiresAt: number;
  label: string;
}

export function encodeTokenFile(t: AgentTokenFile): string {
  return TOKEN_PREFIX + b64u(te.encode(JSON.stringify(t)));
}

export function decodeTokenFile(s: string): AgentTokenFile {
  const v = s.trim();
  if (!v.startsWith(TOKEN_PREFIX)) throw new Error("bad-token-file");
  const t = JSON.parse(td.decode(fromB64u(v.slice(TOKEN_PREFIX.length)))) as AgentTokenFile;
  if (t.v !== 1 || !t.tokenId || !t.capSecret || !Array.isArray(t.cellId) || t.cellId.length !== 2 || !t.appUrl) throw new Error("bad-token-file");
  return t;
}
