/**
 * "No network" receive mode — optical screen-to-camera transfer.
 * See ui/src/qrferry/ for the protocol/crypto/QR layer.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OpticalReceiver } from "../qrferry/opticalReceive";
import { addHistoryEntry } from "../qrferry/history";

type Phase = "idle" | "scanning" | "decrypting" | "done" | "error";

export default function OpticalReceivePanel() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState({ solved: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; filename: string } | null>(null);
  const [notified, setNotified] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const receiverRef = useRef<OpticalReceiver | null>(null);
  const rafRef = useRef(0);
  const transferStartTimeRef = useRef(0);

  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
  }, []);

  function handleRetry() {
    setPhase("idle");
    setError(null);
    setResult(null);
    setNotified(false);
    setProgress({ solved: 0, total: 0 });
  }

  async function handleOpenCamera() {
    setError(null);
    setNotified(false);
    transferStartTimeRef.current = Date.now();
    try {
      const { OpticalReceiver, openRearCamera } = await import("../qrferry/opticalReceive");
      if (!videoRef.current) return;
      const stream = await openRearCamera(videoRef.current);
      streamRef.current = stream;
      const receiver = new OpticalReceiver();
      receiverRef.current = receiver;
      setPhase("scanning");

      const loop = async () => {
        if (!videoRef.current || !receiverRef.current) return;
        await receiverRef.current.ingestVideoFrame(
          videoRef.current,
          (solved, total) => setProgress({ solved, total }),
          () => setNotified(true),
        );
        if (receiverRef.current.isComplete) {
          setPhase("decrypting");
          streamRef.current?.getTracks().forEach((tr) => tr.stop());
          try {
            const finished = await receiverRef.current.finish();
            const url = URL.createObjectURL(finished.file);
            setResult({ url, filename: finished.filename });
            // Log successful receive to history
            const durationMs = Date.now() - transferStartTimeRef.current;
            addHistoryEntry({
              timestamp: Date.now(),
              direction: "received",
              filename: finished.filename,
              fileSize: finished.file.size,
              profile: "optical",
              durationSeconds: Math.round(durationMs / 1000),
              compressed: false,
              success: true,
            }).catch(() => { /* best effort */ });
            setPhase("done");
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setPhase("error");
          }
          return;
        }
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  return (
    <div className="card" style={{ padding: "1rem" }}>
      <p style={{ color: "var(--muted)", marginBottom: ".6rem" }}>{t("optical.receiveIntro")}</p>

      {phase === "idle" && (
        <>
          <p style={{ fontSize: ".85rem", color: "var(--muted)", marginBottom: ".8rem" }}>{t("optical.grantCamera")}</p>
          <button type="button" className="btn-primary" onClick={handleOpenCamera}>
            {t("optical.openCamera")}
          </button>
        </>
      )}

      {error && (
        <div>
          <div className="warn-box">{error}</div>
          <button
            type="button"
            onClick={handleRetry}
            className="btn-primary"
            style={{ marginTop: ".6rem" }}
          >
            {t("common.retry")}
          </button>
        </div>
      )}

      <div style={{ display: phase === "scanning" || phase === "decrypting" ? "block" : "none" }}>
        <p style={{ fontSize: ".8rem", color: "var(--muted)", marginBottom: ".6rem" }}>{t("optical.scanTip")}</p>
        <video ref={videoRef} playsInline muted style={{ width: "100%", borderRadius: 12, background: "#000" }} />
        {phase === "scanning" && (
          <div className="progress-bar" style={{ marginTop: ".6rem" }}>
            <div
              className="progress-fill"
              style={{ width: `${progress.total ? (progress.solved / progress.total) * 100 : 0}%` }}
            />
          </div>
        )}
        <p style={{ fontSize: ".8rem", color: "var(--muted)" }}>
          {phase === "decrypting" ? t("optical.decrypting") : t("optical.progress", progress)}
        </p>
        {notified && phase === "scanning" && (
          <p style={{ fontSize: ".75rem", color: "#34d399", marginTop: ".3rem" }}>
            ✓ {t("optical.transferComplete")}
          </p>
        )}
      </div>

      {phase === "done" && result && (
        <div style={{ textAlign: "center" }}>
          <p style={{ color: "#34d399", fontWeight: 600 }}>✓ {t("optical.saved")}</p>
          <a className="btn-primary" href={result.url} download={result.filename} style={{ display: "inline-block", marginTop: ".6rem" }}>
            {t("optical.saveFile")}
          </a>
          <button
            type="button"
            onClick={handleRetry}
            style={{
              display: "block",
              margin: ".6rem auto 0",
              padding: ".4rem 1rem",
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 8,
              color: "var(--muted)",
              cursor: "pointer",
              fontSize: ".8rem",
            }}
          >
            {t("optical.receiveAnother")}
          </button>
        </div>
      )}
    </div>
  );
}
