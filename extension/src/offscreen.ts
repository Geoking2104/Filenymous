/** Chrome offscreen document: hosts the shares (WebRTC) and copies links (execCommand). */
import { startHost } from "./host";

startHost((event) => {
  void chrome.runtime.sendMessage({ target: "bg", type: "event", event }).catch(() => undefined);
});
