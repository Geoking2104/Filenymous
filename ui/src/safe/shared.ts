/**
 * The vault worker owns the database exclusively, so other features (the
 * messenger's "import my vault contacts") borrow the client of the open
 * Coffre-fort panel instead of starting a second worker.
 */
import type { SafeClient } from "./client";

let active: SafeClient | null = null;

export function setActiveSafe(c: SafeClient | null): void {
  active = c;
}

export function activeSafe(): SafeClient | null {
  return active;
}

export function releaseSafe(c: SafeClient): void {
  if (active === c) active = null;
}
