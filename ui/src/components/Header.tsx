import { useTranslation } from "react-i18next";
import { useStore } from "../store/useStore";
import type { Tab } from "../store/useStore";
import type { AppLanguage } from "../i18n";
import NotificationCenter from "./NotificationCenter";

interface HeaderProps {
  minimal?: boolean;
}

const tabIds: Array<{ id: Tab; icon: string; labelKey: string; shortKey: string }> = [
  { id: "send", icon: "up", labelKey: "tabs.send", shortKey: "tabs.sendShort" },
  { id: "receive", icon: "down", labelKey: "tabs.receive", shortKey: "tabs.receiveShort" },
  { id: "rooms", icon: "room", labelKey: "tabs.rooms", shortKey: "tabs.roomsShort" },
  { id: "contacts", icon: "contacts", labelKey: "tabs.contacts", shortKey: "tabs.contactsShort" },
  { id: "identity", icon: "id", labelKey: "tabs.identity", shortKey: "tabs.identityShort" },
  { id: "history", icon: "list", labelKey: "tabs.history", shortKey: "tabs.historyShort" },
  { id: "advanced", icon: "gear", labelKey: "tabs.advanced", shortKey: "tabs.advancedShort" },
];

function modeLabel(mode: string, t: (k: string) => string): string {
  if (mode === "holo-web") return t("net.holoWeb");
  if (mode === "websocket") return t("net.websocket");
  if (mode === "web-bridge") return t("net.webBridge");
  if (mode === "local-only") return t("net.localOnly");
  return t("net.checking");
}

function PigeonLogo() {
  return (
    <svg width="38" height="38" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <ellipse cx="14.5" cy="17" rx="5.2" ry="4.2" transform="rotate(-8 14.5 17)" fill="white"/>
      <circle cx="21" cy="12.8" r="3.4" fill="white"/>
      <path d="M24 12.5 L27.5 13.8 L24 14.8 Z" fill="#f59e0b"/>
      <circle cx="22.3" cy="12.2" r="1.1" fill="#0f172a"/>
      <circle cx="22.6" cy="11.9" r="0.35" fill="white"/>
      <path d="M9 14 Q6 8 11 7.5 Q15 9 14 14" fill="#22d3ee"/>
      <path d="M9.5 14.5 Q7 10 11 9.5" stroke="white" strokeWidth="1.6" strokeLinecap="round"/>
      <rect x="11.5" y="17.5" width="3.2" height="2.8" rx="0.6" fill="#bae6fd"/>
      <path d="M12 17.5 L12 16.8 Q13.1 16.3 14.5 16.8 L14.5 17.5" fill="none" stroke="#22d3ee" strokeWidth="0.8"/>
      <path d="M9 19.5 L5 21.5 L6 23 L9.5 21.8 Z" fill="white"/>
    </svg>
  );
}

export default function Header({ minimal = false }: HeaderProps) {
  const { t, i18n } = useTranslation();
  const { tab, setTab, net } = useStore();
  const lng = (i18n.resolvedLanguage?.startsWith("en") ? "en" : "fr") as AppLanguage;

  const setLang = (next: AppLanguage) => {
    void i18n.changeLanguage(next);
  };

  return (
    <>
      <header className="site-header">
        <div className="header-inner">
          <button className="brand" type="button" onClick={() => setTab("send")} aria-label={t("tabs.send")}>
            <span className="brand-mark">
              <PigeonLogo />
            </span>
            <span>
              <strong>Filenymous</strong>
              <small>{t("app.tagline")}</small>
            </span>
          </button>

          <div className="header-right">
            {!minimal && <NotificationCenter />}
            <label className="lang-switch" title={t("lang.label")}>
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
            <span className={`net-pill ${net.connected ? "is-online" : ""}`}>
              <span aria-hidden="true" />
              {modeLabel(net.mode, t)}
            </span>
          </div>
        </div>

        {!minimal && (
          <nav className="top-tabs top-tabs-desktop" aria-label={t("app.navAria")}>
            {tabIds.map(({ id, labelKey, icon }) => (
              <button
                key={id}
                type="button"
                className={tab === id ? "active" : ""}
                onClick={() => setTab(id)}
                aria-current={tab === id ? "page" : undefined}
              >
                <span className="tab-icon" data-icon={icon} aria-hidden="true" />
                <span>{t(labelKey)}</span>
              </button>
            ))}
          </nav>
        )}
      </header>

      {!minimal && (
        <nav className="bottom-tabs" aria-label={t("app.navAriaMobile")}>
          {tabIds.map(({ id, shortKey, icon }) => (
            <button
              key={id}
              type="button"
              className={tab === id ? "active" : ""}
              onClick={() => setTab(id)}
              aria-current={tab === id ? "page" : undefined}
            >
              <span className="tab-icon" data-icon={icon} aria-hidden="true" />
              <span className="bottom-tab-label">{t(shortKey)}</span>
            </button>
          ))}
        </nav>
      )}
    </>
  );
}
