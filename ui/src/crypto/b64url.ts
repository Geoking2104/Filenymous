/**
 * base64url helpers (URL-safe, unpadded).
 * Safe for large payloads (no spread-operator argument limits).
 */

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x2000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)) as unknown as number[],
    );
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  const b64 = s
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(s.length + ((4 - (s.length % 4)) % 4), "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlEncodeString(s: string): string {
  return b64urlEncode(new TextEncoder().encode(s));
}

export function b64urlDecodeString(s: string): string {
  return new TextDecoder().decode(b64urlDecode(s));
}
