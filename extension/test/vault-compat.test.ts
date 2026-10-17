/**
 * The extension seals secrets with the web app's own code, posts them to the
 * real relay vault module, and the web app's reveal path decrypts them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
// @ts-expect-error plain JS module from the relay
import { createVault, MemoryStore } from "../../p2p-signal/vault.js";
import { ShareHost } from "../src/host";
import { getSecretMeta, revealSecret } from "../../ui/src/vault/api";
import { openSecret, parseSecretLink, revealToken } from "../../ui/src/vault/crypto";
import type { BgEvent } from "../src/messages";

let server: Server;
const events: BgEvent[] = [];
const copied: string[] = [];
let host: ShareHost;

beforeAll(async () => {
  const vault = createVault({ store: new MemoryStore(), clientIp: () => "127.0.0.1" });
  server = createServer((req, res) => {
    const path = (req.url || "/").split("?")[0]!;
    void vault.handle(req, res, path, { "content-type": "application/json" }).then((handled: boolean) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  (globalThis as Record<string, unknown>).__FILENYMOUS_VAULT_URL__ = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  host = new ShareHost((e) => events.push(e), () => undefined, async (t) => (copied.push(t), true));
});
afterAll(() => {
  server?.close();
});

async function readAsWebApp(link: string, password?: string) {
  const parsed = parseSecretLink(link)!;
  const meta = await getSecretMeta(parsed.id);
  const { token, encKey } = await revealToken(parsed.key!, meta.pw ? password : undefined, meta.salt);
  const data = await revealSecret(parsed.id, token);
  return { text: await openSecret(encKey, data.ct, data.iv), burned: data.burned, meta };
}

describe("selected text → one-time secret", () => {
  it("builds a filenymous.eu/app link with the key in the fragment, copies it, and the web app decrypts it", async () => {
    const text = "DB_PASSWORD=hunter2\nAPI_KEY=sk-test-é😀";
    const r = await host.shareText(text, { mode: "once" }, "menu");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.link).toMatch(/^https:\/\/filenymous\.eu\/app\/#s:[A-Za-z0-9_-]{22}\/[A-Za-z0-9_-]{43}$/);
    expect(copied.at(-1)).toBe(r.link);
    expect(events.find((e) => e.type === "notify")).toMatchObject({ title: "Lien secret copié" });
    const read = await readAsWebApp(r.link!);
    expect(read.meta.reads).toBe(1);
    expect(read.text).toBe(text);
    expect(read.burned).toBe(true);
    await expect(getSecretMeta(parseSecretLink(r.link!)!.id)).rejects.toMatchObject({ code: "gone" });
  });

  it("supports a password and a time-limited mode", async () => {
    const r = await host.shareText("s3cr3t", { mode: "ttl", hours: 2, password: "bonne" }, "popup");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const first = await readAsWebApp(r.link!, "bonne");
    expect(first.text).toBe("s3cr3t");
    expect(first.burned).toBe(false);
    expect(first.meta.pw).toBe(true);
    expect(first.meta.expiresAt - Date.now()).toBeGreaterThan(1.9 * 3600_000);
    await expect(readAsWebApp(r.link!, "mauvaise")).rejects.toBeTruthy();
  });

  it("refuses empty or oversized text with French messages", async () => {
    const empty = await host.shareText("   ", { mode: "once" }, "popup");
    expect(empty).toMatchObject({ ok: false, message: "Aucun texte sélectionné." });
    const big = await host.shareText("x".repeat(64 * 1024 + 1), { mode: "once" }, "popup");
    expect(big).toMatchObject({ ok: false, error: "too-large" });
  });
});
