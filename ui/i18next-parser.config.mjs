/** @type {import('i18next-parser').UserConfig} */
export default {
  contextSeparator: "_",
  createOldCatalogs: false,
  defaultNamespace: "translation",
  defaultValue: (locale, _namespace, key) => {
    // Keep existing FR values; for EN leave a visible placeholder for new keys
    if (locale === "fr") return key;
    return "";
  },
  indentation: 2,
  keepRemoved: false,
  keySeparator: ".",
  locales: ["fr", "en"],
  namespaceSeparator: ":",
  output: "src/i18n/locales/$LOCALE.json",
  input: ["src/**/*.{ts,tsx}"],
  sort: true,
  verbose: true,
  failOnWarnings: false,
  failOnUpdate: false,
  lexers: {
    ts: ["JavascriptLexer"],
    tsx: [
      {
        lexer: "JsxLexer",
        functions: ["t", "i18n.t"],
        namespaceFunctions: ["useTranslation", "withTranslation"],
      },
    ],
    js: ["JavascriptLexer"],
    jsx: ["JsxLexer"],
  },
};
