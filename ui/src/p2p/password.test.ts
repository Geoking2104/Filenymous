// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildShareLink,
  createSecret,
  deriveFileKey,
  derivePasswordKeys,
  openChunk,
  parseControl,
  passwordProof,
  randomB64,
  sealChunk,
  verifyPasswordProof,
} from "./protocol";

const ITER = 100_000;

describe("p2p password gate", () => {
  it("accepts the right password and rejects a wrong one", async () => {
    const salt = randomB64();
    const nonce = randomB64();
    const sender = await derivePasswordKeys("correct horse", salt, ITER);
    const good = await derivePasswordKeys("correct horse", salt, ITER);
    const bad = await derivePasswordKeys("wrong", salt, ITER);
    expect(await verifyPasswordProof(sender, "123-456-ABC", nonce, await passwordProof(good, "123-456-ABC", nonce))).toBe(true);
    expect(await verifyPasswordProof(sender, "123-456-ABC", nonce, await passwordProof(bad, "123-456-ABC", nonce))).toBe(false);
    // Proof is bound to the nonce and the code.
    expect(await verifyPasswordProof(sender, "123-456-ABC", randomB64(), await passwordProof(good, "123-456-ABC", nonce))).toBe(false);
    expect(await verifyPasswordProof(sender, "999-456-ABC", nonce, await passwordProof(good, "123-456-ABC", nonce))).toBe(false);
    expect(await verifyPasswordProof(sender, "123-456-ABC", nonce, "garbage!!")).toBe(false);
  }, 60_000);

  it("mixes the password into the file key: the link secret alone can't decrypt", async () => {
    const secret = createSecret();
    const { mix } = await derivePasswordKeys("pw", randomB64(), ITER);
    const withPw = await deriveFileKey(secret, mix);
    const linkOnly = await deriveFileKey(secret);
    const frame = await sealChunk(withPw, 0, 0, new TextEncoder().encode("hello"));
    expect(new TextDecoder().decode((await openChunk(withPw, frame)).plain)).toBe("hello");
    await expect(openChunk(linkOnly, frame)).rejects.toBeTruthy();
    const { mix: wrongMix } = await derivePasswordKeys("pW", randomB64(), ITER);
    await expect(openChunk(await deriveFileKey(secret, wrongMix), frame)).rejects.toBeTruthy();
  }, 60_000);

  it("validates the locked manifest challenge", () => {
    const base = { type: "manifest", v: 3, chunkSize: 65536, files: [{ name: "locked", size: 0, mime: "" }], wrappedSecret: "" };
    expect(parseControl(JSON.stringify({ ...base, auth: { salt: "a", nonce: "b", iter: 310000 } }))).not.toBeNull();
    expect(parseControl(JSON.stringify({ ...base, auth: { salt: "a", nonce: "b", iter: 10 } }))).toBeNull();
    expect(parseControl(JSON.stringify({ ...base, auth: { salt: 1, nonce: "b", iter: 310000 } }))).toBeNull();
  });

  it("never puts a password in the share link", () => {
    expect(buildShareLink("https://x/app/", "123-456-ABC", "s3cr3t")).toBe("https://x/app/#p2p:123-456-ABC/s3cr3t");
  });
});
