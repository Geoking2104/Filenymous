import { describe, expect, it } from "vitest";
import { FetchTargetError, fetchAsFile, fileNameFor, originPattern, targetOrigin } from "../src/fetchTarget";
import { formatBytes, formatRemaining, statusLabel } from "../src/labels";
import type { ShareSummary } from "../src/messages";

describe("fileNameFor", () => {
  it("prefers Content-Disposition, then the URL path, then a generic French name", () => {
    expect(fileNameFor("https://x.test/dl?id=1", "application/pdf", `attachment; filename*=UTF-8''devis%20%C3%A9t%C3%A9.pdf`)).toBe("devis été.pdf");
    expect(fileNameFor("https://x.test/dl", "application/zip", 'attachment; filename="build.zip"')).toBe("build.zip");
    expect(fileNameFor("https://cdn.test/img/photo%20de%20vacances.jpg?w=200", "image/jpeg")).toBe("photo de vacances.jpg");
    expect(fileNameFor("https://cdn.test/img/abc123", "image/webp", null, "image")).toBe("abc123.webp");
    expect(fileNameFor("data:image/png;base64,AAAA", "image/png", null, "image")).toBe("image.png");
    expect(fileNameFor("https://x.test/", "", null, "link")).toBe("fichier");
    expect(fileNameFor("https://x.test/a", "", 'attachment; filename="../../etc/passwd"')).toBe("_.._etc_passwd") // no path separator survives;
  });
  it("derives the permission pattern from the host only", () => {
    expect(targetOrigin("https://cdn.example.com:8443/a.png")).toBe("https://cdn.example.com");
    expect(originPattern("https://cdn.example.com")).toBe("https://cdn.example.com/*");
    expect(targetOrigin("blob:https://x/1")).toBeNull();
  });
});

describe("fetchAsFile", () => {
  const ok = (body: string, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers });
  it("fetches without cookies first and names the file", async () => {
    const calls: RequestInit[] = [];
    const f = await fetchAsFile("https://cdn.test/cat.png", "image", (async (_u: string, init: RequestInit) => (calls.push(init), ok("PNG", { "content-type": "image/png" }))) as never);
    expect(f.name).toBe("cat.png");
    expect(f.type).toBe("image/png");
    expect(f.size).toBe(3);
    expect(calls[0]).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
  });
  it("retries with the session on 401/403", async () => {
    const seen: string[] = [];
    const f = await fetchAsFile("https://intranet.test/report.pdf", "link", (async (_u: string, init: RequestInit) => {
      seen.push(String(init.credentials));
      return init.credentials === "omit" ? new Response("", { status: 403 }) : ok("%PDF", { "content-type": "application/pdf" });
    }) as never);
    expect(seen).toEqual(["omit", "include"]);
    expect(f.name).toBe("report.pdf");
  });
  it("reports blocked (CORS / no permission) with the origin, unsupported schemes and limits", async () => {
    await expect(fetchAsFile("https://cdn.test/x.png", "image", (async () => { throw new TypeError("Failed to fetch"); }) as never)).rejects.toMatchObject({ code: "blocked", origin: "https://cdn.test" });
    await expect(fetchAsFile("blob:https://x.test/1", "image")).rejects.toBeInstanceOf(FetchTargetError);
    await expect(fetchAsFile("file:///etc/hosts", "link")).rejects.toMatchObject({ code: "unsupported" });
    await expect(fetchAsFile("https://x.test/big", "link", (async () => ok("x", { "content-length": String(2 * 1024 ** 3) })) as never)).rejects.toMatchObject({ code: "too-large" });
    await expect(fetchAsFile("https://x.test/404", "link", (async () => new Response("", { status: 404 })) as never)).rejects.toMatchObject({ code: "http", status: 404 });
  });
  it("accepts data: URLs", async () => {
    const f = await fetchAsFile("data:image/gif;base64,R0lGODlhAQABAAAAACw=", "image");
    expect(f.name).toBe("image.gif");
    expect(f.size).toBeGreaterThan(0);
  });
});

describe("French labels", () => {
  const base: ShareSummary = { id: "p", kind: "p2p", link: "", names: ["a"], totalBytes: 200, confirmedBytes: 50, status: "transferring", downloads: 0, maxDownloads: 1, expiresAt: 0, createdAt: 0, protected: false, ended: false };
  it("formats sizes, durations and statuses", () => {
    expect(formatBytes(1536)).toBe("1,5 Ko");
    expect(formatBytes(12)).toBe("12 o");
    expect(formatRemaining(59 * 60_000)).toBe("59 min");
    expect(formatRemaining(90 * 60_000)).toBe("1 h 30 min");
    expect(statusLabel(base)).toBe("Envoi en cours : 25 %");
    expect(statusLabel({ ...base, status: "waiting" })).toBe("En attente du destinataire");
    expect(statusLabel({ ...base, status: "complete" })).toMatch(/^Terminé/);
    expect(statusLabel({ ...base, status: "error", error: "signal-unreachable" })).toMatch(/relais Filenymous injoignable/);
    expect(statusLabel({ ...base, kind: "secret", status: "secret", once: true })).toBe("Lien secret créé · lecture unique");
  });
});
