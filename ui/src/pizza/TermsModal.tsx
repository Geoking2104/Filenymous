import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

export const OPEN_TERMS_EVENT = "filenymous:open-terms";
export const openTerms = () => window.dispatchEvent(new Event(OPEN_TERMS_EVENT));

const CARDS = [
  { id: "direct", icon: "🔗" },
  { id: "rights", icon: "©️" },
  { id: "known", icon: "👥" },
  { id: "illegal", icon: "🚫" },
] as const;

/** FilePizza-style terms of use dialog. */
export default function TermsModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    btn.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="pz-modal-backdrop" onClick={onClose}>
      <div className="pz-modal" role="dialog" aria-modal="true" aria-labelledby="pz-terms-title" data-testid="terms-modal" onClick={(e) => e.stopPropagation()}>
        <h2 id="pz-terms-title">{t("terms.title")}</h2>
        <div className="pz-terms-grid">
          {CARDS.map((c) => (
            <div className="pz-term" key={c.id} data-testid={`term-${c.id}`}>
              <span className="pz-term-icon" aria-hidden="true">{c.icon}</span>
              <p>{t(`terms.${c.id}`)}</p>
            </div>
          ))}
        </div>
        <p className="pz-terms-accept"><em>{t("terms.accept")}</em></p>
        <button ref={btn} type="button" className="pz-btn" onClick={onClose} data-testid="terms-ok">
          {t("terms.ok")}
        </button>
      </div>
    </div>
  );
}
