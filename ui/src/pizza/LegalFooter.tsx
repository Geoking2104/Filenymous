import { useTranslation } from "react-i18next";

const SECTIONS = ["controller", "data", "erasure", "hosting"] as const;

/** Footer: only the collapsible legal notice. */
export default function LegalFooter() {
  const { t } = useTranslation();
  return (
    <footer className="pz-footer">
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
    </footer>
  );
}
