import { createContext, useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SafeClient } from "./client";
import { useClipboardState, clearNow } from "./clipboard";
import { estimateBits, strengthLevel } from "./strength";
import type { Category, Peer, VaultStatus } from "./types";

export interface Toast {
  id: number;
  text: string;
  kind: "ok" | "info" | "warn" | "err";
}

export interface SafeCtx {
  client: SafeClient;
  status: VaultStatus;
  refresh(): Promise<void>;
  toast(text: string, kind?: Toast["kind"]): void;
  lock(): void;
  peers: Peer[];
  reloadPeers(): Promise<void>;
}

export const Ctx = createContext<SafeCtx | null>(null);
export const useSafe = () => useContext(Ctx)!;

export const CAT_ICON: Record<Category, string> = { login: "🔑", note: "📝", api_key: "🧩", file: "📎" };

export function CatIcon({ c }: { c: Category }) {
  return (
    <span className="cf-cat" data-cat={c} aria-hidden="true">
      {CAT_ICON[c]}
    </span>
  );
}

export function useNow(ms = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Circular countdown (SVG ring). */
export function Ring({ until, total, size = 22 }: { until: number; total: number; size?: number }) {
  const now = useNow(200);
  const left = Math.max(0, until - now);
  const r = size / 2 - 2.5;
  const c = 2 * Math.PI * r;
  return (
    <span className="cf-ring" data-testid="cf-ring" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} className="cf-ring-bg" />
        <circle cx={size / 2} cy={size / 2} r={r} className="cf-ring-fg" strokeDasharray={c} strokeDashoffset={c * (1 - left / total)} />
      </svg>
      <span className="cf-ring-n">{Math.ceil(left / 1000)}</span>
    </span>
  );
}

/** Floating "copied — clipboard clears in N s" pill. */
export function ClipboardPill() {
  const { t } = useTranslation();
  const s = useClipboardState();
  if (!s) return null;
  return (
    <div className="cf-clip" role="status" data-testid="cf-clip">
      <Ring until={s.until} total={s.total} size={26} />
      <span>{t("safe.clip.copied", { what: s.label })}</span>
      <button type="button" className="cf-link" onClick={clearNow} data-testid="cf-clip-clear">
        {t("safe.clip.clearNow")}
      </button>
    </div>
  );
}

export function StrengthMeter({ value, testId = "cf-strength" }: { value: string; testId?: string }) {
  const { t } = useTranslation();
  const bits = value ? Math.round(estimateBits(value)) : 0;
  const level = value ? strengthLevel(bits) : 0;
  return (
    <div className="cf-meter" data-level={level} data-testid={testId} data-bits={bits}>
      <div className="cf-meter-bar">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={i < level ? "is-on" : ""} />
        ))}
      </div>
      <small>
        {value ? t(`safe.strength.l${level}`) : t("safe.strength.empty")}
        {value ? ` · ${t("safe.strength.bits", { bits })}` : ""}
      </small>
    </div>
  );
}

export function fmtDate(ts: number, lang: string): string {
  try {
    return new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(new Date(ts));
  } catch {
    return new Date(ts).toLocaleString();
  }
}

export function fmtRelative(ts: number, lang: string, now = Date.now()): string {
  const s = Math.round((ts - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(s, "second");
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
}

export function errKey(e: unknown): string {
  const m = String((e as Error)?.message || e);
  const known = ["read-only", "forbidden", "unknown-peer", "bad-card", "self", "not-found", "bad-backup", "busy", "no-password", "prf-unavailable", "cancelled"];
  return known.includes(m) ? `safe.err.${m}` : "safe.err.generic";
}

/** Overlays render under `.pz-app` (where the theme tokens live), outside any transformed ancestor. */
export function overlayRoot(): Element {
  return document.querySelector(".pz-app") ?? document.body;
}
