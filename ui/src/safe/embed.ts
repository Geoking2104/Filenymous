/** Local MiniLM embeddings for vault search (same self-hosted model as Sharewall; nothing leaves the tab). */
type Res = { id: number; ok: boolean; dim?: number; data?: Float32Array; error?: string };

export class SafeEmbedder {
  private worker: Worker | null = null;
  private seq = 0;
  private wait = new Map<number, { ok: (r: Res) => void; ko: (e: Error) => void }>();

  private post(msg: object): Promise<Res> {
    if (!this.worker) {
      this.worker = new Worker(new URL("../wall/ai/embed.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (e: MessageEvent<Res>) => {
        const w = this.wait.get(e.data.id);
        if (!w) return;
        this.wait.delete(e.data.id);
        if (e.data.ok) w.ok(e.data);
        else w.ko(new Error(e.data.error || "embedding failed"));
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

  async warm(): Promise<void> {
    await this.post({ warm: true });
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 16) {
      const r = await this.post({ texts: texts.slice(i, i + 16).map((t) => t.slice(0, 2000)) });
      if (!r.data || !r.dim) throw new Error("no vectors");
      for (let j = 0; j * r.dim < r.data.length; j++) out.push(r.data.slice(j * r.dim, (j + 1) * r.dim));
    }
    return out;
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    for (const w of this.wait.values()) w.ko(new Error("disposed"));
    this.wait.clear();
  }
}
