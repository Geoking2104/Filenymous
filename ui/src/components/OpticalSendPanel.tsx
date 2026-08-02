/**
 * "No network" send mode — optical screen-to-camera transfer with
 * RaptorQ fountain codes + deflate compression.
 * Self-contained: does not touch the Holochain DHT parcel flow used by the
 * rest of SendPanel. See ui/src/qrferry/ for the protocol/crypto/QR layer.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { importX25519PublicKey } from "../crypto/ecies";
import { identityZome } from "../holochain/identity";
import type { OpticalSendHandle, ThroughputStats } from "../qrferry/opticalSend";
import { getSlowerProfile, PROFILE_KEYS, PROFILES, recommendProfile, setActiveProfile, estimateTransferDuration } from "../qrferry/turbo60";
import { addHistoryEntry } from "../qrferry/history";

type Phase = "idle" | "preparing" | "running" | "error";

interface Props {
  contactHash?: string;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `~${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `~${m}m ${s}s`;
}

export default function OpticalSendPanel({ contactHash }: Props) {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [estimatedSeconds, setEstimatedSeconds] = useState(0);
  const [compressed, setCompressed] = useState(false);
  const [profileKey, setProfileKey] = useState<string>("turbo60");
  const [throughput, setThroughput] = useState<ThroughputStats | null>(null);
  const [lowThroughput, setLowThroughput] = useState(false);
  const laneARef = useRef<HTMLCanvasElement>(null);
  const laneBRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<OpticalSendHandle | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const lowThroughputCountRef = useRef(0);
  const transferStartTimeRef = useRef(0);

  // Auto-recommend profile when file changes
  useEffect(() => {
    if (file) {
      setProfileKey(recommendProfile(file.size));
    }
  }, [file]);

  async function resolveRecipientKey(): Promise<CryptoKey | undefined> {
    if (!contactHash) return undefined;
    try {
      const agent = await identityZome.getAgentForContact(contactHash);
      if (!agent) return undefined;
      const x25519B64 = await identityZome.getX25519Key(agent);
      if (!x25519B64) return undefined;
      const raw = Uint8Array.from(atob(x25519B64.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      return await importX25519PublicKey(raw);
    } catch {
      return undefined;
    }
  }

  async function handleStart() {
    if (!file) return;
    setPhase("preparing");
    setError(null);
    setThroughput(null);
    setLowThroughput(false);
    lowThroughputCountRef.current = 0;
    transferStartTimeRef.current = Date.now();
    try {
      setActiveProfile(profileKey);
      const { prepareOpticalSend } = await import("../qrferry/opticalSend");
      const recipientPublicKey = await resolveRecipientKey();
      const handle = await prepareOpticalSend({ file, recipientPublicKey });
      handleRef.current = handle;
      setEstimatedSeconds(Math.round(handle.estimatedSeconds));
      setCompressed(handle.compressed);

      // Subscribe to throughput updates with adaptive detection
      handle.onThroughput = (stats) => {
        setThroughput(stats);
        // Adaptive: detect low throughput for 6+ seconds
        if (stats.bytesPerSecond < 1000 && stats.elapsedSeconds > 3) {
          lowThroughputCountRef.current += 1;
          if (lowThroughputCountRef.current >= 6) setLowThroughput(true);
        } else {
          lowThroughputCountRef.current = 0;
        }
      };

      if (stageRef.current?.requestFullscreen) {
        await stageRef.current.requestFullscreen().catch(() => {});
      }
      const activeProfile = PROFILES[profileKey];
      const laneCount = activeProfile?.lanes ?? 2;
      if (laneARef.current && laneBRef.current) {
        if (laneCount === 1) {
          handle.start([laneARef.current, laneARef.current]);
        } else {
          handle.start([laneARef.current, laneBRef.current]);
        }
      }
      setPhase("running");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  function handleStop() {
    handleRef.current?.stop();
    handleRef.current = null;
    if (document.fullscreenElement) void document.exitFullscreen();
    // Log transfer to history
    const durationMs = Date.now() - transferStartTimeRef.current;
    if (durationMs > 2000) {
      addHistoryEntry({
        timestamp: Date.now(),
        direction: "sent",
        filename: file?.name ?? "unknown",
        fileSize: file?.size ?? 0,
        profile: profileKey,
        durationSeconds: Math.round(durationMs / 1000),
        compressed,
        success: true,
      }).catch(() => { /* best effort */ });
    }
    setPhase("idle");
    setFile(null);
    setThroughput(null);
    setLowThroughput(false);
  }

  function handleRestart() {
    handleRef.current?.stop();
    handleRef.current = null;
    if (document.fullscreenElement) void document.exitFullscreen();
    // Downgrade profile
    const slower = getSlowerProfile(profileKey);
    if (slower) setProfileKey(slower);
    setPhase("idle");
    setThroughput(null);
    setLowThroughput(false);
    lowThroughputCountRef.current = 0;
  }

  const profile = PROFILES[profileKey];
  const laneCount = profile?.lanes ?? 2;
  const recommendedProfile = file ? recommendProfile(file.size) : null;
  const isAutoRecommended = recommendedProfile === profileKey;

  return (
    <div className="card" style={{ padding: "1rem" }}>
      <p style={{ color: "var(--muted)", marginBottom: ".8rem" }}>{t("optical.sendIntro")}</p>

      {phase === "idle" && (
        <>
          <input
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            style={{ marginBottom: ".8rem" }}
          />

          <div style={{ marginBottom: ".8rem" }}>
            <label className="form-label" style={{ marginBottom: ".3rem", display: "block" }}>{t("optical.profile")}</label>
            <div style={{ display: "flex", gap: ".4rem", flexWrap: "wrap" }}>
              {PROFILE_KEYS.map((key) => {
                const p = PROFILES[key];
                const isRecommended = key === recommendedProfile;
                const est = file ? estimateTransferDuration(file.size, key) : null;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setProfileKey(key)}
                    style={{
                      padding: ".35rem .7rem",
                      borderRadius: "8px",
                      fontSize: ".78rem",
                      fontWeight: 600,
                      border: profileKey === key ? "1.5px solid var(--g1)" : "1px solid var(--border)",
                      background: profileKey === key ? "rgba(34,211,238,.1)" : "rgba(255,255,255,.04)",
                      color: profileKey === key ? "var(--g1)" : "var(--muted)",
                      cursor: "pointer",
                      position: "relative",
                    }}
                  >
                    {p.label}
                    {isRecommended && (
                      <span style={{ fontSize: ".6rem", marginLeft: ".3rem", opacity: 0.7 }}>★</span>
                    )}
                    {est !== null && (
                      <span style={{ display: "block", fontSize: ".6rem", fontWeight: 400, opacity: 0.7 }}>
                        {fmtDuration(est)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {profile && (
              <div style={{ fontSize: ".72rem", color: "var(--muted)", marginTop: ".3rem" }}>
                {t("optical.profileDetail", {
                  lanes: laneCount,
                  fps: profile.laneFps * laneCount,
                  ecc: profile.eccLevel,
                })}
                {isAutoRecommended && (
                  <span style={{ color: "var(--g1)", marginLeft: ".4rem" }}>✓ {t("optical.autoRecommended")}</span>
                )}
              </div>
            )}
          </div>

          {file && file.size > 5 * 1024 * 1024 && (
            <div className="warn-box" style={{ marginBottom: ".8rem" }}>{t("optical.sizeWarning")}</div>
          )}
          <button type="button" className="btn-primary" disabled={!file} onClick={handleStart}>
            {t("optical.start")}
          </button>
        </>
      )}

      {phase === "preparing" && (
        <div style={{ textAlign: "center", padding: "1rem 0" }}>
          <p>{t("send.progressAes")}</p>
          <p style={{ fontSize: ".8rem", color: "var(--muted)", marginTop: ".3rem" }}>{t("optical.encoding")}</p>
        </div>
      )}

      {error && (
        <div>
          <div className="warn-box">{error}</div>
          <button
            type="button"
            onClick={() => { setError(null); setPhase("idle"); }}
            className="btn-primary"
            style={{ marginTop: ".6rem" }}
          >
            {t("common.retry")}
          </button>
        </div>
      )}

      <div
        ref={stageRef}
        style={{
          display: phase === "running" ? "flex" : "none",
          position: "fixed",
          inset: 0,
          background: "#000",
          zIndex: 999,
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
        }}
      >
        <p style={{ color: "#34d399", fontSize: ".9rem" }}>{t("optical.waitingScan")}</p>
        <div style={{ display: "flex", gap: "1rem" }}>
          <canvas
            ref={laneARef}
            style={{
              width: laneCount === 1 ? "80vw" : "42vw",
              maxWidth: laneCount === 1 ? 500 : 320,
              height: "auto",
              imageRendering: "pixelated",
              display: laneCount >= 1 ? "block" : "none",
            }}
          />
          {laneCount >= 2 && (
            <canvas
              ref={laneBRef}
              style={{ width: "42vw", maxWidth: 320, height: "auto", imageRendering: "pixelated" }}
            />
          )}
        </div>

        {/* Throughput stats */}
        {throughput && (
          <div style={{
            display: "flex",
            gap: "1.5rem",
            fontSize: ".75rem",
            color: "#a1a1aa",
          }}>
            <span>{t("optical.throughput")}: <strong style={{ color: "#34d399" }}>{fmtBytes(throughput.bytesPerSecond)}/s</strong></span>
            <span>{throughput.symbolsPerSecond} img/s</span>
            <span>{throughput.elapsedSeconds}s</span>
          </div>
        )}

        <p style={{ color: "#a1a1aa", fontSize: ".8rem" }}>
          {t("optical.estTime", { seconds: estimatedSeconds })}
          {compressed && <span style={{ color: "#34d399", marginLeft: ".5rem" }}>✓ {t("optical.compressed")}</span>}
        </p>

        {lowThroughput && (
          <div style={{
            background: "rgba(239,68,68,.15)",
            border: "1px solid rgba(239,68,68,.3)",
            borderRadius: 8,
            padding: ".5rem .8rem",
            fontSize: ".78rem",
            color: "#fca5a5",
            textAlign: "center",
          }}>
            {t("optical.lowThroughput")}
            <button
              type="button"
              onClick={handleRestart}
              style={{
                marginLeft: ".8rem",
                padding: ".3rem .8rem",
                background: "rgba(239,68,68,.2)",
                border: "1px solid rgba(239,68,68,.4)",
                borderRadius: 6,
                color: "#fca5a5",
                cursor: "pointer",
                fontSize: ".75rem",
              }}
            >
              {t("optical.restartSlower")}
            </button>
          </div>
        )}

        <div style={{ display: "flex", gap: ".6rem" }}>
          <button type="button" onClick={handleStop} style={{ padding: ".7rem 2rem" }}>
            {t("optical.stop")}
          </button>
        </div>
      </div>
    </div>
  );
}
