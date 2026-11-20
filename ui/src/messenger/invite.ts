/**
 * Signed friend invites carried in the "#contact:" fragment (never sent to a
 * server). The payload holds only public data: the inviter's messenger card,
 * display name and an Ed25519 signature over every field, so a forwarded link
 * can't be edited (e.g. its name changed) without breaking the signature.
 *
 * Flow (mutual acceptance, no relay needed in M1):
 *   A shares an invite → B opens it and accepts (A becomes B's friend) →
 *   B sends back the reply link (reply = true, to = A's handle) → A opens it
 *   and confirms (B becomes A's friend).
 */
import { b64u, decodeCard, dec, enc, fromB64u, handleFor, sign, verify, type Identity } from "../safe/crypto";
import { FRIEND_INVITE_PREFIX, isFriendInviteHash } from "./link";

export { FRIEND_INVITE_PREFIX, isFriendInviteHash };

const CARD_RE = /^fny1\.[A-Za-z0-9_-]{100,110}$/;
const HANDLE_RE = /^fny-[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/;
const RID_RE = /^[A-Za-z0-9_-]{8,32}$/;
export const NAME_MAX = 40;
const MAX_PAYLOAD = 2048;
const MAX_SKEW_MS = 10 * 60_000;

export interface FriendInviteFields {
  /** Inviter's display name. */
  name: string;
  /** This link answers an invite (the sender already accepted). */
  reply?: boolean;
  /** Reply only: handle of the person who sent the original invite. */
  to?: string;
  /** Request id, echoed by the reply so the inviter can match it to a pending request. */
  rid?: string;
  /** Inviter's Coffre-fort card, so a vault contact recognises who is asking. */
  ref?: string;
}

export interface FriendInvite extends Required<Pick<FriendInviteFields, "name">> {
  card: string;
  handle: string;
  reply: boolean;
  to?: string;
  rid?: string;
  ref?: string;
  ts: number;
}

interface Wire {
  v: 1;
  c: string;
  n: string;
  r?: 1;
  to?: string;
  rid?: string;
  ref?: string;
  ts: number;
  s: string;
}

/** Display names: trimmed, no control / bidi-override characters, at most NAME_MAX code points. */
export function cleanName(name: string): string {
  const cleaned = name
    .replace(/[\p{Cc}\u200b-\u200f\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(cleaned).slice(0, NAME_MAX).join("");
}

function signedBytes(w: Omit<Wire, "s">): Uint8Array {
  return enc.encode(["fny-contact/v1", w.c, w.n, w.r ? "r" : "i", w.to ?? "", w.rid ?? "", w.ref ?? "", String(w.ts)].join("\n"));
}

export function newRequestId(): string {
  return b64u(crypto.getRandomValues(new Uint8Array(12)));
}

export function buildFriendInvite(base: string, id: Identity, card: string, f: FriendInviteFields, now = Date.now()): string {
  if (!CARD_RE.test(card)) throw new Error("bad-card");
  const name = cleanName(f.name);
  if (!name) throw new Error("bad-name");
  if (f.to !== undefined && !HANDLE_RE.test(f.to)) throw new Error("bad-to");
  if (f.rid !== undefined && !RID_RE.test(f.rid)) throw new Error("bad-rid");
  if (f.ref !== undefined && !CARD_RE.test(f.ref)) throw new Error("bad-ref");
  const w: Omit<Wire, "s"> = {
    v: 1,
    c: card,
    n: name,
    ...(f.reply ? { r: 1 as const } : {}),
    ...(f.to ? { to: f.to } : {}),
    ...(f.rid ? { rid: f.rid } : {}),
    ...(f.ref ? { ref: f.ref } : {}),
    ts: now,
  };
  const s = b64u(sign(id, signedBytes(w)));
  return `${base.replace(/#.*$/, "")}${FRIEND_INVITE_PREFIX}${b64u(enc.encode(JSON.stringify({ ...w, s })))}`;
}

/** Parses and verifies an invite hash. Returns null for anything malformed, tampered or forged. */
export async function parseFriendInvite(hash: string, now = Date.now()): Promise<FriendInvite | null> {
  if (!isFriendInviteHash(hash)) return null;
  const raw = hash.slice(FRIEND_INVITE_PREFIX.length);
  if (raw.length > MAX_PAYLOAD || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  let w: Wire;
  try {
    w = JSON.parse(dec.decode(fromB64u(raw))) as Wire;
  } catch {
    return null;
  }
  if (!w || typeof w !== "object" || w.v !== 1) return null;
  const allowed = new Set(["v", "c", "n", "r", "to", "rid", "ref", "ts", "s"]);
  if (Object.keys(w).some((k) => !allowed.has(k))) return null;
  if (typeof w.c !== "string" || !CARD_RE.test(w.c)) return null;
  if (typeof w.n !== "string" || !w.n || cleanName(w.n) !== w.n) return null;
  if (w.r !== undefined && w.r !== 1) return null;
  if (w.to !== undefined && (typeof w.to !== "string" || !HANDLE_RE.test(w.to))) return null;
  if (w.rid !== undefined && (typeof w.rid !== "string" || !RID_RE.test(w.rid))) return null;
  if (w.ref !== undefined && (typeof w.ref !== "string" || !CARD_RE.test(w.ref))) return null;
  if (!Number.isSafeInteger(w.ts) || w.ts <= 0 || w.ts > now + MAX_SKEW_MS) return null;
  if (w.r === 1 && !w.to) return null;
  if (typeof w.s !== "string") return null;
  const pub = decodeCard(w.c);
  if (!pub) return null;
  let sig: Uint8Array;
  try {
    sig = fromB64u(w.s);
  } catch {
    return null;
  }
  const { s: _s, ...unsigned } = w;
  if (sig.length !== 64 || !verify(pub.ed, signedBytes(unsigned), sig)) return null;
  return {
    card: w.c,
    handle: await handleFor(pub.ed, pub.x),
    name: w.n,
    reply: w.r === 1,
    ...(w.to ? { to: w.to } : {}),
    ...(w.rid ? { rid: w.rid } : {}),
    ...(w.ref ? { ref: w.ref } : {}),
    ts: w.ts,
  };
}
