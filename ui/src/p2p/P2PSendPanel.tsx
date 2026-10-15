import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import { P2PSender, type SenderState } from "./session";
import { buildShareLink } from "./protocol";
import { formatBytes } from "../ux-v3/types";

interface Props {
  files: File[];
  message?: string;
  onStop: () => void;
}

function shareBaseUrl(): string {
  return `${location.origin}${location.pathname}`;
}

/** Sender view for a live, direct transfer. */
export default function P2PSendPanel({ files, message, onStop }: Props) {
  const { t } = useTranslation();
  const [state, setState] = useState<SenderState | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const senderRef = useRef<P2PSender | null>(null);

  useEffect(() => {
    const sender = new P2PSender(files, setState, { message });
    senderRef.current = sender;
    sender.start().catch((e) => setError(String((e as Error).message || e)));
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      sender.stop();
    };
  }, [files, message]);

  const link = useMemo(() => (state ? buildShareLink(shareBaseUrl(), state.code, state.secret) : ""), [state?.code, state?.secret]);
  const pct = state && state.totalBytes ? Math.min(100, Math.round((state.sentBytes / state.totalBytes) * 100)) : 0;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  const share = async () => {
    try {
      await navigator.share?.({ title: "Filenymous", url: link });
    } catch {
      /* cancelled */
    }
  };

  const statusText = (() => {
    if (error) return t("p2p.errorSignal", { message: error });
    if (!state) return t("p2p.starting");
    if (state.error === "ice-failed" || state.error === "ice-timeout") return t("p2p.iceFailed");
    switch (state.status) {
      case "starting":
        return t("p2p.starting");
      case "waiting":
        return t("p2p.waitingReceiver");
      case "connecting":
        return t("p2p.peerConnecting");
      case "transferring":
        return t("p2p.sending", { pct });
      case "complete":
        return t("p2p.sentComplete", { count: state.downloads });
      case "reconnecting":
        return t("p2p.reconnecting");
      case "error":
        return t("p2p.errorSignal", { message: state.error ?? "" });
      default:
        return "";
    }
  })();

  return (
    <div className="v3-result" data-testid="p2p-send-panel">
      <div className="v3-step">{t("p2p.sendTitle")}</div>
      <div className="v3-warn" role="note" style={{ marginBottom: ".8rem" }}>
        ⚠ {t("p2p.keepTabOpen")}
      </div>
      {state && (
        <>
          <div className="v3-code" data-testid="p2p-code">{state.code}</div>
          <div className="v3-qr-wrap">
            <div className="v3-qr">
              <QRCodeSVG value={link} size={200} level="M" marginSize={2} bgColor="#ffffff" fgColor="#0f172a" title={t("p2p.qrTitle")} />
            </div>
            <p className="v3-qr-caption">{t("p2p.qrCaption")}</p>
          </div>
          <div className="v3-link-row">
            <input readOnly data-testid="p2p-link" value={link} onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="v3-copy-btn" onClick={copy}>
              {copied ? `✓ ${t("common.copied")}` : t("common.copy")}
            </button>
          </div>
          {typeof navigator.share === "function" && (
            <button type="button" className="v3-btn-ghost" onClick={share} style={{ marginBottom: ".6rem" }}>
              {t("p2p.shareNative")}
            </button>
          )}
        </>
      )}
      <ul className="v3-muted" style={{ fontSize: ".8rem", textAlign: "left", paddingLeft: "1.1rem" }}>
        {files.map((f, i) => (
          <li key={`${f.name}-${i}`}>
            {f.name} · {formatBytes(f.size)}
          </li>
        ))}
      </ul>
      <div className="v3-status" data-testid="p2p-send-status" data-status={state?.status ?? "starting"} style={{ margin: ".6rem 0" }}>
        <span className="v3-pulse" />
        {statusText}
      </div>
      {state?.status === "transferring" && (
        <progress max={100} value={pct} style={{ width: "100%" }} aria-label={t("p2p.progress")} />
      )}
      <p className="v3-footnote">{t("p2p.securityNote")}</p>
      <button type="button" className="v3-btn-ghost" onClick={onStop}>
        {t("p2p.stop")}
      </button>
    </div>
  );
}
