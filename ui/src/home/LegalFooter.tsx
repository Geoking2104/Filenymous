import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import TermsModal, { OPEN_TERMS_EVENT } from "./TermsModal";

const SECTIONS = ["controller", "data", "audience", "terms", "erasure", "hosting"] as const;

/** Footer: the collapsible legal notice and the terms of use. */
export default function LegalFooter() {
  const { t } = useTranslation();
  const [terms, setTerms] = useState(false);
  useEffect(() => {
    const open = () => setTerms(true);
    window.addEventListener(OPEN_TERMS_EVENT, open);
    return () => window.removeEventListener(OPEN_TERMS_EVENT, open);
  }, []);
  return (
    <footer className="pz-footer">
      <div className="pz-footer-row">
        <details data-testid="legal">
          <summary>{t("pz.legal.title")}</summary>
          <dl>
            {SECTIONS.map((s) => (
              <div key={s}>
                <dt>{t(`pz.legal.${s}Title`)}</dt>
                <dd>{t(`pz.legal.${s}`)}</dd>
              </div>
            ))}
          </dl>
        </details>
        <button type="button" className="pz-link pz-terms-link" data-testid="terms-link" onClick={() => setTerms(true)}>
          {t("terms.link")}
        </button>
        <a className="pz-link" data-testid="autonymous-link" href="https://geoking2104.github.io/autonymous.me/" target="_blank" rel="noopener">
          autonymous.me
        </a>
      </div>
      {terms && <TermsModal onClose={() => setTerms(false)} />}
    </footer>
  );
}
