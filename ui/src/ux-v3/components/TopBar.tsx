import { useTranslation } from "react-i18next";
import type { AppLanguage } from "../../i18n";

interface Props {
  statusLabel?: string;
  online?: boolean;
  onBrandClick?: () => void;
  onNotifyClick?: () => void;
}

export default function TopBar({
  statusLabel,
  online = true,
  onBrandClick,
  onNotifyClick,
}: Props) {
  const { t, i18n } = useTranslation();
  const lng = (i18n.resolvedLanguage?.startsWith("en") ? "en" : "fr") as AppLanguage;

  const setLang = (next: AppLanguage) => {
    void i18n.changeLanguage(next);
  };

  return (
    <header className="v3-topbar">
      <button type="button" className="v3-brand" onClick={onBrandClick}>
        <span className="v3-brand-mark" aria-hidden="true">
          🕊
        </span>
        <span>
          <strong>Filenymous</strong>
          <small>{t("ux.brandTagline")}</small>
        </span>
      </button>
      <div className="v3-top-actions">
        <label className="v3-lang" title={t("lang.label")}>
          <span className="sr-only">{t("lang.label")}</span>
          <select
            value={lng}
            onChange={(e) => setLang(e.target.value as AppLanguage)}
            aria-label={t("lang.label")}
          >
            <option value="fr">{t("lang.fr")}</option>
            <option value="en">{t("lang.en")}</option>
          </select>
        </label>
        <span className="v3-pill">
          {online && <span className="v3-pill-dot" aria-hidden="true" />}
          {statusLabel ?? t("ux.statusReady")}
        </span>
        <button
          type="button"
          className="v3-icon-btn"
          aria-label={t("ux.notifications")}
          onClick={onNotifyClick}
        >
          🔔
        </button>
      </div>
    </header>
  );
}
