import { safeFileName, type P2PFileInfo } from "./protocol";

/** Where received plaintext goes. Streams to disk when the browser allows it. */
export interface FileSink {
  readonly kind: "fs-file" | "fs-dir" | "memory";
  open(index: number, info: P2PFileInfo): Promise<void>;
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

type WritableLike = { write(data: BufferSource | Blob): Promise<void>; close(): Promise<void>; abort?(): Promise<void> };
type FileHandleLike = { createWritable(): Promise<WritableLike> };
type DirHandleLike = { getFileHandle(name: string, opts: { create: boolean }): Promise<FileHandleLike> };
type PickerWindow = Window & {
  showSaveFilePicker?: (opts?: { suggestedName?: string }) => Promise<FileHandleLike>;
  showDirectoryPicker?: (opts?: { mode?: "readwrite" }) => Promise<DirHandleLike>;
};

/** Above this size the in-memory fallback is risky; the UI warns the user. */
export const MEMORY_SINK_SOFT_LIMIT = 1.5 * 1024 ** 3;

export function canStreamToDisk(fileCount: number): boolean {
  const w = window as PickerWindow;
  return fileCount === 1 ? typeof w.showSaveFilePicker === "function" : typeof w.showDirectoryPicker === "function";
}

class StreamSink implements FileSink {
  private current: WritableLike | null = null;
  constructor(
    readonly kind: "fs-file" | "fs-dir",
    private readonly getHandle: (info: P2PFileInfo) => Promise<FileHandleLike>,
  ) {}
  async open(_index: number, info: P2PFileInfo) {
    this.current = await (await this.getHandle(info)).createWritable();
  }
  async write(chunk: Uint8Array) {
    await this.current!.write(chunk as Uint8Array<ArrayBuffer>);
  }
  async close() {
    await this.current?.close();
    this.current = null;
  }
  async abort() {
    try { await this.current?.abort?.(); } catch { /* ignore */ }
    this.current = null;
  }
}

/** Fallback: Blob parts (Chromium pages large Blobs to disk) + <a download>. */
export class MemorySink implements FileSink {
  readonly kind = "memory" as const;
  private parts: Blob[] = [];
  private info: P2PFileInfo | null = null;
  readonly saved: Array<{ name: string; blob: Blob }> = [];
  constructor(private readonly autoDownload = true) {}
  async open(_index: number, info: P2PFileInfo) {
    this.parts = [];
    this.info = info;
  }
  async write(chunk: Uint8Array) {
    this.parts.push(new Blob([chunk.slice()]));
  }
  async close() {
    if (!this.info) return;
    const blob = new Blob(this.parts, { type: this.info.mime || "application/octet-stream" });
    const name = safeFileName(this.info.name);
    this.saved.push({ name, blob });
    this.parts = [];
    if (this.autoDownload && typeof document !== "undefined") {
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), { href: url, download: name });
      a.dataset.p2pDownload = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }
  async abort() {
    this.parts = [];
  }
}

/**
 * Must be called from a user gesture (click) because of the File System
 * Access pickers. Falls back to MemorySink when pickers are unavailable or the
 * user cancels them.
 */
export async function chooseSink(files: P2PFileInfo[]): Promise<FileSink> {
  const w = window as PickerWindow;
  try {
    if (files.length === 1 && w.showSaveFilePicker) {
      const handle = await w.showSaveFilePicker({ suggestedName: safeFileName(files[0]!.name) });
      return new StreamSink("fs-file", async () => handle);
    }
    if (files.length > 1 && w.showDirectoryPicker) {
      const dir = await w.showDirectoryPicker({ mode: "readwrite" });
      return new StreamSink("fs-dir", (info) => dir.getFileHandle(safeFileName(info.name), { create: true }));
    }
  } catch (e) {
    if ((e as DOMException)?.name === "AbortError") throw e;
  }
  return new MemorySink();
}
