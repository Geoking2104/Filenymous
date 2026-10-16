import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatRemaining } from "./expiry";

/** "Expire dans 23 h 05 min · le 17/10 à 18:00", refreshed every second. */
export default function ExpiryCountdown({ expires, testId = "expiry-countdown" }: { expires: number; testId?: string }) {
  const { t, i18n } = useTranslation();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const lang = i18n.resolvedLanguage?.startsWith("en") ? "en" : "fr";
  const left = expires * 1000 - now;
  const date = new Date(expires * 1000).toLocaleString(lang === "fr" ? "fr-FR" : "en-GB", { dateStyle: "medium", timeStyle: "short" });
  return (
    <p className={`pz-expiry${left < 3_600_000 ? " is-soon" : ""}`} data-testid={testId} data-expires={expires} role="timer" aria-live="off">
      ⏳ {left > 0 ? t("expiry.in", { left: formatRemaining(left, lang) }) : t("expiry.expired")} <span className="pz-expiry-date">· {date}</span>
    </p>
  );
}
