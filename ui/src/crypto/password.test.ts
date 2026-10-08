// @vitest-environment node
/**
 * Password-based key wrapping tests (Argon2id + AES-256-GCM).
 */

import { describe, expect, it } from "vitest";
import { toArrayBuffer } from "./buffer";
import {
  deriveKek,
  randomBytes,
  unwrapKeyWithPassword,
  wrapKeyWithPassword,
} from "./password";

describe("password key wrapping (Argon2id)", () => {
  it("wraps and unwraps a 32-byte key round-trip", async () => {
    const raw = randomBytes(32);
    const { salt, wrapped } = await wrapKeyWithPassword("correct horse battery", raw);
    expect(salt.length).toBe(16);
    expect(wrapped.length).toBeGreaterThan(32); // nonce + tag overhead
    const out = await unwrapKeyWithPassword("correct horse battery", salt, wrapped);
    expect(Array.from(out)).toEqual(Array.from(raw));
  }, 30000);

  it("produces a different wrapped blob per call (random salt + nonce)", async () => {
    const raw = randomBytes(32);
    const a = await wrapKeyWithPassword("pw12345678", raw);
    const b = await wrapKeyWithPassword("pw12345678", raw);
    expect(Array.from(a.salt)).not.toEqual(Array.from(b.salt));
    expect(Array.from(a.wrapped)).not.toEqual(Array.from(b.wrapped));
  }, 30000);

  it("rejects a wrong password", async () => {
    const raw = randomBytes(32);
    const { salt, wrapped } = await wrapKeyWithPassword("right-password", raw);
    await expect(unwrapKeyWithPassword("wrong-password", salt, wrapped)).rejects.toThrow();
  }, 30000);

  it("derives a stable KEK for the same salt (cross-decrypt proof)", async () => {
    const salt = randomBytes(16);
    const k1 = await deriveKek("same-password", salt);
    const k2 = await deriveKek("same-password", salt);
    const iv = randomBytes(12);
    const msg = new TextEncoder().encode("hello filenymous");
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      k1,
      toArrayBuffer(msg),
    );
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      k2,
      ct,
    );
    expect(new TextDecoder().decode(pt)).toBe("hello filenymous");
  }, 30000);
});
