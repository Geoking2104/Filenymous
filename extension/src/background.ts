/**
 * Background logic shared by Chrome (service worker) and Firefox (persistent
 * background page): context menus, notifications, badge, permission prompts.
 * Shares themselves live in the host (see host.ts).
 */
import { E2E, IS_FIREFOX, actionApi, ext } from "./env";
import { originPattern } from "./fetchTarget";
import { FETCH_ERRORS } from "./labels";
import type { BgEvent, BgRequest, HostReply, HostRequest, TargetKind } from "./messages";
import { hostCall } from "./rpc";

export interface HostBridge {
  ensureHost(): Promise<void>;
  closeHost(): Promise<void>;
}

export const MENU = {
  selection: "fn-selection",
  image: "fn-image",
  media: "fn-media",
  link: "fn-link",
  linkSecret: "fn-link-secret",
} as const;

export function createMenus(): void {
  const menus = ext.contextMenus;
  void Promise.resolve(menus.removeAll()).then(() => {
    menus.create({ id: MENU.selection, title: "Partager la sélection en lien secret (Filenymous)", contexts: ["selection"] });
    menus.create({ id: MENU.image, title: "Envoyer cette image en direct (Filenymous)", contexts: ["image"] });
    menus.create({ id: MENU.media, title: "Envoyer cette vidéo / ce son en direct (Filenymous)", contexts: ["video", "audio"] });
    menus.create({ id: MENU.link, title: "Envoyer le fichier de ce lien en direct (Filenymous)", contexts: ["link"] });
    menus.create({ id: MENU.linkSecret, title: "Partager l'adresse de ce lien en secret (Filenymous)", contexts: ["link"] });
  });
}

/** Runs in the page: the selection, including inside a text field (keeps line breaks). */
function pageSelection(): string {
  const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  if (el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && /^(text|search|url|tel|email|password)$/i.test(el.type)))) {
    const a = el.selectionStart;
    const b = el.selectionEnd;
    if (a !== null && b !== null && b > a) return el.value.slice(a, b);
  }
  return String(window.getSelection?.() ?? "");
}

async function readSelection(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<string> {
  if (tab?.id !== undefined && tab.id >= 0) {
    try {
      if (IS_FIREFOX) {
        const [r] = (await (ext.tabs as unknown as { executeScript(id: number, d: object): Promise<unknown[]> }).executeScript(tab.id, {
          frameId: info.frameId ?? 0,
          code: `(${pageSelection.toString()})()`,
        })) as string[];
        if (r && r.trim()) return r;
      } else {
        const [r] = await ext.scripting.executeScript({ target: { tabId: tab.id, frameIds: [info.frameId ?? 0] }, func: pageSelection });
        if (typeof r?.result === "string" && r.result.trim()) return r.result;
      }
    } catch {
      /* PDF viewer, store pages…: fall back to the menu's selectionText */
    }
  }
  return info.selectionText ?? "";
}

export function notify(title: string, message: string): void {
  void Promise.resolve(ext.notifications.create({ type: "basic", iconUrl: ext.runtime.getURL("icons/icon-128.png"), title, message })).catch(() => undefined);
}

function setBadge(text: string, color: string) {
  const a = actionApi();
  const quiet = (p: unknown) => void Promise.resolve(p).catch(() => undefined);
  quiet(a.setBadgeText({ text }));
  if (text) quiet(a.setBadgeBackgroundColor({ color }));
}

async function askPermission(origin: string, url: string, kind: TargetKind) {
  const granted = await ext.permissions.contains({ origins: [originPattern(origin)] }).catch(() => false);
  if (granted) {
    notify("Échec du partage", `${FETCH_ERRORS.blocked} (${new URL(origin).hostname})`);
    return;
  }
  const q = new URLSearchParams({ origin, url, kind });
  await ext.windows.create({ url: ext.runtime.getURL(`grant.html?${q}`), type: "popup", width: 460, height: 340 });
}

export function setupBackground(bridge: HostBridge): {
  onEvent(ev: BgEvent): void;
  onMenu(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<HostReply>;
} {
  async function call(req: HostRequest): Promise<HostReply> {
    await bridge.ensureHost();
    return hostCall(req, 10 * 60_000);
  }

  async function onMenu(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<HostReply> {
    switch (info.menuItemId) {
      case MENU.selection:
        return call({ type: "share-text", text: await readSelection(info, tab), source: "menu" });
      case MENU.linkSecret:
        return call({ type: "share-text", text: info.linkUrl ?? "", source: "menu" });
      case MENU.image:
        return call({ type: "share-url", url: info.srcUrl ?? "", kind: "image", source: "menu" });
      case MENU.media:
        return call({ type: "share-url", url: info.srcUrl ?? "", kind: "media", source: "menu" });
      case MENU.link:
        return call({ type: "share-url", url: info.linkUrl ?? "", kind: "link", source: "menu" });
      default:
        return { ok: false, error: "unknown", message: "Menu inconnu." };
    }
  }

  function onEvent(ev: BgEvent) {
    switch (ev.type) {
      case "notify":
        notify(ev.title, ev.message);
        break;
      case "badge":
        setBadge(ev.text, ev.color);
        break;
      case "need-permission":
        void askPermission(ev.origin, ev.url, ev.kind);
        break;
      case "idle":
        void bridge.closeHost();
        break;
    }
  }

  ext.contextMenus.onClicked.addListener((info, tab) => {
    void onMenu(info, tab);
  });

  ext.runtime.onMessage.addListener((msg: BgRequest, _sender, sendResponse) => {
    if (!msg || msg.target !== "bg") return false;
    if (msg.type === "event") {
      onEvent(msg.event);
      return false;
    }
    if (msg.type === "ensure-host") {
      bridge.ensureHost().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, message: String(e?.message || e) }));
      return true;
    }
    if (msg.type === "share-url") {
      // From grant.html, once the user allowed the site.
      void call({ type: "share-url", url: msg.url, kind: msg.kind, source: "menu" });
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  if (E2E) (globalThis as Record<string, unknown>).__fnTest = { onMenu, call };
  return { onEvent, onMenu };
}
