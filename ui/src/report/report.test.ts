// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  buildReportLink, decodePayload, deriveFollow, encodePayload, exportKeyFile, fingerprint, formatFollowKey, generateMailboxKeys,
  newFollowSecret, open, parseFollowKey, parseKeyFile, parseReportHash, seal, symDecrypt, symEncrypt, unlockKeyFile,
} from "./crypto";
import { stripJpeg, stripMetadata, stripPdf, stripPng, stripWebp } from "./metadata";

const fx = (n: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));
const txt = (b: Uint8Array) => Buffer.from(b).toString("latin1");
const enc = new TextEncoder();

describe("report crypto", () => {
  it("seals to the org public key; only the private key opens it, with the right context", async () => {
    const k = await generateMailboxKeys();
    expect(k.pub).toMatch(/^[A-Za-z0-9_-]{87}$/);
    const s = await seal(k.pub, enc.encode("fraude au service achats"), "report:mbox");
    expect(new TextDecoder().decode(await open(k.priv, k.pub, s, "report:mbox"))).toBe("fraude au service achats");
    await expect(open(k.priv, k.pub, s, "report:other")).rejects.toThrow();
    const other = await generateMailboxKeys();
    await expect(open(other.priv, k.pub, s, "report:mbox")).rejects.toThrow();
    const s2 = await seal(k.pub, enc.encode("fraude au service achats"), "report:mbox");
    expect(s2.epk).not.toBe(s.epk); // fresh ephemeral key each time
    expect(await fingerprint(k.pub)).toMatch(/^([0-9A-F]{4} ){7}[0-9A-F]{4}$/);
  });

  it("follow-up key: formatted, parsed back, derives a stable id/token/reply key", async () => {
    const f = newFollowSecret();
    const shown = formatFollowKey(f);
    expect(shown).toMatch(/^([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/);
    expect(parseFollowKey(shown.toLowerCase().replace(/-/g, " "))).toEqual(f);
    expect(parseFollowKey("ABCD")).toBeNull();
    const a = await deriveFollow(f), b = await deriveFollow(parseFollowKey(shown)!);
    expect(a).toEqual(b);
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a.auth).toBe(createHash("sha256").update(Buffer.from(a.token, "base64url")).digest("hex"));
    const m = await symEncrypt(a.reply, enc.encode("merci"), `reply:${a.id}`);
    expect(new TextDecoder().decode(await symDecrypt(b.reply, m, `reply:${a.id}`))).toBe("merci");
    const wrong = await deriveFollow(newFollowSecret());
    await expect(symDecrypt(wrong.reply, m, `reply:${a.id}`)).rejects.toThrow();
  });

  it("payload round-trips text and binary files", () => {
    const data = new Uint8Array([0, 1, 2, 255]);
    const p = decodePayload(encodePayload({ v: 1, text: "é ✓", reply: "r", files: [{ name: "a.bin", type: "x", size: 4, meta: { status: "unsupported", removed: [], remaining: ["all"] }, data }] }));
    expect(p.text).toBe("é ✓");
    expect(p.files[0].data).toEqual(data);
  });

  it("key file: passphrase-protected, wrong passphrase refused, bound to the mailbox", async () => {
    const k = await generateMailboxKeys();
    const file = await exportKeyFile("A".repeat(22), k, "phrase de passe longue");
    expect(JSON.stringify(file)).not.toContain(k.admin);
    const parsed = parseKeyFile(JSON.stringify(file))!;
    const u = await unlockKeyFile(parsed, "phrase de passe longue");
    expect(u.admin).toBe(k.admin);
    const s = await seal(k.pub, enc.encode("x"), "c");
    expect(await open(u.priv, k.pub, s, "c")).toEqual(enc.encode("x"));
    await expect(unlockKeyFile(parsed, "mauvaise")).rejects.toThrow("bad-passphrase");
    await expect(unlockKeyFile({ ...parsed, mailbox: "B".repeat(22) }, "phrase de passe longue")).rejects.toThrow("bad-passphrase");
    expect(parseKeyFile("{}")).toBeNull();
  });

  it("links carry the mailbox id and public key in the fragment", async () => {
    const k = await generateMailboxKeys();
    const link = buildReportLink("https://filenymous.eu/app/", "A".repeat(22), k.pub);
    expect(parseReportHash(new URL(link).hash)).toEqual({ mailbox: "A".repeat(22), pub: k.pub });
    expect(parseReportHash("#report:short/xx")).toBeNull();
  });
});

describe("metadata stripping", () => {
  it("JPEG fixture: EXIF with GPS, camera serial and artist removed; image data intact", () => {
    const src = fx("exif-gps.jpg");
    expect(txt(src)).toContain("Exif");
    expect(txt(src)).toContain("Jean Dupont");
    const { data, meta } = stripJpeg(src);
    expect(meta.status).toBe("cleaned");
    expect(meta.removed).toEqual(expect.arrayContaining(["EXIF", "GPS"]));
    for (const s of ["Exif", "Jean Dupont", "SERIAL", "FujiCam"]) expect(txt(data)).not.toContain(s);
    const sos = (b: Uint8Array) => txt(b).slice(txt(b).indexOf("\xff\xda"));
    expect(sos(data)).toBe(sos(src)); // scan data untouched
    expect(data[0]).toBe(0xff);
    expect(stripJpeg(data).meta.status).toBe("nothing-found");
  });

  it("PDF fixture: Info dictionary and XMP blanked in place (same size, xref valid)", () => {
    const src = fx("author.pdf");
    expect(txt(src)).toContain("Jean Dupont");
    const { data, meta } = stripPdf(src);
    expect(data.length).toBe(src.length);
    expect(meta.removed).toEqual(expect.arrayContaining(["Author", "Creator", "Producer", "Title", "CreationDate", "XMP"]));
    for (const s of ["Jean Dupont", "Word for Jean", "4A65616E", "D:2026", "dc:creator"]) expect(txt(data)).not.toContain(s);
    expect(txt(data)).toContain("(Rapport interne)"); // visible content untouched
    expect(meta.status).toBe("cleaned");
    expect(meta.remaining).toEqual(["content"]);
    const s = txt(data);
    const xref = Number(s.match(/startxref\n(\d+)/)![1]);
    expect(s.slice(xref, xref + 4)).toBe("xref");
    const off7 = Number(s.slice(xref).split("\n")[9].slice(0, 10));
    expect(s.slice(off7, off7 + 7)).toBe("7 0 obj");
  });

  it("PDF with compressed metadata / object streams is reported as partial", () => {
    const pdf = enc.encode("%PDF-1.7\n1 0 obj << /Type /ObjStm /N 3 >> endobj 2 0 obj << /Type /Metadata /Subtype /XML /Filter /FlateDecode >> endobj");
    const { meta } = stripPdf(pdf);
    expect(meta.status).toBe("partial");
    expect(meta.remaining).toEqual(expect.arrayContaining(["xmp-compressed", "objstm"]));
  });

  it("PNG text chunks and WebP EXIF/XMP removed; unknown types flagged", () => {
    const png = stripPng(fx("text.png"));
    expect(png.meta.removed).toContain("tEXt");
    expect(txt(png.data)).not.toContain("Jean Dupont");
    expect(txt(png.data)).toContain("IEND");
    const chunk = (t: string, body: string) => { const b = enc.encode(body + (body.length & 1 ? "\0" : "")); const h = new Uint8Array(8); h.set(enc.encode(t)); new DataView(h.buffer).setUint32(4, body.length, true); return [...h, ...b]; };
    const vp8x = chunk("VP8X", "\x0c\0\0\0\0\0\0\0\0\0");
    const body = [...vp8x, ...chunk("VP8L", "abc"), ...chunk("EXIF", "GPS Jean"), ...chunk("XMP ", "<x:xmpmeta/>")];
    const head = [...enc.encode("RIFF"), 0, 0, 0, 0, ...enc.encode("WEBP")];
    const webp = stripWebp(new Uint8Array([...head, ...body]));
    expect(webp.meta.removed).toEqual(["EXIF", "XMP"]);
    expect(txt(webp.data)).not.toContain("Jean");
    expect(webp.data[20] & 0x0c).toBe(0);
    expect(new DataView(webp.data.buffer).getUint32(4, true)).toBe(webp.data.length - 8);
    expect(stripMetadata(enc.encode("PK\x03\x04 docx")).meta.status).toBe("unsupported");
    expect(stripMetadata(fx("exif-gps.jpg")).meta.status).toBe("cleaned");
  });
});
