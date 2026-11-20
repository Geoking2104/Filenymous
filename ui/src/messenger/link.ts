/**
 * Friend-invite links of the messenger: "#contact:<payload>". Kept free of
 * crypto imports so the header button and the router can test a hash
 * without loading the messenger chunk.
 */
export const FRIEND_INVITE_PREFIX = "#contact:";

export function isFriendInviteHash(hash: string): boolean {
  return hash.startsWith(FRIEND_INVITE_PREFIX) && hash.length > FRIEND_INVITE_PREFIX.length;
}

/** Window event fired whenever the local profile or friend list changes. */
export const MESSENGER_CHANGED = "fny-messenger-changed";

export function emitMessengerChanged(): void {
  window.dispatchEvent(new Event(MESSENGER_CHANGED));
}
