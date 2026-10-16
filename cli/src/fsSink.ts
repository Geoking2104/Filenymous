import { createWriteStream, existsSync, mkdirSync, rmSync, type WriteStream } from "node:fs";
import { extname, join, basename } from "node:path";
import { safeFileName, type P2PFileInfo } from "../../ui/src/p2p/protocol";
import type { FileSink } from "../../ui/src/p2p/sink";

/** First free name in dir: report.pdf, report (1).pdf, ... */
export function uniquePath(dir: string, name: string, exists: (p: string) => boolean = existsSync): string {
  const safe = safeFileName(name);
  const ext = extname(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;
  let p = join(dir, safe);
  for (let i = 1; exists(p); i++) p = join(dir, `${stem} (${i})${ext}`);
  return p;
}

/** Streams received files straight to disk (one at a time). */
export class FsSink implements FileSink {
  readonly kind = "fs-dir" as const;
  readonly written: string[] = [];
  private stream: WriteStream | null = null;
  private path = "";
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  async open(_index: number, info: P2PFileInfo) {
    this.path = uniquePath(this.dir, basename(info.name));
    this.stream = createWriteStream(this.path, { flags: "wx" });
    await new Promise<void>((ok, ko) => this.stream!.once("open", () => ok()).once("error", ko));
  }
  async write(chunk: Uint8Array) {
    const s = this.stream!;
    if (!s.write(chunk)) await new Promise<void>((ok) => s.once("drain", () => ok()));
  }
  async close() {
    const s = this.stream;
    if (!s) return;
    await new Promise<void>((ok, ko) => s.end((err?: Error | null) => (err ? ko(err) : ok())));
    this.written.push(this.path);
    this.stream = null;
  }
  async abort() {
    const s = this.stream;
    this.stream = null;
    if (s) {
      s.destroy();
      try { rmSync(this.path, { force: true }); } catch { /* ignore */ }
    }
  }
}
