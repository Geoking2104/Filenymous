/** Build-time configuration (see build.mjs) and the WebExtension namespace. */
declare const __APP_URL__: string;
declare const __SIGNAL_URL__: string;
declare const __BROWSER__: "chrome" | "firefox";
declare const __VERSION__: string;
declare const __E2E__: boolean;

export const APP_URL: string = __APP_URL__;
export const SIGNAL_URL: string = __SIGNAL_URL__;
export const BROWSER: "chrome" | "firefox" = __BROWSER__;
export const IS_FIREFOX = BROWSER === "firefox";
export const VERSION: string = __VERSION__;
export const E2E: boolean = __E2E__;

/** `browser.*` (promises) on Firefox, `chrome.*` (promises in MV3) on Chrome. */
export const ext: typeof chrome = (globalThis as { browser?: typeof chrome }).browser ?? (globalThis as { chrome: typeof chrome }).chrome;

/** Firefox MV2 has `browserAction`, MV3 has `action`. */
export function actionApi(): typeof chrome.action {
  return (ext as unknown as { action?: typeof chrome.action; browserAction?: typeof chrome.action }).action
    ?? (ext as unknown as { browserAction: typeof chrome.action }).browserAction;
}

export function vaultHttpBase(signalUrl = SIGNAL_URL): string {
  return signalUrl.replace(/^ws(s?):\/\//, "http$1://").replace(/\/+$/, "");
}

/** Points the web app's own P2P and Vault modules (ui/src) at the configured relay. */
export function installEndpoints(): void {
  const g = globalThis as Record<string, unknown>;
  g.__FILENYMOUS_SIGNAL_URL__ = SIGNAL_URL;
  g.__FILENYMOUS_VAULT_URL__ = vaultHttpBase();
}
