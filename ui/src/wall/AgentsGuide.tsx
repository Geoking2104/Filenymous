/**
 * AgentsGuide: interactive 3-step didacticiel for integrating AI agents into a Sharewall.
 * Helps users understand how to connect agents (CLI / MCP) and what benefits to expect.
 * Opened from the side panel or create form. Content is fully i18n.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";

interface AgentsGuideProps {
  open: boolean;
  onClose: () => void;
  /** Current invite link, if available (host). Used in step 2 copy examples. */
  inviteLink?: string;
  /** Whether agents are currently allowed. */
  agentsAllowed?: boolean;
}

export function AgentsGuide({ open, onClose, inviteLink, agentsAllowed }: AgentsGuideProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState(1);
  const [copied, setCopied] = useState<string | null>(null);

  if (!open) return null;

  const copy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      /* ignore */
    }
  };

  const linkPlaceholder = inviteLink || "https://filenymous.eu/app/#wall:…";

  const cliCmd = `npx filenymous wall join "${linkPlaceholder}" --name "Mon agent"`;
  const mcpConfig = `{
  "mcpServers": {
    "sharewall": {
      "command": "npx",
      "args": ["-y", "filenymous@0.4.4", "wall", "mcp", "${linkPlaceholder}", "--name", "Claude"],
      "env": { "FILENYMOUS_PASSWORD": "" }
    }
  }
}`;

  const steps = [
    {
      title: t("wall.agents.guide.step1Title"),
      body: (
        <>
          <p>{t("wall.agents.guide.step1Body")}</p>
          <p className="sw-small">
            {agentsAllowed ? t("wall.agents.guide.alreadyOn") : t("wall.agents.guide.needEnable")}
          </p>
          <p className="sw-warn">⚠️ {t("wall.agents.guide.warning")}</p>
        </>
      ),
    },
    {
      title: t("wall.agents.guide.step2Title"),
      body: (
        <>
          <p>{t("wall.agents.guide.step2Body")}</p>
          <h4>{t("wall.agents.guide.cliTitle")}</h4>
          <pre className="sw-code">{cliCmd}</pre>
          <button type="button" className="pz-btn pz-btn-ghost" onClick={() => copy(cliCmd, "cli")}>
            {copied === "cli" ? t("common.copied") : t("common.copy")}
          </button>
          <h4>{t("wall.agents.guide.mcpTitle")}</h4>
          <pre className="sw-code">{mcpConfig}</pre>
          <button type="button" className="pz-btn pz-btn-ghost" onClick={() => copy(mcpConfig, "mcp")}>
            {copied === "mcp" ? t("common.copied") : t("common.copy")}
          </button>
          <p className="sw-small">{t("wall.agents.guide.mcpHint")}</p>
        </>
      ),
    },
    {
      title: t("wall.agents.guide.step3Title"),
      body: (
        <>
          <p>{t("wall.agents.guide.step3Body")}</p>
          <ul>
            <li><strong>{t("wall.agents.guide.prioHigh")}</strong> — {t("wall.agents.guide.prioHighDesc")}</li>
            <li><strong>{t("wall.agents.guide.prioMed")}</strong> — {t("wall.agents.guide.prioMedDesc")}</li>
            <li><strong>{t("wall.agents.guide.prioLow")}</strong> — {t("wall.agents.guide.prioLowDesc")}</li>
          </ul>
          <p><strong>{t("wall.agents.guide.resultsTitle")}</strong> {t("wall.agents.guide.results")}</p>
          <p className="sw-small">{t("wall.agents.guide.control")}</p>
        </>
      ),
    },
  ];

  const current = steps[step - 1];

  return (
    <div className="sw-modal" role="dialog" aria-modal="true" aria-labelledby="agents-guide-title" data-testid="wall-agents-guide" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sw-modal-card sw-guide">
        <div className="sw-modal-head">
          <strong id="agents-guide-title">🤖 {t("wall.agents.guide.title")} — {step}/3</strong>
          <button type="button" className="sw-x" aria-label={t("common.close")} onClick={onClose}>✕</button>
        </div>
        <div className="sw-modal-body">
          <h3>{current.title}</h3>
          {current.body}
        </div>
        <div className="sw-guide-nav">
          {step > 1 && (
            <button type="button" className="pz-btn pz-btn-ghost" onClick={() => setStep(step - 1)}>
              ← {t("common.back") || "Précédent"}
            </button>
          )}
          {step < 3 ? (
            <button type="button" className="pz-btn" onClick={() => setStep(step + 1)}>
              {t("common.continue")} →
            </button>
          ) : (
            <button type="button" className="pz-btn" onClick={onClose}>
              {t("common.close")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
