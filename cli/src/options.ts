/** Pure helpers (unit-tested): durations, webhook payloads. */

export function parseDuration(text: string): number {
  const m = String(text).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
  if (!m) throw new Error(`invalid duration: ${text} (examples: 90s, 15m, 1h, 2d)`);
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  const ms = n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit as "s"]!;
  if (!(ms >= 1000) || ms > 7 * 86_400_000) throw new Error(`duration out of range (1s..7d): ${text}`);
  return Math.round(ms);
}

export type ShareEvent = "share.created" | "download.completed" | "share.expired" | "share.failed";

export interface WebhookPayload {
  event: ShareEvent;
  link?: string;
  code?: string;
  file: string;
  size: number;
  expiresAt: string;
  downloads: number;
  maxDownloads: number;
  protected: boolean;
  error?: string;
}

/**
 * With noLink, both link and code are omitted: the code alone is enough to
 * fetch the file from the web app (the secret is wrapped with it), so it is as
 * sensitive as the link unless a password is set.
 */
export function webhookPayload(p: WebhookPayload, noLink: boolean): WebhookPayload {
  if (!noLink) return p;
  const { link: _l, code: _c, ...rest } = p;
  return rest;
}

export function formatBytes(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${i ? v.toFixed(1) : v} ${u[i]}`;
}

export const DEFAULT_APP_URL = "https://filenymous.eu/app/";
export const DEFAULT_SIGNAL_URL = "wss://www.opendpe.net/filenymous-signal/";
