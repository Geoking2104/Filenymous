// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { buildDropLink, buildOwnerLink, createDrop, dropIdFor, isDropHash, isDropOwnerHash, isExpired, parseDropLink, parseOwnerLink } from "./link";
import { checkProof, deriveDropKey, dropBaseMaterial, parseDropControl, sealProof } from "./crypto";
import { openChunk, sealChunk } from "../protocol";

const BASE = "https://filenymous.eu/";

describe("dropzone links", () => {
  it("derives the dropId exactly like the relay (sha256(ownerSecret)[:24])", async () => {
    const s = "abcdefghijklmnopqrstuvwxyz012345";
    expect(await dropIdFor(s)).toBe(`drop-${createHash("sha256").update(s).digest("hex").slice(0, 24)}`);
  });

  it("round-trips contributor and owner links without leaking the owner secret", async () => {
    const p = await createDrop({ name: "Mon projet été", password: true, expiresAt: Date.now() + 3600_000 });
    const link = buildDropLink(BASE, p);
    expect(link).not.toContain(p.ownerSecret);
    expect(isDropHash(link.slice(link.indexOf("#")))).toBe(true);
    const parsed = parseDropLink(link)!;
    expect(parsed).toEqual({ dropId: p.dropId, secret: p.secret, expiresAt: p.expiresAt, password: true, name: "Mon projet été" });

    const owner = buildOwnerLink(BASE, p);
    expect(isDropOwnerHash(owner.slice(owner.indexOf("#")))).toBe(true);
    expect(await parseOwnerLink(owner)).toEqual(p);
  });

  it("rejects malformed links", async () => {
    expect(parseDropLink(`${BASE}#drop:drop-xyz/abc/0/n`)).toBeNull();
    expect(parseDropLink(`${BASE}#drop:drop-${"a".repeat(24)}/short/0/n`)).toBeNull();
    expect(parseDropLink(`${BASE}#drop:drop-${"a".repeat(24)}/${"s".repeat(22)}/0/x`)).toBeNull();
    expect(parseDropLink(`${BASE}#p2p:123-456-ABC`)).toBeNull();
    expect(await parseOwnerLink(`${BASE}#drop-owner:short/${"s".repeat(22)}/0/n`)).toBeNull();
  });

  it("enforces expiry client-side", () => {
    expect(isExpired({ expiresAt: 0 })).toBe(false);
    expect(isExpired({ expiresAt: Date.now() - 1 })).toBe(true);
    expect(isExpired({ expiresAt: Date.now() + 60_000 })).toBe(false);
  });
});

describe("dropzone handshake & keys", () => {
  it("accepts the right password and rejects a wrong one", async () => {
    const p = await createDrop({ password: true });
    const ownerKey = await deriveDropKey(p, await dropBaseMaterial(p, "s3cret"), "sid1");
    const goodKey = await deriveDropKey(p, await dropBaseMaterial(p, "s3cret"), "sid1");
    const badKey = await deriveDropKey(p, await dropBaseMaterial(p, "wrong"), "sid1");
    expect(await checkProof(ownerKey, await sealProof(goodKey, "hello:sid1"), "hello:sid1")).toBe(true);
    expect(await checkProof(ownerKey, await sealProof(badKey, "hello:sid1"), "hello:sid1")).toBe(false);
    expect(await checkProof(ownerKey, await sealProof(goodKey, "hello:other"), "hello:sid1")).toBe(false);
  });

  it("binds expiry and session id into the key (tampered link or replay fails)", async () => {
    const p = await createDrop({ expiresAt: Date.now() + 3600_000 });
    const base = await dropBaseMaterial(p);
    const k = await deriveDropKey(p, base, "sid");
    const tampered = await deriveDropKey({ ...p, expiresAt: p.expiresAt + 86_400_000 }, base, "sid");
    const otherSession = await deriveDropKey(p, base, "sid2");
    const frame = await sealChunk(k, 0, 0, new TextEncoder().encode("data"));
    expect(new TextDecoder().decode((await openChunk(k, frame)).plain)).toBe("data");
    await expect(openChunk(tampered, frame)).rejects.toBeTruthy();
    await expect(openChunk(otherSession, frame)).rejects.toBeTruthy();
  });
});

describe("dropzone control messages", () => {
  it("validates and sanitizes manifests", () => {
    const m = parseDropControl(JSON.stringify({ type: "drop-manifest", files: [{ name: "../../etc/passwd", size: 3, mime: "text/plain" }] }));
    expect(m).toEqual({ type: "drop-manifest", files: [{ name: "_.._etc_passwd", size: 3, mime: "text/plain" }] });
    expect(parseDropControl(JSON.stringify({ type: "drop-manifest", files: [] }))).toBeNull();
    expect(parseDropControl(JSON.stringify({ type: "drop-manifest", files: [{ name: "a", size: -1 }] }))).toBeNull();
  });

  it("rejects unknown or malformed messages", () => {
    expect(parseDropControl("not json")).toBeNull();
    expect(parseDropControl(JSON.stringify({ type: "drop-hello", v: 99, sid: "a", proof: "b" }))).toBeNull();
    expect(parseDropControl(JSON.stringify({ type: "drop-reject", reason: "whatever" }))).toBeNull();
    expect(parseDropControl(JSON.stringify({ type: "drop-receipt", files: 1, bytes: 10 }))).toEqual({ type: "drop-receipt", files: 1, bytes: 10 });
    expect(parseDropControl(JSON.stringify({ type: "evil" }))).toBeNull();
  });
});
