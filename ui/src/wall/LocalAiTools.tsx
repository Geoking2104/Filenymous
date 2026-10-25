import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WallHost } from "./host";
import { EMBED_MODEL, ORT_APPROX_MB, modelAvailable } from "./ai/models";

type Phase = "off" | "loading" | "on" | "error" | "unavailable";

/**
 * Host-only switch for the on-device search model. Off by default: until the
 * host opts in, wall_search ranks by keyword and nothing is downloaded.
 */
export function LocalAiTools({ host }: { host: WallHost }) {
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

  return (
    <section className="sw2-section" data-testid="wall-ai-tools">
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
