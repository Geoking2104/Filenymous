import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";

/** Each "device" gets its own IndexedDB and a fresh copy of the modules. */
async function device() {
  vi.resetModules();
  const idb = new IDBFactory();
  globalThis.indexedDB = idb;
  const svc = await import("./service");
  const store = await import("./store");
  const use = () => {
    globalThis.indexedDB = idb;
  };
  return { svc, store, use };
}

describe("messenger friends flow (two devices, mutual acceptance)", () => {
  it("invite → accept → reply → confirm makes both friends; nothing is automatic", async () => {
    const A = await device();
    const meA = await A.svc.createProfile("Alice");
    const invite = await A.svc.myInviteLink();
    const B = await device();

    // B opens A's link: a pending invitation, not a friend yet.
    const got = await B.svc.receiveInvite(invite.slice(invite.indexOf("#")));
    expect(got.kind).toBe("saved");
    expect(await B.store.pendingCount()).toBe(1);
    expect((await B.store.listFriends())[0]).toMatchObject({ id: meA.handle, status: "incoming", name: "Alice" });

    const meB = await B.svc.createProfile("Bob");
    const reply = await B.svc.acceptInvite(meA.handle);
    expect((await B.store.getFriend(meA.handle))!.status).toBe("friend");

    // A opens B's reply: waiting for A's confirmation.
    A.use();
    const back = await A.svc.receiveInvite(reply.slice(reply.indexOf("#")));
    expect(back.kind).toBe("saved");
    expect((await A.store.getFriend(meB.handle))!.status).toBe("reply");
    await A.svc.confirmReply(meB.handle);
    expect((await A.store.getFriend(meB.handle))!.status).toBe("friend");
    expect(await A.store.pendingCount()).toBe(0);

    // Own link and replies meant for someone else are refused.
    expect((await A.svc.receiveInvite(invite.slice(invite.indexOf("#")))).kind).toBe("self");
    const C = await device();
    await C.svc.createProfile("Carol");
    expect((await C.svc.receiveInvite(reply.slice(reply.indexOf("#")))).kind).toBe("not-for-me");
  });

  it("vault contacts become outgoing requests whose reply closes them", async () => {
    const A = await device();
    await A.svc.createProfile("Alice");
    const vaultCard = (await import("./identity")).publicOf((await import("./identity")).createIdentity());
    const n = await A.svc.importVaultContacts([{ handle: "fny-aaaa-bbbb-cccc-dddd", alias: "Bob (Coffre)", card: (await vaultCard).card }], (await vaultCard).card);
    expect(n).toBe(1);
    expect(await A.svc.importVaultContacts([{ handle: "fny-aaaa-bbbb-cccc-dddd", alias: "x", card: (await vaultCard).card }])).toBe(0);
    const req = (await A.store.listFriends())[0]!;
    expect(req).toMatchObject({ status: "outgoing", source: "safe", name: "Bob (Coffre)" });
    const link = await A.svc.requestLink(req.id);
    const meA = (await A.svc.loadMe())!;

    const B = await device();
    await B.svc.createProfile("Bob");
    const got = await B.svc.receiveInvite(link.slice(link.indexOf("#")));
    expect(got.kind === "saved" && got.invite.ref).toBe((await vaultCard).card);
    const reply = await B.svc.acceptInvite(meA.handle);

    const meB = await B.svc.loadMe();
    await A.svc.receiveInvite(reply.slice(reply.indexOf("#")));
    await A.svc.confirmReply(meB!.handle);
    const all = await A.store.listFriends();
    expect(all.map((f) => f.status)).toEqual(["friend"]);
  });
});
