// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildShareLink, createSecret, deriveFileKey, openChunk, parseControl, parseShareInput, sealChunk, shareFragment } from "./protocol";
import { expiryFromChoice, formatRemaining, remainingParts } from "./expiry";

describe("expiring links", () => {
  const secret = "A".repeat(22);
  it("carries the expiry as a base36 segment, ignored by old parsers", () => {
    const exp = 1_800_000_000;
    const link = buildShareLink("https://filenymous.eu/app/", "123-456-ABC", secret, exp);
    expect(link).toBe(`https://filenymous.eu/app/#p2p:123-456-ABC/${secret}/e${exp.toString(36)}`);
    expect(parseShareInput(link)).toEqual({ code: "123-456-ABC", secret, expires: exp });
    expect(shareFragment({ code: "123-456-ABC", secret, expires: exp })).toBe(link.split("#")[1]);
    // Old 2-segment parsing (what v2 receivers do) still finds code + secret.
    const [, s] = link.split("#")[1]!.slice(4).split("/");
    expect(s).toBe(secret);
    expect(parseShareInput(`#p2p:123-456-ABC/${secret}`)).toEqual({ code: "123-456-ABC", secret });
    expect(parseShareInput(`#p2p:123-456-ABC/${secret}/x!!`)).toEqual({ code: "123-456-ABC", secret });
  });
  it("binds the expiry into the AES key: an edited expiry can't decrypt", async () => {
    const sec = createSecret();
    const sealed = await sealChunk(await deriveFileKey(sec, undefined, 1_800_000_000), 0, 0, new Uint8Array([1, 2, 3]));
    await expect(openChunk(await deriveFileKey(sec, undefined, 1_800_000_000), sealed)).resolves.toMatchObject({ chunkIndex: 0 });
    await expect(openChunk(await deriveFileKey(sec, undefined, 1_800_003_600), sealed)).rejects.toThrow();
    await expect(openChunk(await deriveFileKey(sec), sealed)).rejects.toThrow();
  });
  it("validates manifest expiry", () => {
    const base = { type: "manifest", chunkSize: 65536, files: [{ name: "a", size: 1, mime: "" }], wrappedSecret: "x.y" };
    expect(parseControl(JSON.stringify({ ...base, v: 4, expires: 1_800_000_000 }))).toMatchObject({ v: 4, expires: 1_800_000_000 });
    expect(parseControl(JSON.stringify({ ...base, v: 4, expires: "soon" }))).toBeNull();
    expect(parseControl(JSON.stringify({ ...base, v: 4, expires: -1 }))).toBeNull();
  });
});

describe("expiry choices and countdown", () => {
  const now = Date.UTC(2026, 9, 16, 12, 0, 0);
  it("maps presets and custom dates", () => {
    expect(expiryFromChoice("none", "", now)).toBeUndefined();
    expect(expiryFromChoice("1h", "", now)).toBe(now / 1000 + 3600);
    expect(expiryFromChoice("24h", "", now)).toBe(now / 1000 + 86400);
    expect(expiryFromChoice("7d", "", now)).toBe(now / 1000 + 7 * 86400);
    expect(expiryFromChoice("custom", "2026-10-18T12:00:00Z", now)).toBe(now / 1000 + 2 * 86400);
    expect(expiryFromChoice("custom", "2026-10-16T11:00:00Z", now)).toBeUndefined(); // past
    expect(expiryFromChoice("custom", "2027-01-01T00:00:00Z", now)).toBeUndefined(); // > 30 days
    expect(expiryFromChoice("custom", "not a date", now)).toBeUndefined();
  });
  it("formats the remaining time", () => {
    expect(remainingParts(90_061_000)).toEqual({ d: 1, h: 1, m: 1, s: 1 });
    expect(formatRemaining(90_061_000, "fr")).toBe("1 j 1 h");
    expect(formatRemaining(90_061_000, "en")).toBe("1 d 1 h");
    expect(formatRemaining(3_900_000)).toBe("1 h 05 min");
    expect(formatRemaining(129_000)).toBe("2 min 09 s");
    expect(formatRemaining(9_000)).toBe("9 s");
    expect(formatRemaining(-5)).toBe("0 s");
  });
});
