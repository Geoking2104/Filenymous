/** Share expiry: presets, custom dates, countdown parts. */

export type ExpiryChoice = "none" | "1h" | "24h" | "7d" | "custom";

const PRESET_MS: Record<Exclude<ExpiryChoice, "none" | "custom">, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000 };
/** Longest allowed expiry (the sender's tab/CLI must stay online anyway). */
export const MAX_EXPIRY_MS = 30 * 86_400_000;

/** Unix seconds for a choice, or undefined (no expiry / invalid custom date). */
export function expiryFromChoice(choice: ExpiryChoice, custom: string, now = Date.now()): number | undefined {
  if (choice === "none") return undefined;
  const at = choice === "custom" ? Date.parse(custom) : now + PRESET_MS[choice];
  if (!Number.isFinite(at) || at <= now + 30_000 || at > now + MAX_EXPIRY_MS) return undefined;
  return Math.floor(at / 1000);
}

/** Splits a remaining duration for display: 2 j 3 h, 4 h 05 min, 12 min 09 s. */
export function remainingParts(ms: number): { d: number; h: number; m: number; s: number } {
  const t = Math.max(0, Math.floor(ms / 1000));
  return { d: Math.floor(t / 86400), h: Math.floor((t % 86400) / 3600), m: Math.floor((t % 3600) / 60), s: t % 60 };
}

export function formatRemaining(ms: number, lang: "fr" | "en" = "fr"): string {
  const { d, h, m, s } = remainingParts(ms);
  const dd = lang === "fr" ? "j" : "d";
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return `${d} ${dd} ${h} h`;
  if (h > 0) return `${h} h ${pad(m)} min`;
  if (m > 0) return `${m} min ${pad(s)} s`;
  return `${s} s`;
}

/** Value for <input type="datetime-local"> (local time), n ms from now. */
export function localInputValue(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
