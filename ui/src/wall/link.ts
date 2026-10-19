/**
 * Sharewall links (live multi-peer wall, 100 % P2P around the host's tab).
 *
 * Peer link: `<app>#wall:<wallId>/<key>/<expiry>/<flags>`
 * Host link: `<app>#wall-host:<hostSecret>/<key>/<expiry>/<flags>[/<title>]`
 *
 * - `wallId` = "wall-" + hex(sha256(hostSecret))[:24]: the relay checks it, so
 *   only the host link can take the host role. The peer link never contains
 *   `hostSecret`.
 * - `key`: 32 random bytes (base64url) generated in the host's browser. It only
 *   lives in the URL fragment: browsers never send fragments, so neither the web
 *   host nor the signaling relay ever receives it.
 * - `expiry`: Unix seconds in base36, or `0` = no expiry (the default for new
 *   walls: a wall lives as long as its host keeps the tab open). Older links
 *   with an expiry (≤ 24 h) are still honoured.
 * - `flags`: `p`|`n` (password or not), then optional `1` (each item is
 *   destroyed after its first download) and `h` (the wall is destroyed when the
 *   host disconnects). Expiry and flags are bound into the key derivation, so
 *   editing them in the link breaks the handshake.
 * - `title` (host link only, optional): the wall's display name, base64url
 *   UTF-8, so a reloading host keeps it. Peers receive it inside the sealed
 *   welcome message, never in their link.
 */
import { b64urlDecode, b64urlEncode } from "../p2p/protocol";

export interface WallParams {
  wallId: string;
  key: string;
  /** ms since epoch; 0 = no expiry (lives with the host). */
  expiresAt: number;
  password: boolean;
  burn: boolean;
  hostLeave: boolean;
}

export interface HostWallParams extends WallParams {
  hostSecret: string;
  /** Display name (sanitised); "" = untitled. */
  title?: string;
}

export const WALL_TITLE_MAX = 80;

/** Trim, drop control/format characters, collapse whitespace, cap the length. */
export function sanitizeWallTitle(input: unknown): string {
  const s = String(input ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(s).slice(0, WALL_TITLE_MAX).join("").trim();
}

export const WALL_TTLS = { m15: 15 * 60_000, h1: 3600_000, h24: 24 * 3600_000 } as const;
export type WallTtl = keyof typeof WALL_TTLS;
export const WALL_MAX_TTL_MS = WALL_TTLS.h24;

const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const HOST_SECRET_RE = /^[A-Za-z0-9_-]{22,64}$/;
const WALL_ID_RE = /^wall-[a-f0-9]{24}$/;
const FLAGS_RE = /^[pn]1?h?$/;

export async function wallIdFor(hostSecret: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(hostSecret).slice().buffer as ArrayBuffer));
  return `wall-${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24)}`;
}

/**
 * New walls have no expiry: they live as long as the host keeps them open.
 * `ttl` is only kept for tests and legacy callers.
 */
export async function createWall(opts: { ttl?: WallTtl; title?: string; password?: boolean; burn?: boolean; hostLeave?: boolean; now?: number } = {}): Promise<HostWallParams> {
  const hostSecret = b64urlEncode(crypto.getRandomValues(new Uint8Array(24)));
  const ttl = opts.ttl ? WALL_TTLS[opts.ttl] : 0;
  return {
    hostSecret,
    wallId: await wallIdFor(hostSecret),
    key: b64urlEncode(crypto.getRandomValues(new Uint8Array(32))),
    expiresAt: ttl ? Math.floor(((opts.now ?? Date.now()) + ttl) / 1000) * 1000 : 0,
    title: sanitizeWallTitle(opts.title),
    password: !!opts.password,
    burn: !!opts.burn,
    hostLeave: !!opts.hostLeave,
  };
}

export function flagsOf(p: Pick<WallParams, "password" | "burn" | "hostLeave">): string {
  return `${p.password ? "p" : "n"}${p.burn ? "1" : ""}${p.hostLeave ? "h" : ""}`;
}

function tail(p: WallParams): string {
  return `${p.key}/${Math.floor(p.expiresAt / 1000).toString(36)}/${flagsOf(p)}`;
}

export function buildWallLink(baseUrl: string, p: WallParams): string {
  return `${baseUrl.split("#")[0]}#wall:${p.wallId}/${tail(p)}`;
}

export function buildHostLink(baseUrl: string, p: HostWallParams): string {
  const title = sanitizeWallTitle(p.title);
  return `${baseUrl.split("#")[0]}#wall-host:${p.hostSecret}/${tail(p)}${title ? `/${b64urlEncode(new TextEncoder().encode(title))}` : ""}`;
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

function parseTail(parts: string[]): Omit<WallParams, "wallId"> | null {
  if (parts.length !== 3) return null;
  const [key, exp, flags] = parts as [string, string, string];
  if (!KEY_RE.test(key) || !/^[0-9a-z]{1,10}$/.test(exp) || !FLAGS_RE.test(flags)) return null;
  const expiresAt = parseInt(exp, 36) * 1000;
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) return null;
  return { key, expiresAt, password: flags[0] === "p", burn: flags.includes("1"), hostLeave: flags.includes("h") };
}

export function parseWallLink(input: string): WallParams | null {
  const raw = fragmentOf(input);
  if (!raw.startsWith("wall:")) return null;
  const [wallId, ...rest] = raw.slice(5).split("/");
  if (!wallId || !WALL_ID_RE.test(wallId)) return null;
  const t = parseTail(rest);
  return t ? { wallId, ...t } : null;
}

export async function parseHostLink(input: string): Promise<HostWallParams | null> {
  const raw = fragmentOf(input);
  if (!raw.startsWith("wall-host:")) return null;
  const [hostSecret, ...rest] = raw.slice(10).split("/");
  if (!hostSecret || !HOST_SECRET_RE.test(hostSecret)) return null;
  let title = "";
  if (rest.length === 4) {
    const enc = rest.pop()!;
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(enc)) return null;
    try {
      title = sanitizeWallTitle(new TextDecoder("utf-8", { fatal: true }).decode(b64urlDecode(enc)));
    } catch {
      return null;
    }
  }
  const t = parseTail(rest);
  return t ? { hostSecret, wallId: await wallIdFor(hostSecret), ...t, title } : null;
}

export function isWallHash(hash: string): boolean {
  return /^#wall:/.test(hash);
}

export function isWallHostHash(hash: string): boolean {
  return /^#wall-(host:|new$)/.test(hash);
}

export function isExpired(p: Pick<WallParams, "expiresAt">, now = Date.now()): boolean {
  return p.expiresAt > 0 && p.expiresAt <= now;
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

/**
 * Short "wall code" everyone sees (host and peers), derived from the key: the
 * relay can't compute it. Compare it out loud to be sure you are all on the
 * same wall (a forged or swapped link shows a different code).
 */
export async function wallCode(p: Pick<WallParams, "wallId" | "key">): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`filenymous-wall-code|${p.wallId}|${p.key}`).slice().buffer as ArrayBuffer));
  const chars = Array.from(digest.subarray(0, 8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}
