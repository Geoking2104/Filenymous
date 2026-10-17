/** Chrome MV3 service worker. WebRTC and clipboard need a DOM: they run in offscreen.html. */
import { createMenus, setupBackground } from "./background";
import { ping } from "./ping";

let creating: Promise<void> | null = null;

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  return contexts.length > 0;
}

async function ensureHost(): Promise<void> {
  if (await hasOffscreen()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.WEB_RTC, chrome.offscreen.Reason.CLIPBOARD],
      justification: "Garder la connexion pair-à-pair (WebRTC) ouverte jusqu'au téléchargement par le destinataire, et copier le lien dans le presse-papier.",
    })
    .finally(() => {
      creating = null;
    });
  await creating;
  await ping();
}

async function closeHost(): Promise<void> {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => undefined);
}

chrome.runtime.onInstalled.addListener(createMenus);
chrome.runtime.onStartup.addListener(createMenus);
setupBackground({ ensureHost, closeHost });
