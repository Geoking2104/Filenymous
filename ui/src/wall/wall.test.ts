// @vitest-environment node
import { describe, expect, it } from "vitest";
import fr from "../i18n/locales/fr.json";
import en from "../i18n/locales/en.json";
import { serviceRoute } from "../home/routes";
import {
  WALL_TTLS,
  buildHostLink,
  buildWallLink,
  createWall,
  flagsOf,
  isExpired,
  isWallHash,
  isWallHostHash,
  parseHostLink,
  parseWallLink,
  wallCode,
  wallIdFor,
} from "./link";
import { SealedPipe, checkProof, deriveWallKeys, parseHandshake, sealProof, wallBaseMaterial } from "./crypto";
import {
  MAX_ITEMS,
  MAX_ITEM_BYTES,
  MAX_TEXT_BYTES,
  MAX_WALL_BYTES,
  WallStore,
  admitItem,
  formatRemaining,
  parseWallMessage,
  previewKind,
  remainingMs,
} from "./model";
import { wallJoinMessage, wallSignalUrl } from "./signal";

const BASE = "https://filenymous.eu/app/";
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

describe("Sharewall links", () => {
  it("round-trips host and peer links; the peer link never carries the host secret", async () => {
    const p = await createWall({ ttl: "h1", password: true, burn: true, hostLeave: true, now: NOW });
    expect(p.wallId).toBe(await wallIdFor(p.hostSecret));
    expect(p.expiresAt).toBe(NOW + WALL_TTLS.h1);
    const peer = buildWallLink(BASE, p);
    const host = buildHostLink(BASE, p);
    expect(peer).toMatch(/^https:\/\/filenymous\.eu\/app\/#wall:wall-[a-f0-9]{24}\/[A-Za-z0-9_-]{43}\/[0-9a-z]+\/p1h$/);
    expect(peer).not.toContain(p.hostSecret);
    expect(host.startsWith(`${BASE}#wall-host:${p.hostSecret}/`)).toBe(true);
    const parsed = parseWallLink(peer)!;
    expect(parsed).toEqual({ wallId: p.wallId, key: p.key, expiresAt: p.expiresAt, password: true, burn: true, hostLeave: true });
    expect(await parseHostLink(host)).toEqual(p);
    // Works with only the fragment, and with an URL-encoded paste.
    expect(parseWallLink(peer.slice(peer.indexOf("#")))).toEqual(parsed);
    expect(parseWallLink(encodeURI(peer).replace("#", "%23").replace("%23", "#"))).toEqual(parsed);
  });

  it("encodes the options as flags", async () => {
    expect(flagsOf({ password: false, burn: false, hostLeave: false })).toBe("n");
    expect(flagsOf({ password: true, burn: false, hostLeave: true })).toBe("ph");
    const p = await createWall({ ttl: "m15", now: NOW });
    expect(buildWallLink(BASE, p).endsWith("/n")).toBe(true);
    expect(p.expiresAt - NOW).toBe(15 * 60_000);
    expect((await createWall({ ttl: "h24", now: NOW })).expiresAt - NOW).toBe(24 * 3600_000);
  });

  it("rejects malformed or tampered links", async () => {
    const p = await createWall({ ttl: "h1", now: NOW });
    const ok = buildWallLink(BASE, p);
    const bad = [
      ok.replace("#wall:wall-", "#wall:wall_"),
      ok.replace(/\/n$/, "/x"),
      ok.replace(/\/n$/, "/n/extra"),
      ok.replace(/\/n$/, ""),
      ok.replace(p.key, p.key.slice(1)),
      ok.replace(p.wallId, p.wallId.slice(0, -1)),
      `${BASE}#drop:${p.wallId}/${p.key}/0/n`,
      "",
      "#wall:",
    ];
    for (const b of bad) expect(parseWallLink(b)).toBeNull();
    expect(await parseHostLink(`${BASE}#wall-host:short/${p.key}/abc/n`)).toBeNull();
    expect(await parseHostLink(ok)).toBeNull();
  });

  it("routes #wall-new, #wall-host:… and #wall:… inside the app", async () => {
    const p = await createWall({ ttl: "h1", now: NOW });
    const peerHash = buildWallLink(BASE, p).slice(BASE.length);
    const hostHash = buildHostLink(BASE, p).slice(BASE.length);
    expect(isWallHash(peerHash)).toBe(true);
    expect(isWallHostHash(hostHash)).toBe(true);
    expect(isWallHostHash("#wall-new")).toBe(true);
    expect(isWallHostHash("#wall-newer")).toBe(false);
    expect(serviceRoute("#wall-new")).toBe("wall-host");
    expect(serviceRoute(hostHash)).toBe("wall-host");
    expect(serviceRoute(peerHash)).toBe("wall-peer");
  });

  it("derives the same wall code for everyone, different for another key", async () => {
    const p = await createWall({ ttl: "h1", now: NOW });
    const code = await wallCode(p);
    expect(code).toMatch(/^[A-HJ-NP-TV-Z2-9]{4}-[A-HJ-NP-TV-Z2-9]{4}$/);
    expect(await wallCode(parseWallLink(buildWallLink(BASE, p))!)).toBe(code);
    expect(await wallCode({ ...p, key: (await createWall({ ttl: "h1" })).key })).not.toBe(code);
  });

  it("knows when a wall is expired", () => {
    expect(isExpired({ expiresAt: NOW }, NOW - 1)).toBe(false);
    expect(isExpired({ expiresAt: NOW }, NOW)).toBe(true);
    expect(remainingMs(NOW, NOW + 5)).toBe(0);
    expect(formatRemaining(15 * 60_000)).toBe("15:00");
    expect(formatRemaining(3600_000 + 61_000)).toBe("1:01:01");
    expect(formatRemaining(400)).toBe("00:01");
  });
});

describe("Sharewall crypto", () => {
  it("the handshake proves the key (and password) without revealing it", async () => {
    const p = await createWall({ ttl: "h1", password: true, now: NOW });
    const host = await deriveWallKeys(p, await wallBaseMaterial(p, "s3cret"), "sid-1");
    const good = await deriveWallKeys(p, await wallBaseMaterial(p, "s3cret"), "sid-1");
    const wrong = await deriveWallKeys(p, await wallBaseMaterial(p, "nope"), "sid-1");
    const proof = await sealProof(good.proof, "hello:sid-1");
    expect(await checkProof(host.proof, proof, "hello:sid-1")).toBe(true);
    expect(await checkProof(host.proof, await sealProof(wrong.proof, "hello:sid-1"), "hello:sid-1")).toBe(false);
    // A proof can't be replayed for another session/label.
    expect(await checkProof(host.proof, proof, "hello:sid-2")).toBe(false);
    expect(proof).not.toContain(p.key);
  });

  it("binds expiry and flags into the keys (editing the link breaks the handshake)", async () => {
    const p = await createWall({ ttl: "h1", now: NOW });
    const base = await wallBaseMaterial(p);
    const k = await deriveWallKeys(p, base, "s");
    for (const forged of [{ ...p, expiresAt: p.expiresAt + 3600_000 }, { ...p, burn: true }, { ...p, hostLeave: true }]) {
      const f = await deriveWallKeys(forged, base, "s");
      expect(await checkProof(k.proof, await sealProof(f.proof, "hello:s"), "hello:s")).toBe(false);
    }
  });

  it("seals control and data frames in both directions with separate keys", async () => {
    const p = await createWall({ ttl: "h1", now: NOW });
    const keys = await deriveWallKeys(p, await wallBaseMaterial(p), "sid");
    const peer = new SealedPipe(keys.up, keys.down);
    const host = new SealedPipe(keys.down, keys.up);
    const f1 = await peer.sealControl({ t: "put", uid: 1, kind: "text", name: "", size: 5, mime: "text/plain" });
    const f2 = await peer.sealData(1, new TextEncoder().encode("hello"));
    expect(new TextDecoder().decode(new Uint8Array(f2))).not.toContain("hello");
    expect(await host.open(f1)).toMatchObject({ stream: 0, control: { t: "put", uid: 1 } });
    const d = await host.open(f2);
    expect(new TextDecoder().decode(d.bytes)).toBe("hello");
    // A frame sealed for one direction can't be opened as the other direction.
    const back = await host.sealControl({ t: "bye" });
    await expect(host.open(back)).rejects.toThrow();
    expect(await peer.open(back)).toMatchObject({ control: { t: "bye" } });
  });

  it("rejects replayed, reordered or tampered frames", async () => {
    const p = await createWall({ ttl: "h1", now: NOW });
    const keys = await deriveWallKeys(p, await wallBaseMaterial(p), "sid");
    const a = new SealedPipe(keys.up, keys.down);
    const b = new SealedPipe(keys.down, keys.up);
    const f0 = await a.sealData(3, new Uint8Array([1]));
    const f1 = await a.sealData(3, new Uint8Array([2]));
    await expect(b.open(f1)).rejects.toThrow("out-of-order");
    const c = new SealedPipe(keys.down, keys.up);
    await c.open(f0);
    await expect(c.open(f0)).rejects.toThrow();
    const tampered = new Uint8Array(f1.slice(0));
    tampered[tampered.length - 1] ^= 1;
    await expect(c.open(tampered.buffer)).rejects.toThrow();
    expect(() => a.sealData(0, new Uint8Array(1))).toThrow("bad-stream");
    // Another session id gives other keys.
    const other = await deriveWallKeys(p, await wallBaseMaterial(p), "sid-other");
    await expect(new SealedPipe(other.down, other.up).open(await a.sealControl({ t: "bye" }))).rejects.toThrow();
  });

  it("parses only well-formed plain handshake messages", () => {
    expect(parseHandshake(JSON.stringify({ type: "wall-hello", v: 2, sid: "x", proof: "y" }))).toBeTruthy();
    expect(parseHandshake(JSON.stringify({ type: "wall-hello", v: 1, sid: "x", proof: "y" }))).toBeNull();
    expect(parseHandshake(JSON.stringify({ type: "wall-reject", reason: "bad-password" }))).toBeTruthy();
    expect(parseHandshake(JSON.stringify({ type: "wall-reject", reason: "boom" }))).toBeNull();
    expect(parseHandshake("not json")).toBeNull();
  });
});

describe("Sharewall store, burn and destroy", () => {
  const blob = (s: string) => new Blob([s]);

  it("burns an item on its first download by someone else, never for its author", () => {
    const s = new WallStore(true);
    const a = s.add({ kind: "file", name: "a.txt", mime: "text/plain", by: "peer:1", owner: "P1", data: blob("aaa") });
    expect(s.take(a.id, "P1")).toMatchObject({ burned: false });
    expect(s.list()).toHaveLength(1);
    const got = s.take(a.id, "P2")!;
    expect(got.burned).toBe(true);
    expect(got.data.size).toBe(3);
    expect(s.list()).toHaveLength(0);
    expect(s.take(a.id, "P3")).toBeNull();
  });

  it("keeps items without burn and wipes everything on destroy", () => {
    const s = new WallStore(false);
    const a = s.add({ kind: "text", name: "", mime: "text/plain", by: "host", owner: "host", data: blob("secret") });
    expect(a.name).toBe("note");
    expect(s.take(a.id, "P1")!.burned).toBe(false);
    expect(s.take(a.id, "P2")).not.toBeNull();
    s.add({ kind: "file", name: "../../etc/passwd", mime: "", by: "peer:1", owner: "P1", data: blob("x") });
    expect(s.list()[1]!.name).not.toContain("/");
    expect(s.used).toBe(7);
    s.wipe();
    expect(s.size).toBe(0);
    expect(s.used).toBe(0);
  });

  it("enforces the limits", () => {
    expect(admitItem("file", MAX_ITEM_BYTES + 1, 0, 0)).toBe("item-too-large");
    expect(admitItem("text", MAX_TEXT_BYTES + 1, 0, 0)).toBe("text-too-large");
    expect(admitItem("text", 0, 0, 0)).toBe("text-too-large");
    expect(admitItem("file", 10, MAX_WALL_BYTES - 5, 0)).toBe("wall-full");
    expect(admitItem("file", 10, 0, MAX_ITEMS)).toBe("too-many-items");
    expect(admitItem("file", MAX_ITEM_BYTES, 0, 0)).toBeNull();
  });

  it("previews only safe kinds; PDF and HTML documents are never rendered", () => {
    expect(previewKind({ kind: "file", name: "a.png", mime: "image/png" })).toBe("image");
    expect(previewKind({ kind: "file", name: "a.svg", mime: "image/svg+xml" })).toBe("image");
    expect(previewKind({ kind: "file", name: "a.mp4", mime: "video/mp4" })).toBe("video");
    expect(previewKind({ kind: "file", name: "a.mp3", mime: "audio/mpeg" })).toBe("audio");
    expect(previewKind({ kind: "file", name: ".env", mime: "" })).toBe("text");
    expect(previewKind({ kind: "file", name: "page.html", mime: "text/html" })).toBe("text");
    expect(previewKind({ kind: "file", name: "doc.pdf", mime: "application/pdf" })).toBeNull();
    expect(previewKind({ kind: "file", name: "a.bin", mime: "application/octet-stream" })).toBeNull();
    expect(previewKind({ kind: "text", name: "note", mime: "text/plain" })).toBe("text");
  });

  it("validates decrypted control messages", () => {
    expect(parseWallMessage({ t: "destroy", reason: "destroyed" })).toEqual({ t: "destroy", reason: "destroyed" });
    expect(parseWallMessage({ t: "destroy", reason: "whatever" })).toBeNull();
    expect(parseWallMessage({ t: "get", rid: 0, id: "x" })).toBeNull();
    expect(parseWallMessage({ t: "put", uid: 1, kind: "exe", name: "a", size: 1, mime: "" })).toBeNull();
    const bad = { id: "BAD ID", kind: "file", name: "a", size: 1, mime: "", by: "host", at: 1 };
    expect(parseWallMessage({ t: "post", post: { id: "BAD ID", kind: "file", by: "host", at: 1, item: bad, reactions: {} } })).toBeNull();
    const item = { id: "i1-abc", kind: "file", name: "a\u0000/b.txt", size: 1, mime: "text/plain", by: "peer:2", at: 1 };
    const st = parseWallMessage({ t: "post", post: { id: "i1-abc", kind: "file", by: "peer:2", at: 1, item, reactions: {} } });
    expect(st && st.t === "post" && st.post.item!.name).not.toMatch(/[\u0000/]/);
    expect(parseWallMessage({ t: "nope" })).toBeNull();
    expect(parseWallMessage(null)).toBeNull();
  });
});

describe("Sharewall signaling", () => {
  it("uses the dedicated /wall path (not logged by nginx)", () => {
    expect(wallSignalUrl("wss://www.opendpe.net/filenymous-signal/")).toBe("wss://www.opendpe.net/filenymous-signal/wall");
    expect(wallSignalUrl("ws://127.0.0.1:8789")).toBe("ws://127.0.0.1:8789/wall");
  });

  it("never sends the key, the password or any content to the relay", async () => {
    const p = await createWall({ ttl: "h1", password: true, burn: true, hostLeave: true, now: NOW });
    const host = wallJoinMessage({ wallId: p.wallId, role: "host", hostSecret: p.hostSecret, expiresAt: p.expiresAt, destroyOnHostLeave: true });
    const peer = wallJoinMessage({ wallId: p.wallId, role: "peer", peerId: "abcdefabcdefabcd" });
    expect(Object.keys(host).sort()).toEqual(["destroyOnHostLeave", "expiresAt", "hostSecret", "role", "type", "wallId"]);
    expect(Object.keys(peer).sort()).toEqual(["peerId", "role", "type", "wallId"]);
    for (const m of [host, peer]) expect(JSON.stringify(m)).not.toContain(p.key);
    expect(JSON.stringify(peer)).not.toContain(p.hostSecret);
  });
});

describe("Sharewall privacy wording", () => {
  const all = (loc: Record<string, any>) => JSON.stringify({ wall: loc.wall, card: loc.home.wall }).toLowerCase();

  it("makes no absolute anonymity or no-IP claim", () => {
    for (const loc of [fr, en] as Array<Record<string, any>>) {
      const w = all(loc);
      for (const banned of ["anonymat absolu", "absolute anonymity", "totalement anonyme", "fully anonymous", "aucune ip", "aucune adresse ip", "no ip", "zero log", "zéro log", "certifi", "iso 27001", "intraçable", "untraceable"]) {
        expect(w, banned).not.toContain(banned);
      }
    }
  });

  it("says that peers see IP addresses, recommends a VPN (Tor disables WebRTC) and points to the reporting channel", () => {
    const f = all(fr);
    const e = all(en);
    expect(f).toContain("ce n'est pas de l'anonymat");
    expect(f).toContain("adresse ip");
    expect(f).toContain("vpn");
    expect(f).toContain("tor browser désactive webrtc");
    expect(f).toContain("canal de signalement");
    expect(e).toContain("this is not anonymity");
    expect(e).toContain("ip address");
    expect(e).toContain("vpn");
    expect(e).toContain("tor browser disables webrtc");
    expect(e).toContain("whistleblowing channel");
  });

  it("has a card with 3 short benefits in FR and EN", () => {
    for (const loc of [fr, en] as Array<Record<string, any>>) {
      const c = loc.home.wall as Record<string, string>;
      expect(c.title && c.lead && c.cta).toBeTruthy();
      for (const k of ["b1", "b2", "b3"]) {
        expect(c[k]!.length).toBeLessThanOrEqual(32);
        expect(c[`${k}d`]).toBeTruthy();
      }
    }
  });
});
