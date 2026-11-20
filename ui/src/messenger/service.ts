/**
 * Messenger operations on top of the local store: profile, my invite link,
 * accepting / confirming friends, importing vault contacts.
 */
import { createIdentity, newWrapKey, publicOf, unwrapIdentity, wrapIdentity, type Identity } from "./identity";
import { buildFriendInvite, cleanName, newRequestId, parseFriendInvite, type FriendInvite } from "./invite";
import { DEFAULT_PRIVACY, deleteFriend, getFriend, getIdentity, getProfile, listFriends, putFriend, putIdentity, putProfile, type Friend, type Profile } from "./store";

export interface Me {
  profile: Profile;
  handle: string;
  card: string;
}

let cached: { id: Identity; handle: string; card: string } | null = null;

async function loadKeys(): Promise<{ id: Identity; handle: string; card: string } | null> {
  if (cached) return cached;
  const s = await getIdentity();
  if (!s) return null;
  cached = { id: await unwrapIdentity(s), handle: s.handle, card: s.card };
  return cached;
}

async function ensureKeys(): Promise<{ id: Identity; handle: string; card: string }> {
  const have = await loadKeys();
  if (have) return have;
  const id = createIdentity();
  const pub = await publicOf(id);
  const w = await wrapIdentity(id, await newWrapKey());
  await putIdentity({ ...w, ...pub });
  cached = { id, ...pub };
  return cached;
}

export function forgetCachedKeys(): void {
  cached = null;
}

export async function loadMe(): Promise<Me | null> {
  const [profile, keys] = await Promise.all([getProfile(), getIdentity()]);
  if (!profile || !keys) return null;
  return { profile, handle: keys.handle, card: keys.card };
}

export async function createProfile(displayName: string, avatar?: Blob): Promise<Me> {
  const name = cleanName(displayName);
  if (!name) throw new Error("bad-name");
  const keys = await ensureKeys();
  const now = Date.now();
  const profile: Profile = { displayName: name, ...(avatar ? { avatar } : {}), ...DEFAULT_PRIVACY, createdAt: now, updatedAt: now };
  await putProfile(profile);
  return { profile, handle: keys.handle, card: keys.card };
}

export async function updateProfile(patch: Partial<Omit<Profile, "createdAt" | "updatedAt">>): Promise<Profile> {
  const cur = await getProfile();
  if (!cur) throw new Error("no-profile");
  const next: Profile = { ...cur, ...patch, updatedAt: Date.now() };
  if (patch.displayName !== undefined) {
    next.displayName = cleanName(patch.displayName);
    if (!next.displayName) throw new Error("bad-name");
  }
  if ("avatar" in patch && !patch.avatar) delete next.avatar;
  await putProfile(next);
  return next;
}

function appBase(): string {
  return `${location.origin}${location.pathname}`;
}

/** My general invite link (anyone who opens it can ask to become my friend). */
export async function myInviteLink(extra: { rid?: string; ref?: string } = {}): Promise<string> {
  const keys = await ensureKeys();
  const profile = await getProfile();
  if (!profile) throw new Error("no-profile");
  return buildFriendInvite(appBase(), keys.id, keys.card, { name: profile.displayName, ...extra });
}

export type InviteOutcome =
  | { kind: "invalid" }
  | { kind: "self" }
  | { kind: "not-for-me" }
  | { kind: "already"; friend: Friend }
  | { kind: "saved"; friend: Friend; invite: FriendInvite };

/**
 * Records an opened "#contact:" link as a pending invitation (or a pending
 * acceptance, for a reply). Nothing is accepted automatically.
 */
export async function receiveInvite(hash: string): Promise<InviteOutcome> {
  const inv = await parseFriendInvite(hash);
  if (!inv) return { kind: "invalid" };
  const keys = await loadKeys();
  if (keys && inv.handle === keys.handle) return { kind: "self" };
  if (inv.reply && keys && inv.to !== keys.handle) return { kind: "not-for-me" };
  if (inv.reply && !keys) return { kind: "not-for-me" };
  const existing = await getFriend(inv.handle);
  if (existing?.status === "friend") {
    // Keep the newest name they chose.
    if (existing.name !== inv.name) await putFriend({ ...existing, name: inv.name });
    return { kind: "already", friend: existing };
  }
  const friend: Friend = {
    id: inv.handle,
    status: inv.reply ? "reply" : "incoming",
    name: inv.name,
    handle: inv.handle,
    card: inv.card,
    source: "link",
    createdAt: existing?.createdAt ?? Date.now(),
    ...(inv.ref ? { ref: inv.ref } : {}),
    ...(inv.rid ? { rid: inv.rid } : {}),
    invite: hash,
  };
  await putFriend(friend);
  return { kind: "saved", friend, invite: inv };
}

/** I accept someone's invite: they become my friend; returns the reply link to send them. */
export async function acceptInvite(friendId: string): Promise<string> {
  const f = await getFriend(friendId);
  if (!f || f.status !== "incoming" || !f.invite) throw new Error("no-invite");
  const inv = await parseFriendInvite(f.invite, Number.MAX_SAFE_INTEGER);
  if (!inv || inv.handle !== f.id) throw new Error("bad-invite");
  const keys = await ensureKeys();
  const profile = await getProfile();
  if (!profile) throw new Error("no-profile");
  const replyLink = buildFriendInvite(appBase(), keys.id, keys.card, { name: profile.displayName, reply: true, to: inv.handle, ...(inv.rid ? { rid: inv.rid } : {}) });
  await putFriend({ ...f, status: "friend", replyLink });
  return replyLink;
}

/** I confirm that someone accepted my invite: they become my friend. */
export async function confirmReply(friendId: string): Promise<void> {
  const f = await getFriend(friendId);
  if (!f || f.status !== "reply") throw new Error("no-reply");
  await putFriend({ ...f, status: "friend" });
  if (f.rid) {
    // The reply answers a request I prepared for a vault contact: that request is done.
    for (const o of await listFriends()) if (o.status === "outgoing" && o.rid === f.rid) await deleteFriend(o.id);
  }
}

export async function declineOrRemove(friendId: string): Promise<void> {
  await deleteFriend(friendId);
}

export interface VaultContact {
  handle: string;
  alias: string;
  card: string;
}

/**
 * Imported vault contacts become outgoing friend requests. The messenger key is
 * different from the vault key, so each one must accept again. The request link
 * carries my vault card ("ref") so they recognise me. In M1 the link is sent by
 * hand; M2 delivers it through the encrypted relay mailbox.
 */
export async function importVaultContacts(contacts: VaultContact[], myVaultCard?: string): Promise<number> {
  let n = 0;
  for (const c of contacts) {
    const id = `safe:${c.handle}`;
    if (await getFriend(id)) continue;
    await putFriend({ id, status: "outgoing", name: cleanName(c.alias) || c.handle, source: "safe", createdAt: Date.now(), ref: c.card, rid: newRequestId(), ...(myVaultCard ? { myRef: myVaultCard } : {}) });
    n++;
  }
  return n;
}

/** Personal request link for an outgoing request (carries its request id and my vault card). */
export async function requestLink(friendId: string): Promise<string> {
  const f = await getFriend(friendId);
  if (!f || f.status !== "outgoing") throw new Error("no-request");
  return myInviteLink({ ...(f.rid ? { rid: f.rid } : {}), ...(f.myRef ? { ref: f.myRef } : {}) });
}
