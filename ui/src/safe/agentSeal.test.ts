import { describe, expect, it } from "vitest";
import { x25519 } from "@noble/curves/ed25519";
import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync } from "node:crypto";
import {
  AGENT_SEAL_ALG,
  agentPubKeyFromEd25519,
  b64u,
  decodeEnrollment,
  decodeTokenFile,
  encodeEnrollment,
  encodeTokenFile,
  enrollmentFingerprint,
  fromB64u,
  openAgentBundle,
  sealAgentBundle,
  type X25519Impl,
} from "./agentSeal";

const noble: X25519Impl = {
  randomSecretKey: () => x25519.utils.randomPrivateKey(),
  getPublicKey: (s) => x25519.getPublicKey(s),
  getSharedSecret: (s, p) => x25519.getSharedSecret(s, p),
};

// Same adapter shape as cli/src/vault.ts (node:crypto), to prove interop.
const nodeX: X25519Impl = {
  randomSecretKey: () => {
    const jwk = generateKeyPairSync("x25519").privateKey.export({ format: "jwk" });
    return fromB64u(jwk.d!);
  },
  getPublicKey: (s) => {
    const k = createPrivateKey({ key: { kty: "OKP", crv: "X25519", d: b64u(s), x: b64u(x25519.getPublicKey(s)) }, format: "jwk" });
    return fromB64u(createPublicKey(k).export({ format: "jwk" }).x!);
  },
  getSharedSecret: (s, p) =>
    new Uint8Array(
      diffieHellman({
        privateKey: createPrivateKey({ key: { kty: "OKP", crv: "X25519", d: b64u(s), x: b64u(x25519.getPublicKey(s)) }, format: "jwk" }),
        publicKey: createPublicKey({ key: { kty: "OKP", crv: "X25519", x: b64u(p) }, format: "jwk" }),
      }),
    ),
};

describe("agent bundle sealing", () => {
  const env = { GITHUB_TOKEN: "ghp_secret", OPENAI_API_KEY: "sk-test" };

  it("round-trips browser → node runner", async () => {
    const agentSecret = nodeX.randomSecretKey();
    const agentX = nodeX.getPublicKey(agentSecret);
    const sealed = await sealAgentBundle(noble, agentX, env, { tokenId: "tok_1234567890abcdef", version: 1 });
    expect(sealed.alg).toBe(AGENT_SEAL_ALG);
    expect(sealed.nonce.length).toBe(12);
    expect(sealed.eph_pub.length).toBe(32);
    expect(new TextDecoder().decode(sealed.ciphertext)).not.toContain("ghp_secret");
    expect(await openAgentBundle(nodeX, agentSecret, sealed, { tokenId: "tok_1234567890abcdef", version: 1 })).toEqual(env);
  });

  it("binds token id and version (AAD)", async () => {
    const s = noble.randomSecretKey();
    const sealed = await sealAgentBundle(noble, noble.getPublicKey(s), env, { tokenId: "tok_aaaaaaaaaaaaaaaa", version: 1 });
    await expect(openAgentBundle(noble, s, sealed, { tokenId: "tok_bbbbbbbbbbbbbbbb", version: 1 })).rejects.toBeTruthy();
    await expect(openAgentBundle(noble, s, sealed, { tokenId: "tok_aaaaaaaaaaaaaaaa", version: 2 })).rejects.toBeTruthy();
    const other = noble.randomSecretKey();
    await expect(openAgentBundle(noble, other, sealed, { tokenId: "tok_aaaaaaaaaaaaaaaa", version: 1 })).rejects.toBeTruthy();
    sealed.ciphertext[0] ^= 1;
    await expect(openAgentBundle(noble, s, sealed, { tokenId: "tok_aaaaaaaaaaaaaaaa", version: 1 })).rejects.toBeTruthy();
  });

  it("rejects bad env names and empty bundles", async () => {
    const pub = noble.getPublicKey(noble.randomSecretKey());
    await expect(sealAgentBundle(noble, pub, { "bad-name": "x" }, { tokenId: "t", version: 1 })).rejects.toThrow(/bad-env-name/);
    await expect(sealAgentBundle(noble, pub, {}, { tokenId: "t", version: 1 })).rejects.toThrow(/empty/);
  });
});

describe("enrollment and token file", () => {
  it("round-trips and fingerprints", async () => {
    const e = { ed: new Uint8Array(32).fill(1), x: new Uint8Array(32).fill(2), label: "claude-ci" };
    const back = decodeEnrollment(encodeEnrollment(e));
    expect(back).toEqual(e);
    expect(await enrollmentFingerprint(e)).toMatch(/^fny-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
    expect(() => decodeEnrollment("nope")).toThrow();
    const key = agentPubKeyFromEd25519(e.ed);
    expect(Array.from(key.slice(0, 3))).toEqual([132, 32, 36]);
    expect(key.length).toBe(39);
  });

  it("token file", () => {
    const t = { v: 1 as const, appUrl: "ws://127.0.0.1:8888", installedAppId: "filenymous", cellId: ["a", "b"] as [string, string], tokenId: "tok", capSecret: "c", expiresAt: 1, label: "x" };
    expect(decodeTokenFile(encodeTokenFile(t))).toEqual(t);
    expect(() => decodeTokenFile("fny-agent-token:v1:e30")).toThrow();
  });
});
