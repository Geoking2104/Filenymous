/** P2P shares: same link format as the web app/CLI, expiry bound in the link, CLI-like lifecycle. */
import { describe, expect, it, vi } from "vitest";
import { parseShareInput } from "../../ui/src/p2p/protocol";

type Cb = (s: Record<string, unknown>) => void;
const senders: Array<{ cb: Cb; opts: Record<string, unknown>; stopped: boolean }> = [];
vi.mock("../../ui/src/p2p/session", () => ({
  P2PSender: class {
    code = "123-456-ABC";
    secret = "S3cretS3cretS3cretS3cr";
    stopped = false;
    constructor(_files: File[], cb: Cb, opts: Record<string, unknown>) {
      senders.push(Object.assign(this, { cb, opts }) as never);
    }
    async start() {}
    stop() {
      this.stopped = true;
    }
  },
}));

const { ShareHost } = await import("../src/host");

describe("file share", () => {
  it("copies a #p2p: link the web app parses, with the expiry segment", async () => {
    const copied: string[] = [];
    const notes: string[] = [];
    const host = new ShareHost((e) => e.type === "notify" && notes.push(e.title), () => undefined, async (t) => (copied.push(t), true));
    const before = Math.floor(Date.now() / 1000);
    const r = await host.shareFiles([new File(["hello"], "a.txt")], { ttlMinutes: 60, maxDownloads: 1, password: "pw" }, "popup");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.link).toMatch(/^https:\/\/filenymous\.eu\/app\/#p2p:123-456-ABC\/S3cretS3cretS3cretS3cr\/e[0-9a-z]+$/);
    expect(copied).toEqual([r.link]);
    const parsed = parseShareInput(r.link!)!;
    expect(parsed.code).toBe("123-456-ABC");
    expect(parsed.secret).toBe("S3cretS3cretS3cretS3cr");
    expect(parsed.expires! - before).toBeGreaterThanOrEqual(3599);
    expect(parsed.expires! - before).toBeLessThanOrEqual(3601);
    const s = senders.at(-1)!;
    expect(s.opts).toMatchObject({ password: "pw", expires: parsed.expires });
    expect(host.list()[0]).toMatchObject({ status: "starting", protected: true, ended: false });

    // Recipient downloads: notification, then the share ends (max 1 download) like the CLI.
    vi.useFakeTimers();
    s.cb({ status: "complete", downloads: 1, confirmedBytes: 5, totalBytes: 5 });
    expect(notes).toContain("Téléchargement terminé");
    vi.advanceTimersByTime(2000);
    vi.useRealTimers();
    expect(s.stopped).toBe(true);
    expect(host.list()[0]).toMatchObject({ status: "complete", ended: true, downloads: 1 });
  });

  it("keeps serving while downloads < max, ends on expiry and locks after wrong passwords", async () => {
    const host = new ShareHost(() => undefined, () => undefined, async () => true);
    await host.shareFiles([new File(["x"], "b.bin")], { ttlMinutes: 15, maxDownloads: 1000 }, "popup");
    const s = senders.at(-1)!;
    s.cb({ status: "complete", downloads: 1 });
    expect(host.list()[0]).toMatchObject({ status: "delivered", ended: false });
    s.cb({ status: "expired", downloads: 1 });
    expect(host.list()[0]).toMatchObject({ status: "expired", ended: true });

    await host.shareFiles([new File(["x"], "c.bin")], { ttlMinutes: 15, maxDownloads: 1 }, "popup");
    const t = senders.at(-1)!;
    t.cb({ status: "failed", error: "too-many-attempts", downloads: 0 });
    expect(t.stopped).toBe(true);
    expect(host.list()[0]).toMatchObject({ status: "locked", ended: true });
  });
});
