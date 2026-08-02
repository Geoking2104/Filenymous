/**
 * Multi-file bundling for optical transfers.
 *
 * Packs multiple files into a minimal tar-like archive before encryption,
 * so the receiver gets a single file they can unpack. Uses a simple format:
 *
 *   [u32 entryCount]
 *   For each entry:
 *     [u32 nameLen] [name bytes UTF-8]
 *     [u32 dataLen] [data bytes]
 *
 * This is lighter than POSIX tar and self-describing.
 */

export interface BundleEntry {
  name: string;
  data: Uint8Array;
}

/**
 * Pack multiple files into a single Uint8Array.
 * If only one file is provided, returns its raw bytes (no wrapping).
 */
export function packBundle(entries: BundleEntry[]): Uint8Array {
  if (entries.length === 0) throw new Error("Cannot pack an empty bundle.");
  if (entries.length === 1) return entries[0]!.data;

  const encoder = new TextEncoder();
  const nameBytes = entries.map((e) => encoder.encode(e.name));
  const totalSize =
    4 + // entryCount
    entries.reduce((sum, e, i) => sum + 4 + nameBytes[i]!.length + 4 + e.data.length, 0);

  const buf = new Uint8Array(totalSize);
  const view = new DataView(buf.buffer);
  let offset = 0;

  view.setUint32(offset, entries.length, true); offset += 4;

  for (let i = 0; i < entries.length; i++) {
    const nb = nameBytes[i]!;
    const data = entries[i]!.data;
    view.setUint32(offset, nb.length, true); offset += 4;
    buf.set(nb, offset); offset += nb.length;
    view.setUint32(offset, data.length, true); offset += 4;
    buf.set(data, offset); offset += data.length;
  }

  return buf;
}

/**
 * Check if a plaintext looks like a bundle (starts with a valid entry count
 * and the sizes make sense). Heuristic: if the first 4 bytes decode to a
 * count > 1 and the total consumed bytes match the buffer length.
 */
export function isBundle(data: Uint8Array): boolean {
  if (data.length < 4) return false;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = view.getUint32(0, true);
  if (count < 2 || count > 1000) return false;

  let offset = 4;
  for (let i = 0; i < count; i++) {
    if (offset + 4 > data.length) return false;
    const nameLen = view.getUint32(offset, true); offset += 4;
    if (nameLen > 255 || offset + nameLen > data.length) return false;
    offset += nameLen;
    if (offset + 4 > data.length) return false;
    const dataLen = view.getUint32(offset, true); offset += 4;
    if (offset + dataLen > data.length) return false;
    offset += dataLen;
  }
  return offset === data.length;
}

/**
 * Unpack a bundle into individual entries. Throws if the data is not a valid bundle.
 */
export function unpackBundle(data: Uint8Array): BundleEntry[] {
  if (!isBundle(data)) throw new Error("Not a valid bundle.");

  const decoder = new TextDecoder();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = view.getUint32(0, true);
  const entries: BundleEntry[] = [];
  let offset = 4;

  for (let i = 0; i < count; i++) {
    const nameLen = view.getUint32(offset, true); offset += 4;
    const name = decoder.decode(data.subarray(offset, offset + nameLen)); offset += nameLen;
    const dataLen = view.getUint32(offset, true); offset += 4;
    const entryData = data.slice(offset, offset + dataLen); offset += dataLen;
    entries.push({ name, data: entryData });
  }

  return entries;
}
