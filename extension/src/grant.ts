/** Asks for access to one site, from a click (permissions.request needs a user gesture). */
import { ext } from "./env";
import { originPattern, targetOrigin } from "./fetchTarget";
import type { TargetKind } from "./messages";

const q = new URLSearchParams(location.search);
const url = q.get("url") ?? "";
const kind = (q.get("kind") ?? "link") as TargetKind;
const origin = targetOrigin(url) ?? "";
const site = document.getElementById("site")!;
site.textContent = origin ? new URL(origin).hostname : "ce site";
const msg = document.getElementById("message")!;
const allow = document.getElementById("allow") as HTMLButtonElement;
allow.disabled = !origin;

allow.addEventListener("click", async () => {
  try {
    const ok = await ext.permissions.request({ origins: [originPattern(origin)] });
    if (!ok) {
      msg.textContent = "Accès refusé : le fichier n'a pas été partagé.";
      msg.hidden = false;
      return;
    }
    await ext.runtime.sendMessage({ target: "bg", type: "share-url", url, kind });
    window.close();
  } catch (e) {
    msg.textContent = `Autorisation impossible : ${String((e as Error)?.message || e)}`;
    msg.hidden = false;
  }
});
document.getElementById("cancel")!.addEventListener("click", () => window.close());
