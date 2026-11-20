import { describe, expect, it } from "vitest";
import { b64u, dec, enc, fromB64u } from "../safe/crypto";
import { createIdentity, publicOf } from "./identity";
import { FRIEND_INVITE_PREFIX, NAME_MAX, buildFriendInvite, cleanName, isFriendInviteHash, newRequestId, parseFriendInvite } from "./invite";
import { serviceRoute } from "../home/routes";

async function person() {
  const id = createIdentity();
  return { id, ...(await publicOf(id)) };
}

const hashOf = (url: string) => url.slice(url.indexOf("#"));

function editPayload(hash: string, edit: (w: Record<string, unknown>) => void): string {
  const w = JSON.parse(dec.decode(fromB64u(hash.slice(FRIEND_INVITE_PREFIX.length)))) as Record<string, unknown>;
  edit(w);
  return FRIEND_INVITE_PREFIX + b64u(enc.encode(JSON.stringify(w)));
}

describe("friend invites", () => {
  it("round-trips a signed invite through the # fragment", async () => {
    const a = await person();
    const url = buildFriendInvite("https://filenymous.eu/app/#document", a.id, a.card, { name: "  Alice  " });
    expect(url.startsWith(`https://filenymous.eu/app/${FRIEND_INVITE_PREFIX}`)).toBe(true);
    const h = hashOf(url);
    expect(isFriendInviteHash(h)).toBe(true);
    const inv = await parseFriendInvite(h);
    expect(inv).toMatchObject({ card: a.card, handle: a.handle, name: "Alice", reply: false });
    expect(inv!.to).toBeUndefined();
  });

  it("carries reply, recipient, request id and vault reference", async () => {
    const a = await person();
    const b = await person();
    const vault = await person();
    const rid = newRequestId();
    const h = hashOf(buildFriendInvite("https://x/app/", b.id, b.card, { name: "Bob", reply: true, to: a.handle, rid, ref: vault.card }));
    expect(await parseFriendInvite(h)).toMatchObject({ handle: b.handle, name: "Bob", reply: true, to: a.handle, rid, ref: vault.card });
  });

  it("rejects edited fields, a foreign signature and malformed payloads", async () => {
    const a = await person();
    const m = await person();
    const h = hashOf(buildFriendInvite("https://x/", a.id, a.card, { name: "Alice" }));
    expect(await parseFriendInvite(editPayload(h, (w) => (w.n = "Mallory")))).toBeNull();
    expect(await parseFriendInvite(editPayload(h, (w) => (w.c = m.card)))).toBeNull();
    expect(await parseFriendInvite(editPayload(h, (w) => (w.r = 1)))).toBeNull();
    expect(await parseFriendInvite(editPayload(h, (w) => (w.extra = 1)))).toBeNull();
    // Signed by someone else's key but claiming a's card.
    expect(await parseFriendInvite(hashOf(buildFriendInvite("https://x/", m.id, a.card, { name: "Alice" })))).toBeNull();
    expect(await parseFriendInvite(`${FRIEND_INVITE_PREFIX}not*base64`)).toBeNull();
    expect(await parseFriendInvite(`${FRIEND_INVITE_PREFIX}${b64u(enc.encode("{}"))}`)).toBeNull();
    expect(await parseFriendInvite(`${FRIEND_INVITE_PREFIX}${"A".repeat(5000)}`)).toBeNull();
    expect(await parseFriendInvite("#safe-contact:fny1.x")).toBeNull();
  });

  it("refuses a reply without recipient and invites dated in the future", async () => {
    const a = await person();
    expect(() => buildFriendInvite("https://x/", a.id, a.card, { name: "A", to: "nope" })).toThrow();
    const future = hashOf(buildFriendInvite("https://x/", a.id, a.card, { name: "A" }, Date.now() + 3_600_000));
    expect(await parseFriendInvite(future)).toBeNull();
    const reply = hashOf(buildFriendInvite("https://x/", a.id, a.card, { name: "A", reply: true }));
    expect(await parseFriendInvite(reply)).toBeNull();
  });

  it("cleans display names (controls, bidi overrides, length)", () => {
    expect(cleanName(" a\u202eb\u0007c  d ")).toBe("abc d");
    expect(Array.from(cleanName("é".repeat(100))).length).toBe(NAME_MAX);
    expect(cleanName("   ")).toBe("");
  });

  it("is not mistaken for a transfer link or a vault invite by the router", () => {
    expect(serviceRoute(`${FRIEND_INVITE_PREFIX}abc`)).toBe("home");
    expect(isFriendInviteHash("#contact:")).toBe(false);
    expect(isFriendInviteHash("#safe-contact:fny1.abc")).toBe(false);
  });
});
