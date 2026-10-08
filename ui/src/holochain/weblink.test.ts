// @vitest-environment node
/**
 * Self-contained encrypted link tests (#sl / #slp formats).
 * Runs in the node environment: Node's File/Blob/WebCrypto are spec-compliant
 * (jsdom lacks File.arrayBuffer and SubtleCrypto). A minimal `window` stub
 * stands in for the browser origin used in the generated URL.
 */

import { describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import {
  createWebLink,
  decryptWebLinkBlob,
  isWebLinkFragment,
  parseWebLink,
  unlockWebLink,
} from "./webLink";

vi.stubGlobal("crypto", webcrypto);
vi.stubGlobal("window", { location: { origin: "http://localhost:3000", pathname: "/app/" } });

const PAYLOAD = Uint8Array.from({ length: 4096 }, (_, i) => i % 251);

function makeFile(): File {
  return new File([PAYLOAD], "hello.bin", { type: "application/octet-stream" });
}

async function blobBytes(blob: Blob): Promise<number[]> {
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

describe("self-contained web links (#sl/#slp)", () => {
  it("round-trips a plain link (no password)", async () => {
    const { url, passwordProtected } = await createWebLink(makeFile());
    expect(passwordProtected).toBe(false);
    const fragment = url.split("#")[1]!;
    expect(isWebLinkFragment(fragment)).toBe(true);
    expect(isWebLinkFragment(`#${fragment}`)).toBe(true);

    const parsed = await parseWebLink(fragment);
    expect(parsed).not.toBeNull();
    expect(parsed!.locked).toBe(false);
    expect(parsed!.name).toBe("hello.bin");
    expect(parsed!.size).toBe(PAYLOAD.length);

    const blob = await decryptWebLinkBlob(parsed!);
    expect(await blobBytes(blob)).toEqual(Array.from(PAYLOAD));
  });

  it("round-trips a password-protected link, rejecting wrong passwords", async () => {
    const { url, passwordProtected } = await createWebLink(makeFile(), { password: "hunter22!" });
    expect(passwordProtected).toBe(true);
    const fragment = url.split("#")[1]!;
    expect(fragment.startsWith("slp=")).toBe(true);

    const parsed = await parseWebLink(fragment);
    expect(parsed!.locked).toBe(true);
    await expect(decryptWebLinkBlob(parsed!)).rejects.toThrow("link_locked");
    await expect(unlockWebLink(parsed!, "wrong-password")).rejects.toThrow();

    await unlockWebLink(parsed!, "hunter22!");
    expect(parsed!.locked).toBe(false);
    const blob = await decryptWebLinkBlob(parsed!);
    expect(await blobBytes(blob)).toEqual(Array.from(PAYLOAD));
  }, 30000);

  it("rejects corrupted payloads (GCM auth)", async () => {
    const { url } = await createWebLink(makeFile());
    const fragment = url.split("#")[1]!;
    const parsed = await parseWebLink(fragment);
    parsed!.cipher[20] ^= 0xff;
    await expect(decryptWebLinkBlob(parsed!)).rejects.toThrow();
  });

  it("returns null for non-link fragments", async () => {
    expect(await parseWebLink("abc:def")).toBeNull();
    expect(await parseWebLink("sl=tooshort")).toBeNull();
    expect(isWebLinkFragment("abc:def")).toBe(false);
  });
});
