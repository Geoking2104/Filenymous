import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import { P2PSender, type SenderState } from "./session";
import { buildShareLink } from "./protocol";
import ExpiryCountdown from "./ExpiryCountdown";
import { formatBytes } from "../ux-v3/types";
import { describeDevice } from "./device";
import PigeonFlight from "../home/PigeonFlight";

interface Props {
  files: File[];
  message?: string;
  /** Optional password: never put in the link or QR code. */
  password?: string;
  /** Offer streaming (range requests) to the recipient. */
  stream?: boolean;
  /** Expiry (Unix seconds). */
  expires?: number;
  onStop: () => void;
}

function shareBaseUrl(): string {
  return `${location.origin}${location.pathname}`;
}

/** Sender view for a live, direct transfer. */
export default function P2PSendPanel({ files, message, password, stream, expires, onStop }: Props) {
  const { t } = useTranslation();
  const [state, setState] = useState<SenderState | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const senderRef = useRef<P2PSender | null>(null);

  useEffect(() => {
    let alive = true;
    setError("");
    const sender = new P2PSender(files, (st) => alive && setState(st), { message, password: password || undefined, stream: !!stream, expires });
    senderRef.current = sender;
    sender.start().catch((e) => {
      if (alive) setError(String((e as Error).message || e));
    });
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => {
      alive = false;
      window.removeEventListener("beforeunload", onUnload);
      sender.stop();
    };
  }, [files, message, password, stream, expires]);

  const link = useMemo(() => (state ? buildShareLink(shareBaseUrl(), state.code, state.secret, state.expires) : ""), [state?.code, state?.secret, state?.expires]);
  const pct = state && state.totalBytes ? Math.min(100, Math.round((state.confirmedBytes / state.totalBytes) * 100)) : 0;
  const reasonText = (reason?: string) => {
    switch (reason) {
      case "connection-lost":
        return t("p2p.reasonConnectionLost");
      case "recipient-left":
        return t("p2p.reasonRecipientLeft");
      case "stalled":
        return t("p2p.reasonStalled");
      case "sender-stopped":
        return t("p2p.reasonSenderStopped");
      case "too-many-attempts":
        return t("pw.reasonTooMany");
      case "decrypt-error":
      case "integrity-error":
        return t("p2p.integrityError");
      case "ice-failed":
      case "ice-timeout":
        return t("p2p.iceFailed");
      default:
        return reason || t("p2p.reasonUnknown");
    }
  };
  const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

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
    if (error === "expired") return t("expiry.senderExpired");
    if (error) return t("p2p.errorSignal", { message: error });
    if (!state) return t("p2p.starting");
    if ((state.error === "ice-failed" || state.error === "ice-timeout") && state.status === "waiting") return t("p2p.iceFailed");
    switch (state.status) {
      case "starting":
        return t("p2p.starting");
      case "waiting":
        return t("p2p.waitingReceiver");
      case "connecting":
        return t("p2p.peerConnecting");
      case "connected":
        return state.protected ? t("pw.senderWaitingPassword") : t("p2p.recipientChoosing");
      case "transferring":
        return t("p2p.sending", { pct });
      case "expired":
        return t("expiry.senderExpired");
      case "streaming":
        return t("stream.senderStreaming", { size: formatBytes(state.sentBytes) });
      case "complete":
        return t("p2p.deliveredByRecipient");
      case "failed":
        return t("p2p.transferFailed", {
          reason: reasonText(state.protected && (state.authFailures ?? 0) >= 5 ? "too-many-attempts" : state.error),
        });
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
      {state?.protected && (
        <p className="pz-peer" data-testid="p2p-send-protected">
          🔒 {t("pw.senderProtected")}
          {state.authFailures ? ` · ${t("pw.senderFailures", { count: state.authFailures, max: 5 })}` : ""}
        </p>
      )}
      <ul className="v3-muted" style={{ fontSize: ".8rem", textAlign: "left", paddingLeft: "1.1rem" }} data-testid="p2p-send-files">
        {files.map((f, i) => {
          const fsState = state?.fileStates[i] ?? "pending";
          const icon = fsState === "delivered" ? "✅" : fsState === "failed" ? "⚠" : fsState === "sending" ? "⏳" : "•";
          return (
            <li key={`${f.name}-${i}`} data-file-state={fsState}>
              {icon} {f.name} · {formatBytes(f.size)}
            </li>
          );
        })}
      </ul>
      {state?.expires && state.status !== "expired" && <ExpiryCountdown expires={state.expires} testId="send-expiry" />}
      {(state?.protected || state?.expires) && (
        <p className="pz-protect-summary" data-testid="send-protect-summary">
          {state.protected ? `🔒 ${t("protect.passwordOn")}` : ""}
          {state.protected && state.expires ? " · " : ""}
          {state.expires ? `⏳ ${t("protect.expiryOn")}` : ""}
        </p>
      )}
      <div className="v3-status" data-testid="p2p-send-status" data-status={state?.status ?? "starting"} style={{ margin: ".6rem 0" }}>
        <span className="v3-pulse" />
        {statusText}
      </div>
      {state?.peerDevice && (state.status === "connected" || state.status === "transferring" || state.status === "complete") && (
        <p className="pz-peer" data-testid="p2p-peer-device">{t("pz.peerDevice", { device: state.peerDevice })}</p>
      )}
      {(state?.status === "transferring" || state?.status === "complete") && (
        <>
          <PigeonFlight pct={state.status === "complete" ? 100 : pct} self="from" from={describeDevice()} to={state.peerDevice} done={state.status === "complete"} />
          {state.status === "transferring" && (
            <p className="v3-muted" data-testid="p2p-send-bytes" style={{ fontSize: ".8rem", margin: ".3rem 0" }}>
              {t("p2p.confirmedBytes", {
                done: formatBytes(state.confirmedBytes),
                total: formatBytes(state.totalBytes),
                pct,
              })}
              {state.speed > 0 ? ` · ${formatBytes(state.speed)}/s` : ""}
            </p>
          )}
        </>
      )}
      {state && state.log.length > 0 && (
        <div style={{ textAlign: "left", margin: ".6rem 0" }} data-testid="p2p-send-log">
          <div className="v3-step" style={{ marginBottom: ".25rem" }}>
            {t("p2p.logTitle", { count: state.downloads })}
          </div>
          <ul className="v3-muted" style={{ fontSize: ".78rem", paddingLeft: "1.1rem", margin: 0 }}>
            {state.log.map((e) => (
              <li key={e.id} data-result={e.result}>
                {fmtTime(e.endedAt)} ·{" "}
                {e.result === "complete"
                  ? `✅ ${t("p2p.deliveredByRecipient")} (${formatBytes(e.totalBytes)}, ${Math.max(1, Math.round((e.endedAt - e.startedAt) / 1000))} s)`
                  : `⚠ ${t("p2p.transferFailed", { reason: reasonText(e.reason) })} — ${formatBytes(e.bytes)} / ${formatBytes(e.totalBytes)}`}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="v3-footnote">{t("p2p.securityNote")}</p>
      <button type="button" className="v3-btn-ghost" onClick={onStop}>
        {t("p2p.stop")}
      </button>
    </div>
  );
}
