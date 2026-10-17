import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import fr from "./locales/fr.json";
import en from "./locales/en.json";

export const supportedLngs = ["fr", "en"] as const;
export type AppLanguage = (typeof supportedLngs)[number];

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      fr: { translation: fr },
      en: { translation: en },
    },
    fallbackLng: "fr",
    supportedLngs: [...supportedLngs],
    // "en-US", "en-GB"… → "en" (without this every regional English browser fell back to French).
    nonExplicitSupportedLngs: true,
    load: "languageOnly",
    interpolation: { escapeValue: false },
    detection: {
      // ?lang=en|fr first: shareable/hreflang URLs (the query string is never sent to analytics).
      order: ["querystring", "localStorage", "navigator", "htmlTag"],
      lookupQuerystring: "lang",
      caches: ["localStorage"],
      lookupLocalStorage: "filenymous.lng",
      convertDetectedLanguage: (lng: string) => lng.split("-")[0].toLowerCase(),
    },
  });

i18n.on("languageChanged", (lng) => {
  document.documentElement.lang = lng;
});
// The first detection happens during init(), before the listener above exists.
if (typeof document !== "undefined" && i18n.resolvedLanguage) document.documentElement.lang = i18n.resolvedLanguage;

export default i18n;
