export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

export function toBlobPart(bytes: Uint8Array): BlobPart {
  return toArrayBuffer(bytes);
}
