import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WallHost } from "./host";
import { EMBED_MODEL, ORT_APPROX_MB, WHISPER_MODEL, modelAvailable } from "./ai/models";

type Phase = "off" | "loading" | "on" | "error" | "unavailable";

/**
 * Host-only switch for the on-device search model. Off by default: until the
 * host opts in, wall_search ranks by keyword and nothing is downloaded.
 */
export function LocalAiTools({ host, media, canCaption = true }: { host: WallHost; media: Record<string, MediaStream>; canCaption?: boolean }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("off");
  const emb = useRef<import("./ai/embedder").LocalEmbedder | null>(null);
  useEffect(() => () => {
    host.setRanker(null);
    emb.current?.dispose();
  }, [host]);

  useEffect(() => {
    let live = true;
    void modelAvailable(EMBED_MODEL.id).then((ok) => live && !ok && setPhase((p) => (p === "off" ? "unavailable" : p)));
    void modelAvailable(WHISPER_MODEL.id).then((ok) => live && !ok && setCap((p) => (p === "off" ? "unavailable" : p)));
    return () => {
      live = false;
    };
  }, []);

  async function toggle(on: boolean) {
    if (!on) {
      host.setRanker(null);
      emb.current?.dispose();
      emb.current = null;
      return setPhase("off");
    }
    setPhase("loading");
    try {
      const { LocalEmbedder } = await import("./ai/embedder");
      const e = new LocalEmbedder();
      await e.warm();
      emb.current = e;
      host.setRanker(e);
      setPhase("on");
    } catch {
      host.setRanker(null);
      setPhase("error");
    }
  }

  // ---- live captions ----
  const [cap, setCap] = useState<Phase>("off");
  const [en, setEn] = useState(false);
  const tr = useRef<import("./ai/transcriber").Transcriber | null>(null);
  useEffect(() => () => {
    host.setCaptions(null);
    tr.current?.dispose();
  }, [host]);
  useEffect(() => {
    if (cap === "on") tr.current?.sync(media);
  }, [media, cap]);

  async function toggleCaptions(on: boolean) {
    if (!on) {
      host.setCaptions(null);
      tr.current?.dispose();
      tr.current = null;
      return setCap("off");
    }
    setCap("loading");
    try {
      const { Transcriber } = await import("./ai/transcriber");
      const x = new Transcriber((sid, text) => host.postCaption(sid, text));
      x.en = en;
      await x.warm();
      tr.current = x;
      // Participants are told before the first caption is posted.
      host.setCaptions({ en });
      x.sync(media);
      setCap("on");
    } catch {
      host.setCaptions(null);
      setCap("error");
    }
  }

  function setTranslate(v: boolean) {
    setEn(v);
    if (tr.current) tr.current.en = v;
    if (cap === "on") host.setCaptions({ en: v });
  }

  return (
    <section className="sw2-section" data-testid="wall-ai-tools">
      {canCaption && (
        <label className="sw-check sw2-agents">
          <input type="checkbox" data-testid="wall-captions-toggle" checked={cap === "on" || cap === "loading"} disabled={cap === "loading" || cap === "unavailable"} onChange={(e) => void toggleCaptions(e.target.checked)} />
          <span>
            <strong>🎙️ {t("wall.captions.toggle")}</strong>
            <small data-testid="wall-captions-state">
              {cap === "loading" ? t("wall.captions.loading") : cap === "on" ? t("wall.captions.toggleOn") : cap === "error" ? t("wall.captions.error") : cap === "unavailable" ? t("wall.captions.unavailable") : t("wall.captions.toggleOff", { mb: WHISPER_MODEL.approxMB + ORT_APPROX_MB })}
            </small>
          </span>
        </label>
      )}
      {canCaption && (
        <label className="sw-check sw2-agents">
          <input type="checkbox" data-testid="wall-captions-en" checked={en} disabled={cap === "unavailable"} onChange={(e) => setTranslate(e.target.checked)} />
          <span>
            <strong>{t("wall.captions.translate")}</strong>
            <small>{t("wall.captions.translateHint")}</small>
          </span>
        </label>
      )}
      <label className="sw-check sw2-agents">
        <input type="checkbox" data-testid="wall-semantic-toggle" checked={phase === "on" || phase === "loading"} disabled={phase === "loading" || phase === "unavailable"} onChange={(e) => void toggle(e.target.checked)} />
        <span>
          <strong>🔎 {t("wall.ai.semantic")}</strong>
          <small data-testid="wall-semantic-state">
            {phase === "loading" ? t("wall.ai.loading") : phase === "on" ? t("wall.ai.semanticOn") : phase === "error" ? t("wall.ai.error") : phase === "unavailable" ? t("wall.ai.unavailable") : t("wall.ai.semanticOff", { mb: EMBED_MODEL.approxMB + ORT_APPROX_MB })}
          </small>
        </span>
      </label>
    </section>
  );
}
