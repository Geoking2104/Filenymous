import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { P2PReceiver, type ReceiverState } from "./session";
import { parseShareInput } from "./protocol";
import { MEMORY_SINK_SOFT_LIMIT, canStreamToDisk, chooseSink } from "./sink";
import { p2pSupported } from "./config";
import { formatBytes } from "../ux-v3/types";
import { describeDevice } from "./device";
import PigeonFlight from "../pizza/PigeonFlight";

interface Props {
  hash: string;
}

/** Recipient landing for `#p2p:CODE/SECRET`: connects automatically. */
export default function P2PReceivePanel({ hash }: Props) {
  const { t } = useTranslation();
  const [state, setState] = useState<ReceiverState>({ status: "connecting", files: [], receivedBytes: 0, totalBytes: 0, speed: 0 });
  const receiverRef = useRef<P2PReceiver | null>(null);
  const parsed = parseShareInput(hash);

  useEffect(() => {
    if (!parsed || !p2pSupported()) return;
    let alive = true;
    const r = new P2PReceiver(parsed.code, parsed.secret, (st) => alive && setState(st));
    receiverRef.current = r;
    void r.start();
    return () => {
      alive = false;
      r.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed?.code, parsed?.secret]);

  useEffect(() => {
    if (state.status !== "receiving") return;
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [state.status]);

  if (!parsed) return <div className="v3-warn">{t("p2p.invalidLink")}</div>;
  if (!p2pSupported()) return <div className="v3-warn">{t("p2p.unsupported")}</div>;

  const pct = state.totalBytes ? Math.min(100, Math.round((state.receivedBytes / state.totalBytes) * 100)) : 0;
  const streaming = canStreamToDisk(state.files.length);

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
      case "ready":
        return t("p2p.recvReady");
      case "receiving":
        return t("p2p.receiving", { pct });
      case "complete":
        return t("p2p.recvComplete");
      case "error":
        if (state.error === "ice-failed" || state.error === "ice-timeout") return t("p2p.iceFailed");
        if (state.error === "role-taken") return t("p2p.roleTaken");
        if (state.error === "sender-disconnected") return t("p2p.senderGone");
        if (state.error === "sender-stopped") return t("p2p.senderStopped");
        if (state.error === "stalled") return t("p2p.stalled");
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
      <div className="v3-status" data-testid="p2p-recv-status" data-status={state.status} style={{ margin: ".6rem 0" }}>
        <span className="v3-pulse" />
        {statusText}
      </div>
      {(state.status === "receiving" || state.status === "complete") && (
        <>
          <PigeonFlight pct={state.status === "complete" ? 100 : pct} self="to" from={state.peerDevice} to={describeDevice()} done={state.status === "complete"} />
          <p className="v3-muted" data-testid="p2p-recv-bytes" style={{ fontSize: ".8rem", margin: ".3rem 0" }}>
            {formatBytes(state.receivedBytes)} / {formatBytes(state.totalBytes)}
            {state.status === "receiving" && state.speed > 0 ? ` · ${formatBytes(state.speed)}/s` : ""}
          </p>
        </>
      )}
      {state.status === "error" && (
        <button type="button" className="v3-btn-ghost" onClick={() => location.reload()}>
          {t("p2p.retry")}
        </button>
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
