/**
 * Scoped wall search for agents (protocol feature 4).
 *
 * An agent sends `{t:"search", rid, q, k}`; the host tab ranks the entries
 * that agent is allowed to search and answers with at most k short snippets.
 * Ranking runs in the host tab: keyword scoring always, and semantic scoring
 * when the host enabled the local embedding model (see embedder.ts).
 * Returned snippets still reach the agent — and its model provider.
 */

export const SEARCH_Q_MAX = 200;
export const SEARCH_K_MAX = 8;
export const SEARCH_K_DEFAULT = 5;
export const SNIPPET_MAX = 280;

export type SearchKind = "msg" | "file" | "poll" | "note" | "task" | "decision" | "caption";
export type SearchMode = "semantic" | "keyword";

export interface SearchDoc {
  id: string;
  kind: SearchKind;
  by: string;
  at: number;
  /** Full text used for ranking (never sent as is). */
  text: string;
}

export interface SearchHit {
  id: string;
  kind: SearchKind;
  by: string;
  at: number;
  snippet: string;
  score: number;
}

export type SearchRequest = { t: "search"; rid: number; q: string; k?: number };
export type SearchResponse = { t: "search-res"; rid: number; mode: SearchMode; hits: SearchHit[] } | { t: "search-fail"; rid: number; reason: "denied" | "rate-limited" | "bad-query" };

const KINDS = new Set<SearchKind>(["msg", "file", "poll", "note", "task", "decision", "caption"]);
const int = (v: unknown, min = 0) => Number.isInteger(v) && (v as number) >= min && (v as number) <= Number.MAX_SAFE_INTEGER;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Case- and accent-insensitive form (no length cap, unlike the UI search box). */
const normalizeQuery = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ");
const LABEL_RE = /^(host|peer:\d{1,6})$/;

export function parseSearchMessage(o: Record<string, unknown>): SearchRequest | SearchResponse | null {
  switch (o.t) {
    case "search": {
      if (!int(o.rid, 1) || typeof o.q !== "string") return null;
      const q = o.q.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, SEARCH_Q_MAX);
      if (!q) return null;
      const k = o.k === undefined ? undefined : int(o.k, 1) && (o.k as number) <= SEARCH_K_MAX ? (o.k as number) : null;
      if (k === null) return null;
      return { t: "search", rid: o.rid as number, q, ...(k ? { k } : {}) };
    }
    case "search-res": {
      if (!int(o.rid, 1) || (o.mode !== "semantic" && o.mode !== "keyword") || !Array.isArray(o.hits) || o.hits.length > SEARCH_K_MAX) return null;
      const hits: SearchHit[] = [];
      for (const h of o.hits as Record<string, unknown>[]) {
        if (!h || typeof h !== "object" || typeof h.id !== "string" || !ID_RE.test(h.id) || !KINDS.has(h.kind as SearchKind)) return null;
        if (typeof h.by !== "string" || !LABEL_RE.test(h.by) || !int(h.at) || typeof h.snippet !== "string" || h.snippet.length > SNIPPET_MAX + 2) return null;
        if (typeof h.score !== "number" || !Number.isFinite(h.score)) return null;
        hits.push({ id: h.id, kind: h.kind as SearchKind, by: h.by, at: h.at as number, snippet: h.snippet, score: Math.round(h.score * 1000) / 1000 });
      }
      return { t: "search-res", rid: o.rid as number, mode: o.mode, hits };
    }
    case "search-fail":
      return int(o.rid, 1) && (o.reason === "denied" || o.reason === "rate-limited" || o.reason === "bad-query") ? { t: "search-fail", rid: o.rid as number, reason: o.reason } : null;
    default:
      return null;
  }
}

const tokens = (s: string) => normalizeQuery(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);

/** Keyword ranking: fraction of query terms found (prefix match), plus a phrase bonus. */
export function keywordScores(q: string, docs: readonly SearchDoc[]): number[] {
  const qt = [...new Set(tokens(q))];
  const phrase = normalizeQuery(q).trim();
  return docs.map((d) => {
    if (!qt.length) return 0;
    const norm = normalizeQuery(d.text);
    const dt = tokens(d.text);
    let hit = 0;
    for (const w of qt) if (dt.some((x) => x.startsWith(w))) hit++;
    return hit / qt.length + (phrase.length > 2 && norm.includes(phrase) ? 0.5 : 0);
  });
}

/** A short excerpt centred on the first query term found. */
export function snippetOf(text: string, q: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= SNIPPET_MAX) return flat;
  const norm = normalizeQuery(flat);
  let at = -1;
  for (const w of tokens(q)) {
    at = norm.indexOf(w);
    if (at >= 0) break;
  }
  const start = Math.max(0, Math.min(flat.length - SNIPPET_MAX, at < 0 ? 0 : at - 80));
  return (start > 0 ? "…" : "") + flat.slice(start, start + SNIPPET_MAX).trim() + (start + SNIPPET_MAX < flat.length ? "…" : "");
}

/** Turns per-document scores into the top-k hits (scores ≤ min are dropped). */
export function topHits(q: string, docs: readonly SearchDoc[], scores: readonly number[], k: number, min: number): SearchHit[] {
  return docs
    .map((d, i) => ({ d, s: scores[i] ?? 0 }))
    .filter((x) => x.s > min)
    .sort((a, b) => b.s - a.s || b.d.at - a.d.at)
    .slice(0, Math.min(Math.max(1, k), SEARCH_K_MAX))
    .map(({ d, s }) => ({ id: d.id, kind: d.kind, by: d.by, at: d.at, snippet: snippetOf(d.text, q), score: Math.round(s * 1000) / 1000 }));
}

/** Pluggable semantic ranker (the browser host's local embedding model). */
export interface SemanticRanker {
  /** Cosine similarities of q with each doc text, or null when unavailable. */
  scores(q: string, docs: readonly SearchDoc[]): Promise<number[] | null>;
}

/** Semantic similarity below this is not a match. */
export const SEMANTIC_MIN = 0.25;

/**
 * Ranks docs for q: semantic (blended with keyword hits) when a ranker
 * answers, keyword otherwise.
 */
export async function rankDocs(q: string, docs: readonly SearchDoc[], k: number, ranker?: SemanticRanker | null): Promise<{ mode: SearchMode; hits: SearchHit[] }> {
  const kw = keywordScores(q, docs);
  const sem = ranker && docs.length ? await ranker.scores(q, docs).catch(() => null) : null;
  if (sem && sem.length === docs.length) {
    const blended = sem.map((s, i) => { const w = kw[i] ?? 0; return s >= SEMANTIC_MIN || w > 0 ? s + 0.15 * Math.min(1, w) : 0; });
    return { mode: "semantic", hits: topHits(q, docs, blended, k, 0) };
  }
  return { mode: "keyword", hits: topHits(q, docs, kw, k, 0) };
}
