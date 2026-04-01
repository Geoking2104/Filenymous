/**
 * SHA-256 hash of a normalised contact (email or phone).
 * This hash is published on the DHT — never the raw contact.
 *
 * Normalisation rules:
 *   - email : lowercase + trim
 *   - phone : e.164 format assumed (starts with +), strip spaces
 */

export function normaliseContact(contact: string): string {
  const trimmed = contact.trim();
  if (trimmed.startsWith("+")) {
    // Phone: strip all spaces and dashes
    return trimmed.replace(/[\s\-]/g, "");
  }
  return trimmed.toLowerCase();
}

export async function hashContact(contact: string): Promise<string> {
  const normalised = normaliseContact(contact);
  const encoded = new TextEncoder().encode(normalised);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
