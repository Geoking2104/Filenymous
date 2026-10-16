/**
 * Dropzone links (100 % P2P collection).
 *
 * Contributor link: `<app>#drop:<dropId>/<secret>/<expiry>/<flags>[/<name>]`
 * Owner link:       `<app>#drop-owner:<ownerSecret>/<secret>/<expiry>/<flags>[/<name>]`
 *
 * - `dropId` = "drop-" + hex(sha256(ownerSecret))[:24]: the relay checks it, so
 *   only the owner link can take the owner role. The contributor link never
 *   contains `ownerSecret`.
 * - `secret` (16 bytes, base64url) lives only in the URL fragment.
 * - `expiry`: Unix seconds in base36, `0` = none (relay default TTL applies).
 * - `flags`: `p` when a password is required, `n` otherwise.
 * - `name`: optional project name, base64url(UTF-8), cosmetic only.
 * expiry and flags are bound into the key derivation, so editing them in the
 * link only breaks the handshake.
 */
import { b64urlDecode, b64urlEncode, createSecret } from "../protocol";

export interface DropParams {
  dropId: string;
  secret: string;
  expiresAt: number; // ms since epoch, 0 = none
  password: boolean;
  name?: string;
}

export interface OwnerDropParams extends DropParams {
  ownerSecret: string;
}

const SECRET_RE = /^[A-Za-z0-9_-]{16,64}$/;
const DROP_ID_RE = /^drop-[a-f0-9]{24}$/;
const MAX_NAME = 80;

export async function dropIdFor(ownerSecret: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ownerSecret).slice().buffer as ArrayBuffer));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  return `drop-${hex.slice(0, 24)}`;
}

export function cleanProjectName(name: string | undefined): string | undefined {
  const cleaned = String(name ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_NAME);
  return cleaned || undefined;
}

export async function createDrop(opts: { expiresAt?: number; password?: boolean; name?: string } = {}): Promise<OwnerDropParams> {
  const ownerSecret = b64urlEncode(crypto.getRandomValues(new Uint8Array(24)));
  const params: OwnerDropParams = {
    ownerSecret,
    dropId: await dropIdFor(ownerSecret),
    secret: createSecret(),
    expiresAt: opts.expiresAt ? Math.floor(opts.expiresAt / 1000) * 1000 : 0,
    password: !!opts.password,
  };
  const name = cleanProjectName(opts.name);
  if (name) params.name = name;
  return params;
}

function tail(p: DropParams): string {
  const exp = p.expiresAt ? Math.floor(p.expiresAt / 1000).toString(36) : "0";
  const name = p.name ? `/${b64urlEncode(new TextEncoder().encode(p.name))}` : "";
  return `${p.secret}/${exp}/${p.password ? "p" : "n"}${name}`;
}

export function buildDropLink(baseUrl: string, p: DropParams): string {
  return `${baseUrl.split("#")[0]}#drop:${p.dropId}/${tail(p)}`;
}

export function buildOwnerLink(baseUrl: string, p: OwnerDropParams): string {
  return `${baseUrl.split("#")[0]}#drop-owner:${p.ownerSecret}/${tail(p)}`;
}

function fragmentOf(input: string): string {
  let raw = String(input || "").trim();
  const at = raw.indexOf("#");
  if (at >= 0) raw = raw.slice(at + 1);
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* keep raw */
  }
  return raw;
}

function parseTail(parts: string[]): Omit<DropParams, "dropId"> | null {
  const [secret, exp, flags, name] = parts;
  if (!secret || !SECRET_RE.test(secret)) return null;
  if (!exp || !/^[0-9a-z]{1,10}$/.test(exp)) return null;
  if (flags !== "p" && flags !== "n") return null;
  const out: Omit<DropParams, "dropId"> = { secret, expiresAt: parseInt(exp, 36) * 1000, password: flags === "p" };
  if (name) {
    try {
      const decoded = cleanProjectName(new TextDecoder("utf-8", { fatal: true }).decode(b64urlDecode(name)));
      if (decoded) out.name = decoded;
    } catch {
      /* ignore a broken name */
    }
  }
  return out;
}

export function parseDropLink(input: string): DropParams | null {
  const raw = fragmentOf(input);
  if (!raw.startsWith("drop:")) return null;
  const [dropId, ...rest] = raw.slice(5).split("/");
  if (!dropId || !DROP_ID_RE.test(dropId)) return null;
  const t = parseTail(rest);
  return t ? { dropId, ...t } : null;
}

export async function parseOwnerLink(input: string): Promise<OwnerDropParams | null> {
  const raw = fragmentOf(input);
  if (!raw.startsWith("drop-owner:")) return null;
  const [ownerSecret, ...rest] = raw.slice(11).split("/");
  if (!ownerSecret || !/^[A-Za-z0-9_-]{22,64}$/.test(ownerSecret)) return null;
  const t = parseTail(rest);
  return t ? { ownerSecret, dropId: await dropIdFor(ownerSecret), ...t } : null;
}

export function isDropHash(hash: string): boolean {
  return /^#drop:/.test(hash);
}

export function isDropOwnerHash(hash: string): boolean {
  return /^#drop-(owner:|new$)/.test(hash);
}

export function isExpired(p: Pick<DropParams, "expiresAt">, now = Date.now()): boolean {
  return p.expiresAt > 0 && p.expiresAt <= now;
}
