/** Popup (and the same page opened in a tab with ?tab=1): files, secrets, active shares. */
import { APP_URL, IS_FIREFOX, ext } from "./env";
import { formatBytes, formatRemaining, statusLabel } from "./labels";
import type { HostReply, ShareSummary } from "./messages";
import { hostCall, onHostState } from "./rpc";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const inTab = new URLSearchParams(location.search).has("tab");
if (inTab) document.body.classList.add("tab");

let picked: File[] = [];
let shares: ShareSummary[] = [];

$("open-app").setAttribute("href", APP_URL);

function show(text: string, error = false) {
  const m = $("message");
  m.textContent = text;
  m.classList.toggle("error", error);
  m.hidden = !text;
}

async function ensureHost(): Promise<void> {
  const r = (await ext.runtime.sendMessage({ target: "bg", type: "ensure-host" })) as { ok: boolean; message?: string } | undefined;
  if (!r?.ok) throw new Error(r?.message || "host");
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// Tabs
for (const btn of document.querySelectorAll<HTMLButtonElement>(".tabs button")) {
  btn.addEventListener("click", () => {
    for (const b of document.querySelectorAll<HTMLButtonElement>(".tabs button")) b.setAttribute("aria-selected", String(b === btn));
    $("tab-files").hidden = btn.dataset.tab !== "files";
    $("tab-secret").hidden = btn.dataset.tab !== "secret";
    show("");
  });
}

// Files
function setPicked(files: File[]) {
  picked = files;
  const list = $("picked");
  list.replaceChildren(...files.map((f) => Object.assign(document.createElement("li"), { textContent: `${f.name} · ${formatBytes(f.size)}` })));
  ($("send") as HTMLButtonElement).disabled = !files.length;
}

const input = $<HTMLInputElement>("file-input");
$("pick").addEventListener("click", () => {
  // Firefox closes the popup when the file dialog opens: pick from a tab instead.
  if (IS_FIREFOX && !inTab) {
    void ext.tabs.create({ url: ext.runtime.getURL("popup.html?tab=1") });
    window.close();
    return;
  }
  input.click();
});
input.addEventListener("change", () => setPicked([...(input.files ?? [])]));
const drop = $("drop");
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  setPicked([...(e.dataTransfer?.files ?? [])]);
});

async function run(button: HTMLButtonElement, fn: () => Promise<HostReply>) {
  button.disabled = true;
  show("");
  try {
    await ensureHost();
    const r = await fn();
    if (!r.ok) {
      show(r.message, true);
      return r;
    }
    if (r.link && !r.copied) await copy(r.link);
    return r;
  } catch {
    show("L'extension ne répond pas. Réessayez.", true);
  } finally {
    button.disabled = false;
  }
  return undefined;
}

$("send").addEventListener("click", async () => {
  const r = await run($("send") as HTMLButtonElement, () =>
    hostCall({
      type: "share-files",
      files: picked,
      source: "popup",
      opts: {
        password: $<HTMLInputElement>("file-password").value || undefined,
        ttlMinutes: Number($<HTMLSelectElement>("file-ttl").value),
        maxDownloads: Number($<HTMLSelectElement>("file-max").value),
      },
    }),
  );
  if (r?.ok) {
    setPicked([]);
    input.value = "";
    $<HTMLInputElement>("file-password").value = "";
    show("Lien copié dans le presse-papier. Gardez le navigateur ouvert jusqu'au téléchargement.");
  }
});

// Secret
const secretText = $<HTMLTextAreaElement>("secret-text");
secretText.addEventListener("input", () => (($("secret-send") as HTMLButtonElement).disabled = !secretText.value.trim()));
$("secret-send").addEventListener("click", async () => {
  const mode = $<HTMLSelectElement>("secret-mode").value;
  const r = await run($("secret-send") as HTMLButtonElement, () =>
    hostCall({
      type: "share-text",
      text: secretText.value,
      source: "popup",
      opts: mode === "once" ? { mode: "once", password: $<HTMLInputElement>("secret-password").value || undefined } : { mode: "ttl", hours: Number(mode), password: $<HTMLInputElement>("secret-password").value || undefined },
    }),
  );
  if (r?.ok) {
    secretText.value = "";
    $<HTMLInputElement>("secret-password").value = "";
    ($("secret-send") as HTMLButtonElement).disabled = true;
    show(mode === "once" ? "Lien secret copié. Il ne s'ouvre qu'une fois." : "Lien secret copié.");
  }
});

// Shares
function renderShare(s: ShareSummary): HTMLLIElement {
  const li = document.createElement("li");
  li.className = `share${s.ended ? " ended" : ""}`;
  li.dataset.status = s.status;
  li.dataset.kind = s.kind;
  li.dataset.testid = "share";
  const name = s.names.length === 1 ? s.names[0]! : `${s.names.length} fichiers`;
  const meta = [
    s.kind === "p2p" ? formatBytes(s.totalBytes) : "Coffre de secrets",
    s.protected ? "mot de passe" : "",
    !s.ended && s.kind === "p2p" ? `expire dans ${formatRemaining(s.expiresAt - Date.now())}` : "",
  ].filter(Boolean).join(" · ");
  const div = (cls: string, text: string) => Object.assign(document.createElement("div"), { className: cls, textContent: text });
  const title = div("name", name);
  title.title = s.names.join("\n");
  const status = div("status", statusLabel(s));
  status.dataset.testid = "share-status";
  li.append(title, div("meta", meta), status);
  if (s.status === "transferring") {
    const p = document.createElement("progress");
    p.max = s.totalBytes || 1;
    p.value = s.confirmedBytes;
    li.append(p);
  }
  const showLink = !s.ended || s.kind === "secret";
  if (showLink) {
    const row = document.createElement("div");
    row.className = "row";
    const link = Object.assign(document.createElement("input"), { readOnly: true, value: s.link });
    link.dataset.testid = "share-link";
    link.addEventListener("focus", () => link.select());
    const copyBtn = Object.assign(document.createElement("button"), { type: "button", textContent: "Copier" });
    copyBtn.addEventListener("click", async () => {
      copyBtn.textContent = (await copy(s.link)) ? "Copié ✓" : "Sélectionnez";
      setTimeout(() => (copyBtn.textContent = "Copier"), 1500);
    });
    row.append(link, copyBtn);
    if (!s.ended) {
      const stop = Object.assign(document.createElement("button"), { type: "button", textContent: "Arrêter" });
      stop.addEventListener("click", () => void hostCall({ type: "stop", id: s.id }, 5000));
      row.append(stop);
    }
    li.append(row);
  }
  return li;
}

function render() {
  const list = $("share-list");
  list.replaceChildren(...shares.map(renderShare));
  $("keep-open").hidden = !shares.some((s) => s.kind === "p2p" && !s.ended);
  $("clear").hidden = !shares.some((s) => s.ended);
}

$("clear").addEventListener("click", () => void hostCall({ type: "clear" }, 5000));
onHostState((s) => {
  shares = s;
  render();
});
// The host may not exist yet (nothing shared): no answer is fine.
void hostCall({ type: "list" }, 1500);
setInterval(render, 30_000);
