import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLeaveGuard } from "../home/confirmLeave";
import { P2PReceiver, type ReceiverState } from "./session";
import { parseShareInput } from "./protocol";
import { MEMORY_SINK_SOFT_LIMIT, canStreamToDisk, chooseSink } from "./sink";
import { p2pSupported } from "./config";
import { formatBytes } from "../ux-v3/types";
import { describeDevice } from "./device";
import PigeonFlight from "../home/PigeonFlight";
import StreamPlayer from "./StreamPlayer";
import ExpiryCountdown from "./ExpiryCountdown";
import { canPlayInBrowser, mediaKind } from "./media";
import { streamingAvailable, type StreamReader } from "./stream";

/** How long we wait for a sender before explaining what may be wrong (the session keeps waiting). */
export const NO_SENDER_HINT_MS = 25_000;

/** Statuses during which no sender has shown up yet. */
export function isWaitingForSender(status: ReceiverState["status"]): boolean {
  return status === "connecting" || status === "waiting-sender";
}

/** Back to the home code field, so the user can type another code. */
export function goEnterAnotherCode(): void {
  history.replaceState(null, "", location.pathname + location.search);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  // The home screen renders on the next frame(s).
  let tries = 0;
  const focus = () => {
    const el = document.getElementById("pz-home-code");
    if (el) {
      el.scrollIntoView({ block: "center" });
      (el as HTMLInputElement).focus();
    } else if (++tries < 20) setTimeout(focus, 50);
  };
  setTimeout(focus, 0);
}

interface Props {
  hash: string;
  /** Override for tests. */
  noSenderHintMs?: number;
  /** Sender chose streaming mode (manifest): the shell then shows the streaming icon. */
  onStreamable?: (streamable: boolean) => void;
}

