/**
 * Delivery receipts for Filenymous links.
 *
 * A small, privacy-light beacon: the receive page reports two events
 *   - "open"     when the file card is shown to the recipient,
 *   - "download" after a successful decryption / save,
 * to a tiny endpoint hosted alongside the site (/rcpt/report.php).
 * The sender's result screen polls /rcpt/status.php to display
 * "opened" / "downloaded" confirmations.
 *
 * Only an opaque random id and a timestamp ever leave a device — never the
 * file, the key, the password, or any contact information.
 */

import { b64urlEncode } from "../crypto/b64url";

export type ReceiptEvent = "open" | "download";

export interface ReceiptStatus {
  open: number | null;
  download: number | null;
}

const RCPT_BASE = "/rcpt";

/** Generate a new opaque receipt id (16 chars of base64url, 12 random bytes). */
export function newReceiptId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return b64urlEncode(bytes);
}

/** Fire-and-forget receipt report (best effort; never throws). */
export function reportReceipt(receiptId: string | undefined | null, event: ReceiptEvent): void {
  if (!receiptId) return;
  try {
    const body = JSON.stringify({ id: receiptId, event });
    void fetch(`${RCPT_BASE}/report.php`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {
      /* receipts are best-effort */
    });
  } catch {
    /* ignore */
  }
}

/** Fetch the current receipt status for a link id (sender side). */
export async function fetchReceiptStatus(receiptId: string): Promise<ReceiptStatus | null> {
  try {
    const res = await fetch(`${RCPT_BASE}/status.php?id=${encodeURIComponent(receiptId)}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      ok?: boolean;
      open?: number | null;
      download?: number | null;
    };
    if (!j || j.ok !== true) return null;
    return { open: j.open ?? null, download: j.download ?? null };
  } catch {
    return null;
  }
}
