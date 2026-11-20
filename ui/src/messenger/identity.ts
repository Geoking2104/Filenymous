/**
 * Messenger identity ("Profil Filenymous"): one Ed25519 + X25519 key pair per
 * device, separate from the Coffre-fort key, so it stays usable while the vault
 * is locked. Same card format ("fny1.") and handle ("fny-xxxx-…") as the vault,
 * built on the vault's audited primitives (ui/src/safe/crypto.ts).
 *
 * At rest the two 32-byte secrets are sealed with a non-extractable AES-GCM
 * key kept next to them in IndexedDB: it stops a raw copy of the disk files
 * from yielding the keys, not a script running in the page (XSS).
 */
import {
  aesOpen,
  aesSeal,
  b64u,
  concat,
  enc,
  encodeCard,
  handleFor,
  hmacSha256,
  inboxIdFor,
  newIdentity,
  publicKeys,
  type Identity,
} from "../safe/crypto";

export type { Identity };

export interface PublicProfileKeys {
  handle: string;
  card: string;
}

const WRAP_AAD = enc.encode("fny-msg/identity/v1");

export function createIdentity(): Identity {
  return newIdentity();
}

/** Relay inbox of the messenger (distinct label from the vault inbox, so the two can't be linked). */
export async function messengerInboxSecret(id: Identity): Promise<string> {
  return b64u(await hmacSha256(id.edSecret, enc.encode("fny-msg/inbox/v1")));
}

export async function publicOf(id: Identity): Promise<PublicProfileKeys> {
  const pub = publicKeys(id);
  const inbox = await inboxIdFor(await messengerInboxSecret(id));
  return { handle: await handleFor(pub.ed, pub.x), card: encodeCard({ ...pub, inbox }) };
}

export interface WrappedIdentity {
  key: CryptoKey;
  iv: Uint8Array;
  ct: Uint8Array;
}

export async function newWrapKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function wrapIdentity(id: Identity, key: CryptoKey): Promise<WrappedIdentity> {
  const plain = concat(id.edSecret, id.xSecret);
  try {
    const s = await aesSeal(key, plain, WRAP_AAD);
    return { key, iv: s.iv, ct: s.ct };
  } finally {
    plain.fill(0);
  }
}

export async function unwrapIdentity(w: WrappedIdentity): Promise<Identity> {
  const plain = await aesOpen(w.key, { iv: w.iv, ct: w.ct }, WRAP_AAD);
  if (plain.length !== 64) throw new Error("bad-identity");
  const id = { edSecret: plain.slice(0, 32), xSecret: plain.slice(32, 64) };
  plain.fill(0);
  return id;
}
