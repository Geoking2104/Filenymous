import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { FileMeta } from "./crypto";
import { ReportError } from "./api";

export const MAX_FILES_BYTES = 8 * 1024 * 1024;
export const KEY_STORAGE_PREFIX = "fn-report-key:";

export function errorText(t: (k: string) => string, e: unknown): string {
  return e instanceof ReportError ? t(`report.error.${e.code}`) : t("report.error.network");
}

export function CopyButton({ value, testId }: { value: string; testId?: string }) {
  const { t } = useTranslation();
  const [ok, setOk] = useState(false);
  return (
    <button type="button" className="v3-copy-btn" data-testid={testId} onClick={async () => {
      try {
        await navigator.clipboard.writeText(value);
        setOk(true);
        setTimeout(() => setOk(false), 2000);
      } catch {
        /* clipboard denied: the value stays selectable */
      }
    }}>
      {ok ? `✓ ${t("common.copied")}` : t("report.copy")}
    </button>
  );
}

export function MetaLine({ meta, name }: { meta: FileMeta; name: string }) {
  const { t } = useTranslation();
  const tone = meta.status === "cleaned" || meta.status === "nothing-found" ? "ok" : "warn";
  return (
    <li className={`rp-meta rp-meta--${tone}`} data-testid="report-file-meta" data-status={meta.status}>
      <strong>{name}</strong>{" "}
      <span>{t(`report.meta.${meta.status}`)}</span>
      {meta.removed.length > 0 && <small> · {t("report.meta.removed", { list: meta.removed.join(", ") })}</small>}
      {meta.remaining.length > 0 && (
        <small className="rp-meta-left"> · {t("report.meta.remaining", { list: meta.remaining.map((r) => t(`report.meta.left.${r}`)).join(", ") })}</small>
      )}
    </li>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  return <span className={`rp-status rp-status--${status}`} data-testid="report-status" data-status={status}>{t(`report.status.${status}`)}</span>;
}

export const fmtDate = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function saveFile(name: string, data: BlobPart, type = "application/octet-stream") {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
