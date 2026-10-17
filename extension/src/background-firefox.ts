/**
 * Firefox persistent background page (Manifest V2): WebRTC and the clipboard
 * are available here, so the host runs in the same page as the menus.
 */
import { createMenus, setupBackground } from "./background";
import { startHost } from "./host";

let onEvent: (ev: Parameters<ReturnType<typeof setupBackground>["onEvent"]>[0]) => void = () => undefined;
startHost((ev) => onEvent(ev));
const bg = setupBackground({ ensureHost: async () => undefined, closeHost: async () => undefined });
onEvent = bg.onEvent;
createMenus();
