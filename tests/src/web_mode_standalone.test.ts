import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, "../../docs/demo/index.html"), "utf8");
const packagedHtml = readFileSync(path.join(__dirname, "../../filenymous-app.html"), "utf8");

describe("standalone web transfer mode", () => {
  it("does not block sends when no Holochain conductor is available", () => {
    expect(html).not.toContain("Mode lecture seule");
    expect(html).not.toContain("envoi non disponible sans conducteur Holochain");
    expect(html).not.toContain("Mode bridge (lecture seule HTTP) : envoi impossible");
  });

  it("ships a browser-only encrypted transfer fallback", () => {
    expect(html).toContain("createWebParcelLink");
    expect(html).toContain("parseWebParcelLink");
    expect(html).toContain("web-inline");
  });

  it("keeps the packaged release HTML send flow writable without a local conductor", () => {
    expect(packagedHtml).not.toContain("Mode bridge (lecture seule HTTP) : envoi impossible");
    expect(packagedHtml).not.toContain("Holo Web Conductor non connecté");
    expect(packagedHtml).toContain("createWebParcelLink");
    expect(packagedHtml).toContain("S.mode === 'bridge'");
    expect(packagedHtml).toContain("link-result");
  });

  it("makes the home page a usable transfer entry point", () => {
    expect(html).toContain('id="home-file-input"');
    expect(html).toContain('id="home-send-btn"');
    expect(html).toContain("createFromHome");
    expect(html).toContain("Ajouter un fichier");
    expect(packagedHtml).toContain('id="home-file-input"');
  });

  it("warns before closing the browser during an active transfer", () => {
    expect(html).toContain("beforeunload");
    expect(html).toContain("transferActive");
    expect(html).toContain("markTransferActive");
    expect(html).toContain("markTransferDone");
    expect(packagedHtml).toContain("beforeunload");
  });

  it("keeps the public receive flow to a single code-or-link input", () => {
    expect(html).toContain("Code ou lien Filenymous");
    expect(html).toContain("receiveFromSingleInput");
    expect(html).toContain("Filenymous choisit automatiquement le bon mode");
    expect(html).toContain('id="recv-manual" class="card hidden"');
    expect(html).toContain('id="recv-empty" class="card hidden"');
    expect(html).toContain("$('recv-empty').classList.add('hidden')");
    expect(html).toContain("123-456-ABC");
    expect(packagedHtml).toContain("Code ou lien Filenymous");
  });

  it("requires a human gesture before creating or joining a P2P code", () => {
    expect(html).toContain("verifyHumanGesture");
    expect(html).toContain("human-proof");
    expect(html).toContain("Je suis humain");
    expect(html).toContain("event?.isTrusted");
    expect(html).toContain("await window.handleSend(event)");
    expect(packagedHtml).toContain("verifyHumanGesture");
  });

  it("supports local QR sharing and QR scanning for long links", () => {
    expect(html).toContain('id="qr-panel"');
    expect(html).toContain('id="qr-canvas"');
    expect(html).toContain("renderQrForCurrentLink");
    expect(html).toContain("scanQrCode");
    expect(html).toContain("BarcodeDetector");
    expect(html).toContain("navigator.share");
    expect(packagedHtml).toContain('id="qr-panel"');
  });

  it("uses the simplified public home message", () => {
    expect(html).toContain("Envoyez un fichier gr&acirc;ce &agrave; un code unique");
    expect(html).toContain("Pas de cloud, pas de compte");
    expect(packagedHtml).toContain("Envoyez un fichier gr&acirc;ce &agrave; un code unique");
  });

  it("ships English, French, and Korean public website copy", () => {
    expect(html).toContain('id="language-select"');
    expect(html).toContain('data-i18n="home.title"');
    expect(html).toContain("FILENYMOUS_I18N");
    expect(html).toContain('"en"');
    expect(html).toContain('"fr"');
    expect(html).toContain('"ko"');
    expect(html).toContain("Send a file with one unique code");
    expect(html).toContain("Envoyez un fichier grâce à un code unique");
    expect(html).toContain("고유 코드 하나로 파일을 보내세요");
    expect(packagedHtml).toContain('id="language-select"');
    expect(packagedHtml).toContain("FILENYMOUS_I18N");
  });

  it("explains where received browser downloads are saved", () => {
    expect(html).toContain("dossier Telechargements du navigateur");
    expect(html).toContain("Le navigateur l'a place dans Telechargements");
    expect(packagedHtml).toContain("dossier Telechargements du navigateur");
  });

  it("keeps advanced panels out of the primary navigation", () => {
    expect(html).toContain('id="tab-privacy"  class="secondary-nav"');
    expect(html).toContain('id="tab-identity" class="secondary-nav"');
    expect(html).not.toContain("Coffre local");
    expect(html).not.toContain("showTab('wallet')");
    expect(packagedHtml).toContain('class="secondary-nav"');
  });
});
