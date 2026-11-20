import { describe, expect, it } from "vitest";
import { decodeCard, handleFor, inboxIdFor, inboxSecret, publicKeys } from "../safe/crypto";
import { createIdentity, messengerInboxSecret, newWrapKey, publicOf, unwrapIdentity, wrapIdentity } from "./identity";

describe("messenger identity", () => {
  it("builds a vault-format card and handle from its own key pair", async () => {
    const id = createIdentity();
    const pub = await publicOf(id);
    expect(pub.handle).toMatch(/^fny-[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    const card = decodeCard(pub.card)!;
    const keys = publicKeys(id);
    expect(card.ed).toEqual(keys.ed);
    expect(card.x).toEqual(keys.x);
    expect(await handleFor(card.ed, card.x)).toBe(pub.handle);
  });

  it("uses an inbox that can't be linked to the vault inbox of the same keys", async () => {
    const id = createIdentity();
    const msgInbox = await inboxIdFor(await messengerInboxSecret(id));
    const vaultInbox = await inboxIdFor(await inboxSecret(id));
    expect(msgInbox).toMatch(/^wall-[0-9a-f]{24}$/);
    expect(msgInbox).not.toBe(vaultInbox);
    expect(decodeCard((await publicOf(id)).card)!.inbox).toBe(msgInbox);
  });

  it("is a new key pair each time (separate from any vault identity)", async () => {
    const a = await publicOf(createIdentity());
    const b = await publicOf(createIdentity());
    expect(a.handle).not.toBe(b.handle);
  });

  it("seals the secrets with a non-extractable key and opens them back", async () => {
    const id = createIdentity();
    const key = await newWrapKey();
    expect(key.extractable).toBe(false);
    const w = await wrapIdentity(id, key);
    expect(w.ct.length).toBe(64 + 16);
    const back = await unwrapIdentity(w);
    expect(back.edSecret).toEqual(id.edSecret);
    expect(back.xSecret).toEqual(id.xSecret);
    const other = await newWrapKey();
    await expect(unwrapIdentity({ ...w, key: other })).rejects.toBeTruthy();
    const tampered = w.ct.slice();
    tampered[0]! ^= 1;
    await expect(unwrapIdentity({ ...w, ct: tampered })).rejects.toBeTruthy();
  });
});
