// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { MAX_SECRET_BYTES, buildSecretLink, isSecretHash, openSecret, parseSecretLink, revealToken, sealSecret } from "./crypto";
import { b64urlDecode } from "../p2p/protocol";

describe("vault crypto", () => {
  it("round-trips without password; server auth = sha256(token)", async () => {
    const s = await sealSecret("ghp_secret-token\nligne 2 é");
    expect(s.body.pw).toBe(false);
    expect(s.body.salt).toBeUndefined();
    expect(s.body.ct).not.toContain("ghp");
    const { token, encKey } = await revealToken(s.key);
    expect(createHash("sha256").update(b64urlDecode(token)).digest("hex")).toBe(s.body.auth);
    expect(await openSecret(encKey, s.body.ct, s.body.iv)).toBe("ghp_secret-token\nligne 2 é");
  });

  it("with password: a wrong password yields a different token and cannot decrypt", async () => {
    const s = await sealSecret("top", "correct horse");
    expect(s.body.pw).toBe(true);
    expect(s.body.salt).toHaveLength(22);
    const good = await revealToken(s.key, "correct horse", s.body.salt);
    const bad = await revealToken(s.key, "wrong", s.body.salt);
    expect(createHash("sha256").update(b64urlDecode(good.token)).digest("hex")).toBe(s.body.auth);
    expect(bad.token).not.toBe(good.token);
    expect(await openSecret(good.encKey, s.body.ct, s.body.iv)).toBe("top");
    await expect(openSecret(bad.encKey, s.body.ct, s.body.iv)).rejects.toBeTruthy();
  });

  it("uses a fresh key and IV each time", async () => {
    const [a, b] = await Promise.all([sealSecret("same"), sealSecret("same")]);
    expect(a.key).not.toBe(b.key);
    expect(a.body.iv).not.toBe(b.body.iv);
    expect(a.body.ct).not.toBe(b.body.ct);
  });

  it("enforces size limits", async () => {
    await expect(sealSecret("")).rejects.toThrow("empty");
    await expect(sealSecret("x".repeat(MAX_SECRET_BYTES + 1))).rejects.toThrow("too-large");
    const max = await sealSecret("x".repeat(MAX_SECRET_BYTES));
    expect(max.body.ct.length).toBeLessThanOrEqual(90_000); // relay's VAULT_MAX_CT_CHARS
  });
});

describe("vault links", () => {
  it("keeps the key in the fragment only", async () => {
    const s = await sealSecret("x");
    const id = "A".repeat(22);
    const link = buildSecretLink("https://filenymous.eu/?a=1#old", id, s.key);
    expect(link.split("#")[0]).toBe("https://filenymous.eu/?a=1");
    expect(parseSecretLink(link)).toEqual({ id, key: s.key });
    expect(isSecretHash(link.slice(link.indexOf("#")))).toBe(true);
    expect(parseSecretLink(`#s:${id}`)).toEqual({ id });
    expect(parseSecretLink("#s:short/key")).toBeNull();
  });
});
