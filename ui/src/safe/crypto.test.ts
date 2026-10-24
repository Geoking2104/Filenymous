// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  B, SecureBuffer, aesOpen, aesSeal, b64u, chunkLeaf, decodeCard, decryptChunks, deriveKekBytes, encodeCard, encryptChunks, entropyToPhrase,
  fromB64u, handleFor, importAesKey, inboxIdFor, inboxSecret, isPhraseValid, keyFromBytes, merkleRoot, newIdentity, newKdfParams,
  newRecoveryEntropy, phraseToEntropy, pickCheckPositions, publicKeys, randomBytes, recoveryKey, shareIv, shareKeyFromSender,
  shareKeyToRecipient, sign, unwrapDek, verify, wrapDek, enc, hex,
} from "./crypto";
import { compareClocks, mergeClocks, tick } from "./clock";
import { estimateBits, strengthLevel } from "./strength";
import { finalScore, normaliseBm25, rankResults } from "./rank";

describe("safe crypto", () => {
  it("wraps and unwraps the DEK with an Argon2id KEK, and rejects a wrong password", async () => {
    const kdf = newKdfParams({ t: 1, m: 1024, p: 1 });
    const dek = randomBytes(32);
    const kek = await keyFromBytes(await deriveKekBytes("correct horse battery staple", kdf));
    const blob = await wrapDek(kek, dek, "password");
    const kek2 = await keyFromBytes(await deriveKekBytes("correct horse battery staple", kdf));
    expect(hex(await unwrapDek(kek2, blob, "password"))).toBe(hex(dek));
    const bad = await keyFromBytes(await deriveKekBytes("wrong", kdf));
    await expect(unwrapDek(bad, blob, "password")).rejects.toBeTruthy();
    // The slot name is bound as AAD: a password-wrapped blob can't be replayed as another slot.
    await expect(unwrapDek(kek2, blob, "recovery")).rejects.toBeTruthy();
  });

  it("uses the spec Argon2id parameters by default", () => {
    const k = newKdfParams();
    expect([k.alg, k.t, k.m, k.p, fromB64u(k.salt).length]).toEqual(["argon2id", 3, 65536, 4, 16]);
  });

  it("round-trips a 24-word phrase from 256-bit entropy and recovers the DEK with it", async () => {
    const e = newRecoveryEntropy();
    const phrase = entropyToPhrase(e);
    expect(phrase.split(" ")).toHaveLength(24);
    expect(isPhraseValid(phrase)).toBe(true);
    expect(hex(phraseToEntropy(`  ${phrase.toUpperCase()}  `))).toBe(hex(e));
    const dek = randomBytes(32);
    const blob = await wrapDek(await recoveryKey(e), dek, "recovery");
    expect(hex(await unwrapDek(await recoveryKey(phraseToEntropy(phrase)), blob, "recovery"))).toBe(hex(dek));
    const words = phrase.split(" ");
    [words[0], words[1]] = [words[1]!, words[0]!];
    expect(isPhraseValid(words.join(" "))).toBe(words[0] === words[1]);
    expect(() => phraseToEntropy("abandon abandon")).toThrow();
  });

  it("picks 3 distinct check positions", () => {
    for (let i = 0; i < 50; i++) {
      const p = pickCheckPositions();
      expect(new Set(p).size).toBe(3);
      expect(p.every((x) => x >= 0 && x < 24)).toBe(true);
    }
  });

  it("encrypts files in 1 MiB chunks with per-chunk IVs and a Merkle root that detects tampering", async () => {
    const key = await importAesKey(randomBytes(32));
    const data = randomBytes(2.5 * 1048576);
    const chunks = await encryptChunks(key, data, "file:x");
    expect(chunks).toHaveLength(3);
    expect(new Set(chunks.map((c) => b64u(c.iv))).size).toBe(3);
    const root = hex(await merkleRoot(await Promise.all(chunks.map(chunkLeaf))));
    expect(hex(await decryptChunks(key, chunks, "file:x"))).toBe(hex(data));
    chunks[1]!.ct[5]! ^= 1;
    expect(hex(await merkleRoot(await Promise.all(chunks.map(chunkLeaf))))).not.toBe(root);
    await expect(decryptChunks(key, chunks, "file:x")).rejects.toBeTruthy();
    // Reordering chunks is caught by the index-bound AAD.
    const c2 = await encryptChunks(key, data, "file:y");
    [c2[0]!.idx, c2[1]!.idx] = [1, 0];
    await expect(decryptChunks(key, c2, "file:y")).rejects.toBeTruthy();
  });

  it("wraps a share key to the recipient's X25519 key (HPKE-style) and signs with Ed25519", async () => {
    const bob = newIdentity();
    const bobPub = publicKeys(bob);
    const { eph, key } = await shareKeyToRecipient(bobPub.x);
    const s = await aesSeal(key, enc.encode("hello bob"), undefined, shareIv(0));
    const bobKey = await shareKeyFromSender(bob, eph);
    expect(new TextDecoder().decode(await aesOpen(bobKey, s))).toBe("hello bob");
    const eve = newIdentity();
    await expect(aesOpen(await shareKeyFromSender(eve, eph), s)).rejects.toBeTruthy();
    const alice = newIdentity();
    const msg = enc.encode("header");
    const sig = sign(alice, msg);
    expect(verify(publicKeys(alice).ed, msg, sig)).toBe(true);
    expect(verify(publicKeys(eve).ed, msg, sig)).toBe(false);
    expect(verify(publicKeys(alice).ed, enc.encode("headeR"), sig)).toBe(false);
  });

  it("encodes contact cards and short handles", async () => {
    const id = newIdentity();
    const pub = publicKeys(id);
    const inbox = await inboxIdFor(await inboxSecret(id));
    expect(inbox).toMatch(/^wall-[a-f0-9]{24}$/);
    const card = encodeCard({ ...pub, inbox });
    const back = decodeCard(card)!;
    expect(hex(back.ed)).toBe(hex(pub.ed));
    expect(back.inbox).toBe(inbox);
    expect(await handleFor(pub.ed, pub.x)).toMatch(/^fny-[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    expect(decodeCard("fny1.nope")).toBeNull();
  });

  it("wipes buffers (best effort)", async () => {
    const b = randomBytes(64);
    SecureBuffer.wipe(b);
    expect(b.every((x) => x === 0)).toBe(true);
    const c = randomBytes(8);
    await SecureBuffer.useAndDestroy(c, (x) => B(x));
    expect(c.every((x) => x === 0)).toBe(true);
  });
});

describe("vector clocks", () => {
  it("orders and merges", () => {
    const a = tick({}, "alice");
    const b = tick(a, "bob");
    expect(compareClocks(a, b)).toBe("before");
    expect(compareClocks(b, a)).toBe("after");
    const a2 = tick(a, "alice");
    expect(compareClocks(a2, b)).toBe("concurrent");
    expect(mergeClocks(a2, b)).toEqual({ alice: 2, bob: 1 });
    expect(compareClocks(a, { ...a })).toBe("equal");
  });
});

describe("strength & ranking", () => {
  it("rates passwords", () => {
    expect(strengthLevel(estimateBits("password"))).toBe(0);
    expect(strengthLevel(estimateBits("aaaaaaaaaaaa"))).toBeLessThanOrEqual(1);
    expect(strengthLevel(estimateBits("cheval-agrafe-orbite-tulipe-nuage"))).toBeGreaterThanOrEqual(3);
    expect(strengthLevel(estimateBits("Xq7#mP2!vL9$wR4&"))).toBeGreaterThanOrEqual(3);
  });

  it("combines 0.4·FTS + 0.6·cosine + recency", () => {
    const now = Date.now();
    expect(finalScore({ id: "a", fts: 1, cosine: 1, updatedAt: now }, now)).toBeCloseTo(1.1);
    expect(finalScore({ id: "a", fts: 0, cosine: 0.5, updatedAt: now - 3650 * 86_400_000 }, now)).toBeCloseTo(0.3);
    const n = normaliseBm25(new Map([["x", -4], ["y", -2]]));
    expect(n.get("x")).toBe(1);
    expect(n.get("y")).toBe(0.5);
    const r = rankResults([
      { id: "lex", fts: 1, cosine: 0.1, updatedAt: now },
      { id: "sem", fts: 0, cosine: 0.9, updatedAt: now },
      { id: "none", fts: 0, cosine: 0.1, updatedAt: now },
    ], now);
    expect(r.map((x) => x.id)).toEqual(["sem", "lex"]);
  });
});
