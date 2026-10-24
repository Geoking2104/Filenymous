// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import { VaultRepo, type Db } from "./repo";
import { memoryDbFactory } from "./testdb";
import { randomBytes, hex } from "./crypto";

let mem: () => Db;
beforeAll(async () => {
  mem = await memoryDbFactory();
});

const FAST = { kdf: { t: 1, m: 1024, p: 1 } };

async function newVault(password = "Tr0ub4dor&3-orbite-tulipe") {
  const db = mem();
  const repo = new VaultRepo(db, mem, FAST);
  const { phrase } = await repo.create({ password });
  return { db, repo, phrase };
}

describe("VaultRepo", () => {
  it("creates, locks, unlocks with the password and recovers with the phrase", async () => {
    const { db, repo, phrase } = await newVault();
    const words = phrase.split(" ");
    expect(repo.checkPhrase([{ pos: 0, word: "nope" }, { pos: 1, word: words[1]! }, { pos: 2, word: words[2]! }])).toBe(false);
    expect(repo.checkPhrase([{ pos: 3, word: words[3]! }, { pos: 11, word: words[11]! }, { pos: 18, word: words[18]! }])).toBe(true);
    const id = await repo.put(null, { category: "login", title: "GitHub", tags: ["dev"], username: "geo", password: "hunter2", url: "https://github.com/login" });
    repo.lock();
    expect(() => repo.list()).toThrow("locked");
    // At rest: no plaintext anywhere in the database.
    const dump = JSON.stringify(db.selectObjects("SELECT * FROM secrets")) + JSON.stringify(db.selectObjects("SELECT * FROM meta"));
    expect(dump).not.toContain("hunter2");
    expect(dump).not.toContain("GitHub");
    expect(await repo.unlockPassword("wrong")).toBe(false);
    expect(await repo.unlockPassword("Tr0ub4dor&3-orbite-tulipe")).toBe(true);
    expect(repo.get(id).password).toBe("hunter2");
    repo.lock();
    expect(await repo.unlockPhrase(phrase.replace(/^\S+/, "zoo"))).toBe(false);
    expect(await repo.unlockPhrase(phrase)).toBe(true);
    expect(repo.status().needsNewPassword).toBe(true);
    await repo.setPassword("a-new-master-password-42!");
    repo.lock();
    expect(await repo.unlockPassword("Tr0ub4dor&3-orbite-tulipe")).toBe(false);
    expect(await repo.unlockPassword("a-new-master-password-42!")).toBe(true);
    expect(repo.list().map((i) => i.title)).toEqual(["GitHub"]);
  });

  it("supports a passkey PRF slot", async () => {
    const db = mem();
    const repo = new VaultRepo(db, mem, FAST);
    const prf = randomBytes(32);
    await repo.create({ passkey: { credId: "cred", salt: "salt", prf: prf.slice() } });
    repo.lock();
    expect(await repo.unlockPasskey(randomBytes(32))).toBe(false);
    expect(await repo.unlockPasskey(prf.slice())).toBe(true);
    expect(repo.status().passkey).toEqual({ credId: "cred", salt: "salt" });
  });

  it("versions edits, restores, deletes and searches with FTS5", async () => {
    const { repo } = await newVault();
    const id = await repo.put(null, { category: "login", title: "Serveur prod OVH", tags: ["infra"], username: "root", password: "aaa" });
    await repo.put(null, { category: "note", title: "Recette crêpes", tags: ["cuisine"], notes: "farine, oeufs, lait" });
    await repo.put(id, { category: "login", title: "Serveur prod OVH", tags: ["infra"], username: "root", password: "bbb" });
    expect(repo.versions(id).map((v) => v.version)).toEqual([2, 1]);
    expect((await repo.getVersion(id, 1)).password).toBe("aaa");
    await repo.restoreVersion(id, 1);
    expect(repo.get(id).password).toBe("aaa");
    expect(repo.search("ovh", null)[0]?.id).toBe(id);
    expect(repo.search("crepes", null)).toHaveLength(1);
    expect(repo.search("zzz", null)).toHaveLength(0);
    // Semantic component: a matching vector ranks even without a lexical hit.
    const v = new Float32Array(384).fill(0);
    v[0] = 1;
    await repo.setEmbedding(id, v);
    expect(repo.search("machines de production", v)[0]?.id).toBe(id);
    await repo.remove(id);
    expect(repo.list()).toHaveLength(1);
    expect(repo.search("ovh", null)).toHaveLength(0);
  });

  it("stores files in chunks with a Merkle root", async () => {
    const { repo, db } = await newVault();
    const bytes = randomBytes(1048576 + 1234);
    const id = await repo.put(null, { category: "file", title: "cert.pem", tags: [] }, { name: "cert.pem", type: "application/x-pem-file", bytes });
    const f = await repo.readFile(id);
    expect(hex(f.bytes)).toBe(hex(bytes));
    expect(repo.get(id).file?.chunks).toBe(2);
    db.exec("UPDATE file_chunks SET ciphertext = zeroblob(100) WHERE idx = 1");
    await expect(repo.readFile(id)).rejects.toThrow("integrity");
  });

  it("shares to a contact, enforces roles, syncs updates and detects concurrent edits", async () => {
    const alice = (await newVault("alice-password-very-long-1")).repo;
    const bob = (await newVault("bob-password-very-long-22")).repo;
    const eve = (await newVault("eve-password-very-long-333")).repo;
    const A = alice.identity();
    const Bi = bob.identity();
    await alice.addPeer(Bi.card, "Bob");
    const id = await alice.put(null, { category: "login", title: "Prod DB", tags: ["db"], username: "admin", password: "s3cret-Pa55" });
    const out = await alice.buildShare(id, Bi.handle, "editor", Date.now() + 3600_000);
    expect(out.envelope.h).not.toContain("s3cret");
    // Unknown sender → pending until accepted.
    const r1 = await bob.receive(out.envelope);
    expect(r1.status).toBe("pending");
    if (r1.status !== "pending") throw new Error();
    await bob.acceptPending(r1.pendingId, "Alice");
    expect(bob.get(id).password).toBe("s3cret-Pa55");
    expect(bob.get(id).received?.role).toBe("editor");
    await alice.recordGrant(id, Bi.handle, "editor");
    // Not for Eve; tampering breaks the signature.
    expect((await eve.receive(out.envelope)).status).toBe("rejected");
    expect(await bob.receive({ ...out.envelope, h: out.envelope.h.replace('"share"', '"update"') })).toMatchObject({ status: "rejected", reason: "bad-signature" });

    // Bob edits, Alice receives the update (fast-forward).
    await bob.put(id, { category: "login", title: "Prod DB", tags: ["db"], username: "admin", password: "rotated-1" });
    const [toAlice] = await bob.buildUpdates(id);
    expect(toAlice?.peerId).toBe(A.handle);
    expect(await alice.receive(toAlice!.envelope)).toMatchObject({ status: "updated" });
    expect(alice.get(id).password).toBe("rotated-1");
    // Replaying it is stale.
    expect(await alice.receive(toAlice!.envelope)).toMatchObject({ status: "stale" });

    // Concurrent edits → conflict, nothing overwritten.
    await alice.put(id, { category: "login", title: "Prod DB", tags: ["db"], username: "admin", password: "alice-version" });
    await bob.put(id, { category: "login", title: "Prod DB", tags: ["db"], username: "admin", password: "bob-version" });
    const [toBob] = await alice.buildUpdates(id);
    expect(await bob.receive(toBob!.envelope)).toMatchObject({ status: "conflict" });
    expect(bob.get(id).password).toBe("bob-version");
    const cs = await bob.conflicts(id);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.data.password).toBe("alice-version");
    expect(bob.list()[0]!.hasConflict).toBe(true);
    await bob.resolve(id, { keep: "remote", conflictId: cs[0]!.conflictId });
    expect(bob.get(id).password).toBe("alice-version");
    expect(bob.list()[0]!.hasConflict).toBe(false);
    // The resolution dominates both branches: Alice fast-forwards.
    const [back] = await bob.buildUpdates(id);
    expect(await alice.receive(back!.envelope)).toMatchObject({ status: "updated" });

    // Reader can't edit or reshare.
    const id2 = await alice.put(null, { category: "note", title: "Read me", tags: [], notes: "ro" });
    const ro = await alice.buildShare(id2, Bi.handle, "reader");
    expect(await bob.receive(ro.envelope)).toMatchObject({ status: "new" });
    await expect(bob.put(id2, { category: "note", title: "x", tags: [] })).rejects.toThrow("read-only");
    await bob.addPeer(eve.identity().card, "Eve");
    await expect(bob.buildShare(id2, eve.identity().handle, "reader")).rejects.toThrow("forbidden");
    expect(await bob.buildUpdates(id2)).toHaveLength(0);
  });

  it("shares a file (chunks verified) and purges expired shares", async () => {
    let now = Date.now();
    const mk = async () => {
      const r = new VaultRepo(mem(), mem, { ...FAST, now: () => now });
      await r.create({ password: "x-very-long-password-1234" });
      return r;
    };
    const alice = await mk();
    const bob = await mk();
    await alice.addPeer(bob.identity().card, "Bob");
    await bob.addPeer(alice.identity().card, "Alice");
    const bytes = randomBytes(2 * 1048576 + 7);
    const id = await alice.put(null, { category: "file", title: "dump.bin", tags: [] }, { name: "dump.bin", type: "", bytes });
    const out = await alice.buildShare(id, bob.identity().handle, "reader", now + 60_000);
    expect(out.envelope.chunks).toHaveLength(3);
    const bad = { ...out.envelope, chunks: out.envelope.chunks.map((c, i) => (i === 1 ? c.map((x, j) => (j === 0 ? x ^ 1 : x)) : c)) };
    expect(await bob.receive(bad)).toMatchObject({ status: "rejected", reason: "integrity" });
    expect(await bob.receive(out.envelope)).toMatchObject({ status: "new" });
    expect(hex((await bob.readFile(id)).bytes)).toBe(hex(bytes));
    now += 61_000;
    expect(bob.list()).toHaveLength(0);
  });

  it("reports weak and reused passwords", async () => {
    const { repo } = await newVault();
    await repo.put(null, { category: "login", title: "A", tags: [], password: "password" });
    await repo.put(null, { category: "login", title: "B", tags: [], password: "password" });
    await repo.put(null, { category: "login", title: "C", tags: [], password: "Xq7#mP2!vL9$wR4&zz" });
    const s = repo.security();
    expect(s.weak.map((w) => w.title).sort()).toEqual(["A", "B"]);
    expect(s.reused).toHaveLength(1);
    expect((await repo.passwordSha1(repo.list().find((i) => i.title === "A")!.id)).slice(0, 5)).toBe("5BAA6");
  });
});
