/**
 * Semantic ranker for wall search, run in a worker of the host tab with a
 * self-hosted MiniLM (q8). Doc vectors are cached by id+text. Nothing leaves
 * the tab; only the snippets the host returns reach an agent.
 */
import type { SearchDoc, SemanticRanker } from "../wallsearch";

const MAX_CACHE = 4000;

export class LocalEmbedder implements SemanticRanker {
  private worker: Worker | null = null;
  private seq = 0;
  private wait = new Map<number, { ok: (v: { dim: number; data: Float32Array } | null) => void; ko: (e: Error) => void }>();
  private cache = new Map<string, Float32Array>();

  private post(msg: object): Promise<{ dim: number; data: Float32Array } | null> {
    if (!this.worker) {
      this.worker = new Worker(new URL("./embed.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; dim?: number; data?: Float32Array; error?: string }>) => {
        const w = this.wait.get(e.data.id);
        if (!w) return;
        this.wait.delete(e.data.id);
        if (!e.data.ok) w.ko(new Error(e.data.error || "embedding failed"));
        else w.ok(e.data.data ? { dim: e.data.dim!, data: e.data.data } : null);
      };
      this.worker.onerror = () => {
        for (const w of this.wait.values()) w.ko(new Error("embedding worker crashed"));
        this.wait.clear();
      };
    }
    const id = ++this.seq;
    return new Promise((ok, ko) => {
      this.wait.set(id, { ok, ko });
      this.worker!.postMessage({ id, ...msg });
    });
  }

  /** Downloads and initialises the model (call when the host opts in). */
  async warm(): Promise<void> {
    await this.post({ warm: true });
  }

  private async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 32) {
      const r = await this.post({ texts: texts.slice(i, i + 32) });
      if (!r) throw new Error("no vectors");
      for (let j = 0; j * r.dim < r.data.length; j++) out.push(r.data.slice(j * r.dim, (j + 1) * r.dim));
    }
    return out;
  }

  async scores(q: string, docs: readonly SearchDoc[]): Promise<number[]> {
    const key = (d: SearchDoc) => `${d.id}\u0000${d.text.slice(0, 2000)}`;
    const miss = docs.filter((d) => !this.cache.has(key(d)));
    if (miss.length) {
      const vecs = await this.embed(miss.map((d) => d.text.slice(0, 2000)));
      miss.forEach((d, i) => this.cache.set(key(d), vecs[i]!));
      while (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
    }
    const [qv] = await this.embed([q]);
    return docs.map((d) => dot(qv!, this.cache.get(key(d))!));
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    for (const w of this.wait.values()) w.ko(new Error("disposed"));
    this.wait.clear();
    this.cache.clear();
  }
}

function dot(a: Float32Array, b: Float32Array) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
