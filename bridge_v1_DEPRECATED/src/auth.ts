/**
 * HMAC-SHA256 verification for bridge requests.
 * The conductor signs each request body with BRIDGE_SECRET.
 * The bridge verifies the signature before processing.
 */

import { createHmac, timingSafeEqual } from "crypto";

const BRIDGE_SECRET = process.env.BRIDGE_SECRET ?? "dev-insecure-secret";

/**
 * Verify that `sig` is a valid HMAC-SHA256 of `body` with BRIDGE_SECRET.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function verifyHmac(body: string, sig: string): boolean {
  try {
    const expected = createHmac("sha256", BRIDGE_SECRET)
      .update(body)
      .digest("hex");

    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(sig,      "hex");

    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Sign a body (for use in the conductor / test client).
 */
export function signBody(body: string): string {
  return createHmac("sha256", BRIDGE_SECRET).update(body).digest("hex");
}
