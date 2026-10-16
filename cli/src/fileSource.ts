import { open, stat, type FileHandle } from "node:fs/promises";
import { basename, extname } from "node:path";

const MIME: Record<string, string> = {
  ".zip": "application/zip", ".gz": "application/gzip", ".tgz": "application/gzip", ".tar": "application/x-tar",
  ".txt": "text/plain", ".log": "text/plain", ".json": "application/json", ".pdf": "application/pdf",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".mp4": "video/mp4", ".html": "text/html",
};

export interface FileLike {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
  close(): Promise<void>;
}

/** A File-like view of a path on disk: slices are read on demand, never the whole file. */
export async function openFileSource(path: string): Promise<FileLike> {
  const st = await stat(path);
  if (!st.isFile()) throw new Error(`not a regular file: ${path}`);
  let fh: FileHandle | null = await open(path, "r");
  const size = st.size;
  return {
    name: basename(path),
    size,
    type: MIME[extname(path).toLowerCase()] ?? "application/octet-stream",
    slice(start: number, end: number) {
      const s = Math.max(0, Math.min(size, start));
      const e = Math.max(s, Math.min(size, end));
      return {
        async arrayBuffer() {
          const buf = Buffer.alloc(e - s);
          let off = 0;
          while (off < buf.length) {
            const { bytesRead } = await fh!.read(buf, off, buf.length - off, s + off);
            if (bytesRead === 0) throw new Error("file changed while sending");
            off += bytesRead;
          }
          return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) as ArrayBuffer;
        },
      };
    },
    async close() {
      await fh?.close();
      fh = null;
    },
  };
}
