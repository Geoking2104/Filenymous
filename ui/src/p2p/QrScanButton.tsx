import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface Props {
  onResult: (text: string) => void;
}

/**
 * Scan-to-receive: reuses the camera + zxing-wasm scanner of the optical
 * transfer feature (lazy-loaded, so the main bundle is unchanged).
 */
export default function QrScanButton({ onResult }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  useEffect(() => {
    if (!open) return;
    let stream: MediaStream | null = null;
    let stopped = false;
    const canvas = document.createElement("canvas");
    (async () => {
      try {
        const [{ openRearCamera }, { scanOpticalFrames }] = await Promise.all([
          import("../qrferry/opticalReceive"),
          import("../qrferry/qr"),
        ]);
        const video = videoRef.current!;
        stream = await openRearCamera(video);
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        while (!stopped) {
          if (video.videoWidth) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0);
            const found = await scanOpticalFrames(ctx.getImageData(0, 0, canvas.width, canvas.height), 1);
            if (found[0]) {
              const text = new TextDecoder().decode(found[0]);
              stopped = true;
              setOpen(false);
              onResultRef.current(text);
              break;
            }
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch (e) {
        setError(String((e as Error).message || e));
      }
    })();
    return () => {
      stopped = true;
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [open]);

  return (
    <div style={{ marginTop: ".8rem" }}>
      <button type="button" className="v3-btn-ghost" onClick={() => { setError(""); setOpen((v) => !v); }}>
        {open ? t("p2p.scanStop") : t("p2p.scanQr")}
      </button>
      {open && (
        <video ref={videoRef} playsInline muted style={{ width: "100%", maxWidth: 360, borderRadius: 12, marginTop: ".6rem" }} />
      )}
      {error && <div className="v3-warn">{t("p2p.scanError", { message: error })}</div>}
    </div>
  );
}
