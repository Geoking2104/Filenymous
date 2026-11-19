import { gunzipSync } from "fflate";

/** Some hosts serve .gz with Content-Encoding: the browser has then already inflated it. */
export function inflate(bytes: Uint8Array): Uint8Array {
  return bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
}
