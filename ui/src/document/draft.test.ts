import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { LEGACY_KEY, clearDraft, extractImages, inlineImages, loadDraft, markDraftExported, saveDraft, draftGeneration } from "./draft";
import { idbKeys, idbWrite, resetIdbForTests } from "./idb";
import { META_KEY, activeDocState, isUnexported, readMeta } from "./activeDoc";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const GIF = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";

beforeEach(() => {
  resetIdbForTests();
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  localStorage.clear();
});

describe("image extraction", () => {
  it("moves data URLs out of the HTML and puts them back unchanged", () => {
    const html = `<p>a</p><img src="${PNG}" alt="x"><img src="${GIF}"><img src="${PNG}" alt="again">`;
    const { html: out, images } = extractImages(html);
    expect(out).not.toContain("base64");
    expect(out.match(/fny-blob:/g)).toHaveLength(3);
    expect(images.size).toBe(2); // the same picture twice is stored once
    expect(inlineImages(out, (k) => images.get(k))).toBe(html);
  });

  it("drops an image whose bytes are missing instead of leaving a broken reference", () => {
    const { html } = extractImages(`<p>t</p><img src="${PNG}" alt="x">`);
    expect(inlineImages(html, () => undefined)).toBe("<p>t</p>");
  });
});

describe("text draft in IndexedDB", () => {
  it("round-trips the document with its images, stored apart", async () => {
    const html = `<h1>Titre</h1><img src="${PNG}" alt="photo">`;
    const r = await saveDraft({ name: "Rapport", html });
    expect(r.ok).toBe(true);
    expect(await idbKeys("blobs")).toHaveLength(1);
    const d = await loadDraft();
    expect(d).toMatchObject({ name: "Rapport", html });
    expect(d?.exportedAt).toBeUndefined();
  });

  it("garbage-collects images removed from the document", async () => {
    await saveDraft({ name: "a", html: `<img src="${PNG}"><img src="${GIF}">` });
    expect(await idbKeys("blobs")).toHaveLength(2);
    await saveDraft({ name: "a", html: `<img src="${GIF}">` });
    expect(await idbKeys("blobs")).toHaveLength(1);
  });

  it("migrates the old localStorage draft once, then removes it", async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ name: "Ancien", html: "<p>vieux</p>", at: 1000 }));
    const d = await loadDraft();
    expect(d).toMatchObject({ name: "Ancien", html: "<p>vieux</p>", at: 1000 });
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(await loadDraft()).toMatchObject({ name: "Ancien" });
    // A legacy draft is a modification never exported: badge on.
    expect(isUnexported(readMeta())).toBe(true);
  });

  it("export mark: the badge goes away, the next edit brings it back", async () => {
    await saveDraft({ name: "n", html: "<p>1</p>" });
    expect(activeDocState().unexported).toBe(true);
    await markDraftExported("n");
    expect(activeDocState().unexported).toBe(false);
    expect(activeDocState().stored?.name).toBe("n");
    const d = await loadDraft();
    expect(d!.exportedAt! >= d!.at).toBe(true);
    await saveDraft({ name: "n", html: "<p>2</p>" });
    expect(activeDocState().unexported).toBe(true);
  });

  it("a save queued before the export mark lands first (no stale badge)", async () => {
    const save = saveDraft({ name: "n", html: "<p>last keystrokes</p>" });
    const mark = markDraftExported("n");
    await Promise.all([save, mark]);
    expect(activeDocState().unexported).toBe(false);
    expect((await loadDraft())?.html).toBe("<p>last keystrokes</p>");
  });

  it("close and forget removes everything; a save scheduled before it is ignored", async () => {
    await saveDraft({ name: "n", html: `<img src="${PNG}">` });
    const gen = draftGeneration();
    await clearDraft();
    expect(await saveDraft({ name: "n", html: "<p>late</p>" }, gen)).toEqual({ ok: false, reason: "stale" });
    expect(await loadDraft()).toBeNull();
    expect(await idbKeys("blobs")).toHaveLength(0);
    expect(localStorage.getItem(META_KEY)).toBeNull();
    expect(activeDocState().unexported).toBe(false);
  });

  it("reports a full quota instead of failing silently", async () => {
    const factory = (globalThis as { indexedDB: IDBFactory }).indexedDB;
    await saveDraft({ name: "n", html: "<p>ok</p>" });
    resetIdbForTests();
    const realOpen = factory.open.bind(factory);
    // Every write transaction aborts with QuotaExceededError.
    factory.open = ((name: string, v?: number) => {
      const r = realOpen(name, v);
      r.addEventListener("success", () => {
        const db = r.result;
        const realTx = db.transaction.bind(db);
        db.transaction = ((stores: string | string[], mode?: IDBTransactionMode) => {
          const t = realTx(stores, mode);
          if (mode === "readwrite") {
            const realStore = t.objectStore.bind(t);
            t.objectStore = ((n: string) => {
              const s = realStore(n);
              s.put = () => {
                throw new DOMException("full", "QuotaExceededError");
              };
              return s;
            }) as typeof t.objectStore;
          }
          return t;
        }) as typeof db.transaction;
      });
      return r;
    }) as typeof factory.open;
    expect(await saveDraft({ name: "n", html: "<p>too big</p>" })).toEqual({ ok: false, reason: "quota" });
    factory.open = realOpen as typeof factory.open;
  });

  it("works without IndexedDB (legacy draft still offered)", async () => {
    const g = globalThis as { indexedDB?: IDBFactory };
    const saved = g.indexedDB;
    delete g.indexedDB;
    try {
      localStorage.setItem(LEGACY_KEY, JSON.stringify({ name: "L", html: "<p>x</p>", at: 5 }));
      expect(await loadDraft()).toMatchObject({ name: "L" });
      expect(await saveDraft({ name: "L", html: "<p>y</p>" })).toEqual({ ok: false, reason: "unavailable" });
    } finally {
      g.indexedDB = saved;
    }
  });

  it("ignores a corrupt session image list", async () => {
    await idbWrite([{ store: "sessions", key: "active-text", value: { kind: "text", name: "c", html: "<p>c</p>", at: 1, images: [] } }]);
    expect(await loadDraft()).toMatchObject({ name: "c", html: "<p>c</p>" });
  });
});
