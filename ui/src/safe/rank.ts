/** Hybrid ranking: FinalScore = 0.4·FTS + 0.6·cosine + recency bonus. */
export interface RankInput {
  id: string;
  fts: number; // 0..1 (normalised BM25), 0 when no lexical hit
  cosine: number | null; // -1..1, null when semantic search is off/unavailable
  updatedAt: number;
  usedAt?: number;
}

export const RECENCY_MAX = 0.1;

export function recencyBonus(updatedAt: number, usedAt: number | undefined, now = Date.now()): number {
  const t = Math.max(updatedAt, usedAt ?? 0);
  const days = Math.max(0, (now - t) / 86_400_000);
  return RECENCY_MAX * Math.exp(-days / 30);
}

export function finalScore(r: RankInput, now = Date.now()): number {
  const cos = r.cosine == null ? 0 : Math.max(0, r.cosine);
  const sem = r.cosine == null ? r.fts : 0.4 * r.fts + 0.6 * cos;
  return sem + recencyBonus(r.updatedAt, r.usedAt, now);
}

/** BM25 from SQLite FTS5 is negative (lower = better); map to 0..1 within the result set. */
export function normaliseBm25(scores: Map<string, number>): Map<string, number> {
  const vals = [...scores.values()];
  if (!vals.length) return new Map();
  const best = Math.min(...vals);
  const out = new Map<string, number>();
  for (const [k, v] of scores) out.set(k, best < 0 ? Math.max(0.2, v / best) : 1);
  return out;
}

/** Results worth showing: a lexical hit, or a semantic match above the noise floor. */
export function rankResults(rows: RankInput[], now = Date.now(), minCosine = 0.3): { id: string; score: number }[] {
  return rows
    .filter((r) => r.fts > 0 || (r.cosine != null && r.cosine >= minCosine))
    .map((r) => ({ id: r.id, score: finalScore(r, now) }))
    .sort((a, b) => b.score - a.score);
}
