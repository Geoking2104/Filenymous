/**
 * Coffre-fort contact invites: a link / QR that carries ONLY the public
 * contact card ("fny1.…": public keys + inbox id), in the # fragment so it is
 * never sent to a server. It lets someone add you as a contact; it gives no
 * access to any secret. Dependency-free (WebCrypto) so the UI chunk stays small.
 */
export const CONTACT_INVITE_PREFIX = "#safe-contact:";
const CARD_RE = /^fny1\.[A-Za-z0-9_-]{100,110}$/;
const REPLY_SUFFIX = "/r";

export interface ContactInvite {
  card: string;
  /** The link was sent back after the other person added you (no further reply offered). */
  reply: boolean;
}

export function isContactInviteHash(hash: string): boolean {
  return hash.startsWith(CONTACT_INVITE_PREFIX);
}

export function parseContactInvite(hash: string): ContactInvite | null {
  if (!isContactInviteHash(hash)) return null;
  let rest = hash.slice(CONTACT_INVITE_PREFIX.length);
  try {
    rest = decodeURIComponent(rest);
  } catch {
    return null;
  }
  const reply = rest.endsWith(REPLY_SUFFIX);
  const card = reply ? rest.slice(0, -REPLY_SUFFIX.length) : rest;
  return CARD_RE.test(card) ? { card, reply } : null;
}

export function buildContactInvite(base: string, card: string, reply = false): string {
  if (!CARD_RE.test(card)) throw new Error("bad-card");
  return `${base.replace(/#.*$/, "")}${CONTACT_INVITE_PREFIX}${card}${reply ? REPLY_SUFFIX : ""}`;
}

function fromB64u(s: string): Uint8Array {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "===".slice((t.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const B32 = "abcdefghijkmnpqrstuvwxyz23456789";

/** Same short identifier the vault shows ("fny-xxxx-xxxx-xxxx-xxxx"), computed from a card. */
export async function handleOfCard(card: string): Promise<string | null> {
  if (!CARD_RE.test(card)) return null;
  let b: Uint8Array;
  try {
    b = fromB64u(card.slice(5));
  } catch {
    return null;
  }
  if (b.length !== 76) return null;
  const tag = new TextEncoder().encode("fny-safe/handle/v1");
  const data = new Uint8Array(tag.length + 64);
  data.set(tag, 0);
  data.set(b.subarray(0, 64), tag.length);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  let bits = 0;
  let val = 0;
  let s = "";
  for (const byte of h.subarray(0, 10)) {
    val = ((val << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      s += B32[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return `fny-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
}
