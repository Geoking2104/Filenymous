import { describe, expect, it } from "vitest";
import { parseSearchMessage, rankDocs, snippetOf, type SearchDoc } from "./wallsearch";

const docs: SearchDoc[] = [
  { id: "a", kind: "msg", by: "x", at: 1, text: "Le déploiement OVH est prêt" },
  { id: "b", kind: "msg", by: "y", at: 2, text: "Lunch at noon?" },
];

describe("wallsearch", () => {
  it("parses strictly", () => {
    expect(parseSearchMessage({ t: "search", rid: 1, q: "ovh" })).toBeTruthy();
    expect(parseSearchMessage({ t: "search", rid: 1, q: "" })).toBeNull();
    expect((parseSearchMessage({ t: "search", rid: 1, q: "x".repeat(500) }) as { q: string }).q.length).toBe(200);
    expect(parseSearchMessage({ t: "search", rid: 1, q: "a", k: 99 })).toBeNull();
  });
  it("keyword ranks accent-insensitively", async () => {
    const r = await rankDocs("deploiement", docs, 5);
    expect(r.mode).toBe("keyword");
    expect(r.hits.map((h) => h.id)).toEqual(["a"]);
  });
  it("falls back to keyword when the ranker throws", async () => {
    const r = await rankDocs("lunch", docs, 5, { scores: async () => { throw new Error("x"); } });
    expect(r.mode).toBe("keyword");
    expect(r.hits[0].id).toBe("b");
  });
  it("caps snippets", () => {
    expect(snippetOf("y".repeat(1000), "y").length).toBeLessThanOrEqual(281);
  });
});
