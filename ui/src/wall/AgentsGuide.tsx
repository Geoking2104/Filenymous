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
  const [revealed, setRevealed] = useState(false);

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

  // The real invite link carries the wall key: mask it by default (screenshots,
  // screen sharing); copy buttons always copy the real link.
  const masked = `<${t("wall.agents.guide.linkPlaceholder")}>`;
  const realLink = inviteLink || masked;
  const shownLink = inviteLink && revealed ? inviteLink : masked;
  const cliFor = (link: string) => `npx filenymous wall join "${link}" --name "Mon agent"`;
  const mcpFor = (link: string) => `{
  "mcpServers": {
    "sharewall": {
      "command": "npx",
      "args": ["-y", "filenymous@0.4.4", "wall", "mcp", "${link}", "--name", "Claude"],
      "env": { "FILENYMOUS_PASSWORD": "" }
    }
  }
}`;
  const cliCmd = cliFor(shownLink);
  const mcpConfig = mcpFor(shownLink);
  const linkTools = inviteLink ? (
    <p className="sw-guide-link">
      <button type="button" className="pz-btn pz-btn-ghost" data-testid="wall-agents-guide-reveal" aria-pressed={revealed} onClick={() => setRevealed((r) => !r)}>
        {revealed ? t("wall.agents.guide.hideLink") : t("wall.agents.guide.showLink")}
      </button>
      <button type="button" className="pz-btn pz-btn-ghost" data-testid="wall-agents-guide-copy-link" onClick={() => copy(inviteLink, "link")}>
        {copied === "link" ? t("common.copied") : t("wall.agents.guide.copyLink")}
      </button>
    </p>
  ) : null;

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
          {linkTools}
          <h4>{t("wall.agents.guide.cliTitle")}</h4>
          <pre className="sw-code" data-testid="wall-agents-guide-cli">{cliCmd}</pre>
          <button type="button" className="pz-btn pz-btn-ghost" onClick={() => copy(cliFor(realLink), "cli")}>
            {copied === "cli" ? t("common.copied") : t("common.copy")}
          </button>
          <h4>{t("wall.agents.guide.mcpTitle")}</h4>
          <pre className="sw-code" data-testid="wall-agents-guide-mcp">{mcpConfig}</pre>
          <button type="button" className="pz-btn pz-btn-ghost" onClick={() => copy(mcpFor(realLink), "mcp")}>
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