/** Recipient landing for `#p2p:CODE/SECRET`: connects automatically. */
export default function P2PReceivePanel({ hash, onStreamable, noSenderHintMs }: Props) {
  const { t } = useTranslation();
  const [state, setState] = useState<ReceiverState>({ status: "connecting", files: [], receivedBytes: 0, totalBytes: 0, speed: 0 });
  const receiverRef = useRef<P2PReceiver | null>(null);
  const [reader, setReader] = useState<StreamReader | null>(null);
  const [noSw, setNoSw] = useState(false);
  const parsed = parseShareInput(hash);
  const [noSender, setNoSender] = useState(false);
  const waiting = isWaitingForSender(state.status);

  useEffect(() => {
    if (!parsed || !p2pSupported()) return;
    let alive = true;
    const r = new P2PReceiver(parsed.code, parsed.secret, (st) => alive && setState(st), undefined, undefined, parsed.expires);
    receiverRef.current = r;
    void r.start();
    return () => {
      alive = false;
      r.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed?.code, parsed?.secret, parsed?.expires]);

  // Nobody answers on this code after a while: say why it may be, and offer a way out.
  useEffect(() => {
    if (!waiting) {
      setNoSender(false);
      return;
    }
    const testMs = Number((window as { __FILENYMOUS_TEST_NO_SENDER_MS__?: number }).__FILENYMOUS_TEST_NO_SENDER_MS__) || 0;
    const id = setTimeout(() => setNoSender(true), noSenderHintMs ?? (testMs || NO_SENDER_HINT_MS));
    return () => clearTimeout(id);
  }, [waiting, noSenderHintMs]);

  useEffect(() => {
    onStreamable?.(!!state.streamable);
  }, [state.streamable, onStreamable]);

  // Leaving mid-download (or mid-stream) loses it: same guard as every service.
  useLeaveGuard(state.status === "receiving" || state.status === "streaming");

  if (!parsed) return <div className="v3-warn">{t("p2p.invalidLink")}</div>;
  if (!p2pSupported()) return <div className="v3-warn">{t("p2p.unsupported")}</div>;

  const pct = state.totalBytes ? Math.min(100, Math.round((state.receivedBytes / state.totalBytes) * 100)) : 0;
  const streaming = canStreamToDisk(state.files.length);

  const playable = state.streamable ? state.files.map((f, i) => (canPlayInBrowser(f.name, f.mime) ? i : -1)).filter((i) => i >= 0) : [];
  const hasMedia = state.files.some((f) => mediaKind(f.name, f.mime));
  const canStream = playable.length > 0 && !noSw && typeof navigator !== "undefined" && "serviceWorker" in navigator;
  const startStream = async () => {
    if (!(await streamingAvailable())) return setNoSw(true);
    try {
      setReader(receiverRef.current?.startStreaming() ?? null);
    } catch {
      setNoSw(true);
    }
  };

  const download = async () => {
    try {
      const sink = await chooseSink(state.files);
      receiverRef.current?.download(sink);
    } catch {
      /* picker cancelled */
    }
  };

  const statusText = (() => {
    switch (state.status) {
      case "connecting":
        return t("p2p.recvConnecting");
      case "waiting-sender":
        return t("p2p.recvWaitingSender");
      case "negotiating":
        return t("p2p.peerConnecting");
      case "password":
        return state.authChecking ? t("pw.checking") : t("pw.recvPrompt");
      case "ready":
        return t("p2p.recvReady");
      case "receiving":
        return t("p2p.receiving", { pct });
      case "complete":
        return t("p2p.recvComplete");
      case "streaming":
        return t("stream.playing");
      case "error":
        if (state.error === "ice-failed" || state.error === "ice-timeout") return t("p2p.iceFailed");
        if (state.error === "role-taken") return t("p2p.roleTaken");
        if (state.error === "sender-disconnected") return t("p2p.senderGone");
        if (state.error === "sender-stopped") return t("p2p.senderStopped");
        if (state.error === "stalled") return t("p2p.stalled");
        if (state.error === "expired") return t("expiry.linkExpired");
        if (state.error === "too-many-attempts") return t("pw.tooMany");
        if (state.error === "unsupported-protocol") return t("pw.unsupportedProtocol");
        if (state.error === "decrypt-error" || state.error === "integrity-error") return t("p2p.integrityError");
        return t("p2p.errorSignal", { message: state.error ?? "" });
      default:
        return "";
    }
  })();

  return (
    <div className="v3-result" data-testid="p2p-receive-panel">
      <div className="v3-step">{t("p2p.recvTitle")}</div>
      <div className="v3-code">{parsed.code}</div>
      {state.peerDevice && <p className="pz-peer" data-testid="p2p-peer-device">{t("pz.senderDevice", { device: state.peerDevice })}</p>}
      {state.message && <p className="v3-muted">“{state.message}”</p>}
      {state.files.length > 0 && (
        <ul className="v3-muted" style={{ fontSize: ".85rem", textAlign: "left", paddingLeft: "1.1rem" }} data-testid="p2p-files">
          {state.files.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              {f.name} · {formatBytes(f.size)}
            </li>
          ))}
        </ul>
      )}
      {state.expires && state.status !== "error" && state.status !== "complete" && <ExpiryCountdown expires={state.expires} />}
      <div className="v3-status" data-testid="p2p-recv-status" data-status={state.status} style={{ margin: ".6rem 0" }}>
        <span className="v3-pulse" />
        {statusText}
      </div>
      {noSender && waiting && (
        <div className="v3-warn pz-no-sender" role="alert" data-testid="p2p-no-sender">
          <strong>{t("p2p.noSenderTitle")}</strong>
          <p>{t("p2p.noSenderBody")}</p>
          <div className="pz-actions">
            <button type="button" className="pz-btn-ghost" data-testid="p2p-no-sender-retry" onClick={() => location.reload()}>
              {t("p2p.retry")}
            </button>
            <button type="button" className="pz-btn" data-testid="p2p-other-code" onClick={goEnterAnotherCode}>
              {t("p2p.otherCode")}
            </button>
          </div>
        </div>
      )}
      {(state.status === "receiving" || state.status === "complete") && (
        <>
          <PigeonFlight pct={state.status === "complete" ? 100 : pct} self="to" from={state.peerDevice} to={describeDevice()} done={state.status === "complete"} />
          <p className="v3-muted" data-testid="p2p-recv-bytes" style={{ fontSize: ".8rem", margin: ".3rem 0" }}>
            {formatBytes(state.receivedBytes)} / {formatBytes(state.totalBytes)}
            {state.status === "receiving" && state.speed > 0 ? ` · ${formatBytes(state.speed)}/s` : ""}
          </p>
        </>
      )}
      {state.status === "password" && (
        <form
          className="pz-pw-form"
          data-testid="p2p-password-form"
          onSubmit={(e) => {
            e.preventDefault();
            const input = e.currentTarget.elements.namedItem("pw") as HTMLInputElement;
            void receiverRef.current?.submitPassword(input.value);
          }}
        >
          <label htmlFor="p2p-pw">🔒 {t("pw.recvLabel")}</label>
          <input id="p2p-pw" name="pw" type="password" autoComplete="off" autoFocus data-testid="p2p-password" disabled={state.authChecking} />
          {state.authError && (
            <p className="pz-err" role="alert" data-testid="p2p-password-error">
              {t("pw.wrong", { count: state.authRemaining ?? 0 })}
            </p>
          )}
          <button type="submit" className="pz-btn" data-testid="p2p-password-submit" disabled={state.authChecking}>
            {state.authChecking ? t("pw.checking") : t("pw.unlock")}
          </button>
        </form>
      )}
      {state.status === "error" && state.error !== "expired" && (
        <div className="pz-actions">
          <button type="button" className="v3-btn-ghost" data-testid="p2p-retry" onClick={() => location.reload()}>
            {t("p2p.retry")}
          </button>
          <button type="button" className="v3-btn-ghost" data-testid="p2p-error-other-code" onClick={goEnterAnotherCode}>
            {t("p2p.otherCode")}
          </button>
        </div>
      )}
      {state.status === "streaming" && reader && (
        <StreamPlayer reader={reader} files={state.files} playable={playable} receivedBytes={state.receivedBytes} onUnavailable={() => setNoSw(true)} />
      )}
      {state.status === "streaming" && noSw && <div className="v3-warn" data-testid="p2p-stream-unsupported">{t("stream.noWorker")}</div>}
      {state.status === "ready" && state.streamable && canStream && (
        <button type="button" className="v3-btn-primary pz-stream-play" data-testid="p2p-stream-play" onClick={() => void startStream()}>
          ▶ {t("stream.play")}
        </button>
      )}
      {state.status === "ready" && state.streamable && hasMedia && !canStream && (
        <div className="v3-warn" data-testid="p2p-stream-unsupported">{t("stream.afterDownload")}</div>
      )}
      {state.status === "ready" && (
        <>
          {!streaming && state.totalBytes > MEMORY_SINK_SOFT_LIMIT && (
            <div className="v3-warn">{t("p2p.memoryWarning")}</div>
          )}
          <button type="button" className="v3-btn-primary" data-testid="p2p-download" onClick={download}>
            {t("p2p.download", { size: formatBytes(state.totalBytes) })}
          </button>
        </>
      )}
      <p className="v3-footnote">{t("p2p.securityNote")}</p>
    </div>
  );
}
