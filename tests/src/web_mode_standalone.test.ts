import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, "../../docs/demo/index.html"), "utf8");
const packagedHtml = readFileSync(path.join(__dirname, "../../filenymous-app.html"), "utf8");
const i18nMatch = html.match(/window\.FILENYMOUS_I18N = (\{[\s\S]*?\n\});/);
const i18n = JSON.parse(i18nMatch?.[1] ?? "{}") as Record<string, Record<string, string>>;
const visibleHtml = html
  .replace(/<script(?:[^>]*)>[\s\S]*?<\/script>/g, "")
  .replace(/<style(?:[^>]*)>[\s\S]*?<\/style>/g, "");
const visiblePackagedHtml = packagedHtml
  .replace(/<script(?:[^>]*)>[\s\S]*?<\/script>/g, "")
  .replace(/<style(?:[^>]*)>[\s\S]*?<\/style>/g, "");
const runtimeHtml = html.replace(/window\.FILENYMOUS_I18N = \{[\s\S]*?\n\};/, "");
const runtimePackagedHtml = packagedHtml.replace(/window\.FILENYMOUS_I18N = \{[\s\S]*?\n\};/, "");

describe("standalone web transfer mode", () => {
  it("keeps all public website language dictionaries aligned", () => {
    expect(Object.keys(i18n).sort()).toEqual(["en", "fr", "ko"]);
    const baseKeys = Object.keys(i18n.en).sort();
    for (const lang of ["fr", "ko"]) {
      expect(Object.keys(i18n[lang]).sort()).toEqual(baseKeys);
    }
  });

  it("defines every translation key referenced by the HTML", () => {
    const referencedKeys = Array.from(html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g), match => match[1]).sort();
    expect(referencedKeys.length).toBeGreaterThan(0);
    for (const key of referencedKeys) {
      expect(i18n.en[key], key).toBeTruthy();
      expect(i18n.fr[key], key).toBeTruthy();
      expect(i18n.ko[key], key).toBeTruthy();
    }
  });

  it("uses the current Holo Web Conductor client package without the obsolete web-client import", () => {
    expect(html).toContain("@holo-host/web-conductor-client@0.1.0");
    expect(html).toContain("WebConductorAppClient");
    expect(html).not.toContain("@holo-host/web-client");
    expect(packagedHtml).toContain("@holo-host/web-conductor-client@0.1.0");
    expect(packagedHtml).not.toContain("@holo-host/web-client");
  });

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

  it("compresses autonomous web links with a shorter versioned payload", () => {
    expect(html).toContain("compressWebInlineBytes");
    expect(html).toContain("decompressWebInlineBytes");
    expect(html).toContain("web-inline-z");
    expect(html).toContain("w2:${metaB64}:${dataB64}");
    expect(html).toContain("new CompressionStream('gzip')");
    expect(html).toContain("new DecompressionStream('gzip')");
    expect(html).toContain("web_inline_compression");
    expect(html).toContain("await decompressWebInlineBytes");
    expect(packagedHtml).toContain("web-inline-z");
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
    expect(visibleHtml).toContain("Add files or folder");
    expect(visibleHtml).toContain("Create Magic Link");
    expect(packagedHtml).toContain('id="home-file-input"');
  });

  it("exposes Mode ROOM as a clear public tab and panel", () => {
    expect(html).toContain('id="tab-rooms"');
    expect(html).toContain('id="panel-rooms"');
    expect(html).toContain('id="rooms-shell"');
    expect(visibleHtml).toContain("Create a private room for a group");
    expect(visibleHtml).toContain("One temporary room, one invite link, many files");
    expect(html).toContain("publicRoomInviteUrl");
    expect(html).toContain("renderPublicRoom");
    expect(html).toContain("createPublicRoom");
    expect(html).toContain('"rooms.title"');
    expect(packagedHtml).toContain('id="panel-rooms"');
  });

  it("uses a Discord-style room shell with conditional room list and avatars", () => {
    for (const token of [
      "rooms-shell",
      "public-room-list-panel",
      "public-room-list",
      "has-room-list",
      "showRoomList = roomEntries.length > 1",
      "publicRoomDirectory",
      "setPublicRoomAvatar",
      "public-room-avatar-picker",
      "PUBLIC_ROOM_AVATARS",
      "12 users maximum",
      "rooms.maxUsersTitle",
    ]) {
      expect(html).toContain(token);
      expect(packagedHtml).toContain(token);
    }
  });

  it("connects public rooms to live signaling presence", () => {
    for (const token of [
      "connectPublicRoom",
      "joinPublicRoomFromHash",
      "handlePublicRoomMessage",
      "setPublicRoomPeers",
      "room-join",
      "room-joined",
      "room-peer-joined",
      "room-peer-left",
      "room-waiting",
    ]) {
      expect(html).toContain(token);
      expect(packagedHtml).toContain(token);
    }
  });

  it("joins public room invite links on initial page load", () => {
    expect(html).toContain("if (joinPublicRoomFromHash()) return;");
    expect(packagedHtml).toContain("if (joinPublicRoomFromHash()) return;");
  });

  it("encrypts public room chat events before signaling", () => {
    for (const token of [
      "derivePublicRoomKey",
      "encryptPublicRoomPayload",
      "decryptPublicRoomPayload",
      "sendPublicRoomEvent",
      "sendPublicRoomEvent('chat'",
      "kind: 'chat'",
      "crypto.subtle.encrypt({ name: 'AES-GCM'",
      "crypto.subtle.decrypt({ name: 'AES-GCM'",
    ]) {
      expect(html).toContain(token);
      expect(packagedHtml).toContain(token);
    }
  });

  it("supports encrypted public room file transfer events", () => {
    for (const token of [
      "roomFileTransfers",
      "sharePublicRoomFile",
      "downloadPublicRoomFile",
      "PUBLIC_ROOM_FILE_CHUNK_SIZE",
      "sendPublicRoomEvent('file-offer'",
      "sendPublicRoomEvent('file-chunk'",
      "sendPublicRoomEvent('file-complete'",
      "kind: 'file-offer'",
      "kind: 'file-chunk'",
      "kind: 'file-complete'",
      "URL.createObjectURL(new Blob",
    ]) {
      expect(html).toContain(token);
      expect(packagedHtml).toContain(token);
    }
  });

  it("lets users close and revoke public rooms", () => {
    for (const token of [
      "closePublicRoom",
      "room-close",
      "Room closed",
      "data-i18n=\"rooms.close\"",
      "Close room",
    ]) {
      expect(html).toContain(token);
      expect(packagedHtml).toContain(token);
    }
  });

  it("warns before closing the browser during an active transfer", () => {
    expect(html).toContain("beforeunload");
    expect(html).toContain("transferActive");
    expect(html).toContain("markTransferActive");
    expect(html).toContain("markTransferDone");
    expect(packagedHtml).toContain("beforeunload");
  });

  it("creates WebRTC one-time codes directly from the public home", () => {
    expect(html).toContain("await window.handleSend(event, { preferP2PCode: true })");
    expect(html).toContain("if (!options.preferWebLink && p2pSupported())");
    expect(html).not.toContain("await window.handleSend(event, { preferWebLink: true })");
    expect(packagedHtml).toContain("await window.handleSend(event, { preferP2PCode: true })");
    expect(packagedHtml).toContain("if (!options.preferWebLink && p2pSupported())");
    expect(packagedHtml).not.toContain("await window.handleSend(event, { preferWebLink: true })");
  });

  it("keeps the public receive flow to a single code-or-link input", () => {
    expect(visibleHtml).toContain("Filenymous code or link");
    expect(html).toContain("receiveFromSingleInput");
    expect(visibleHtml).toContain("Filenymous chooses the right mode automatically");
    expect(html).toContain('id="recv-manual" class="card hidden"');
    expect(html).toContain('id="recv-empty" class="card hidden"');
    expect(html).toContain("$('recv-empty').classList.add('hidden')");
    expect(html).toContain("123-456-ABC");
    expect(visiblePackagedHtml).toContain("Filenymous code or link");
  });

  it("requires a human gesture before creating or joining a P2P code", () => {
    expect(html).toContain("verifyHumanGesture");
    expect(html).toContain("human-proof");
    expect(visibleHtml).toContain("I am human");
    expect(html).toContain("event?.isTrusted");
    expect(html).toContain("await window.handleSend(event, { preferP2PCode: true })");
    expect(packagedHtml).toContain("verifyHumanGesture");
  });

  it("supports local QR sharing and QR scanning for long links", () => {
    expect(html).toContain('id="qr-panel"');
    expect(html).toContain('id="qr-canvas"');
    expect(html).toContain("renderQrForCurrentLink");
    expect(html).toContain("scanQrCode");
    expect(html).toContain("BarcodeDetector");
    expect(html).toContain("QR_DECODER_URL");
    expect(html).toContain("loadQrDecoder");
    expect(html).toContain("detectQrFromSource");
    expect(html).toContain("window.jsQR");
    expect(html).toContain("new URLSearchParams");
    expect(html).toContain("params.get('code')");
    expect(html).toContain("params.get('p2p')");
    expect(html).toContain('capture="environment"');
    expect(html).toContain("navigator.share");
    expect(packagedHtml).toContain('id="qr-panel"');
    expect(packagedHtml).toContain("detectQrFromSource");
    expect(packagedHtml).toContain('capture="environment"');
  });

  it("uses the simplified public home message", () => {
    expect(visibleHtml).toContain("Send files with one private link");
    expect(visibleHtml).toContain("No cloud, no account");
    expect(visiblePackagedHtml).toContain("Send files with one private link");
  });

  it("serves English public fallback copy before JavaScript translations run", () => {
    for (const phrase of [
      "Send",
      "Receive",
      "Rooms",
      "History",
      "Advanced",
      "Language",
      "Create Magic Link",
      "Download and decrypt",
      "After validation:",
      "Public open directory",
      "No transfer yet.",
      "Download the web version",
    ]) {
      expect(visibleHtml).toContain(phrase);
      expect(visiblePackagedHtml).toContain(phrase);
    }
    for (const phrase of [
      "Accueil",
      "Envoyez un fichier",
      "Pas de cloud",
      "Je suis humain",
      "Télécharger et déchiffrer",
      "Aucun transfert pour l'instant",
    ]) {
      expect(visibleHtml).not.toContain(phrase);
      expect(visiblePackagedHtml).not.toContain(phrase);
    }
  });

  it("keeps public runtime fallback messages in English outside translation dictionaries", () => {
    for (const phrase of [
      "Sender ID copied.",
      "Public web mode",
      "Session created. Share this code with the recipient.",
      "Anonymous web link created.",
      "No link to encode.",
      "No transfer yet.",
      "Revoke",
    ]) {
      expect(runtimeHtml).toContain(phrase);
      expect(runtimePackagedHtml).toContain(phrase);
    }
    for (const phrase of [
      "Lien Web anonyme",
      "Session P2P creee",
      "Aucun lien a encoder",
      "Aucun transfert pour l'instant",
      "Révoquer",
      "Fichier envoyé",
      "Sélectionnez d'abord un fichier",
    ]) {
      expect(runtimeHtml).not.toContain(phrase);
      expect(runtimePackagedHtml).not.toContain(phrase);
    }
  });

  it("ships English, French, and Korean public website copy", () => {
    expect(html).toContain('id="language-select"');
    expect(html).toContain('data-i18n="home.title"');
    expect(html).toContain("FILENYMOUS_I18N");
    expect(html).toContain('"en"');
    expect(html).toContain('"fr"');
    expect(html).toContain('"ko"');
    expect(html).toContain("Send files with one private link");
    expect(html).toContain("Envoyez un fichier grâce à un code unique");
    expect(html).toContain("고유 코드 하나로 파일을 보내세요");
    expect(packagedHtml).toContain('id="language-select"');
    expect(packagedHtml).toContain("FILENYMOUS_I18N");
  });

  it("localizes the advanced identity panel and runtime status copy", () => {
    const advancedKeys = [
      "advanced.title",
      "advanced.intro",
      "advanced.irohTitle",
      "advanced.irohCopy",
      "advanced.blobsTitle",
      "advanced.blobsCopy",
      "advanced.browserTag",
      "advanced.browserTitle",
      "advanced.browserCopy",
      "advanced.senderTitle",
      "advanced.senderModeLocal",
      "advanced.senderModeHolo",
      "advanced.senderModeWeb",
      "advanced.senderHelp",
      "advanced.senderCopied",
      "advanced.portableTitle",
      "advanced.portableCopy",
      "advanced.downloadWeb",
      "advanced.webEncryption",
      "advanced.webP2P",
      "advanced.webLocalKeys",
      "advanced.optionalModules",
      "advanced.publicModeTitle",
      "advanced.publicModeDesc",
      "advanced.publicModeSend",
      "advanced.publicModeReceive",
      "advanced.publicModeIroh",
      "advanced.publicModeDht",
      "advanced.holoModeTitle",
      "advanced.holoModeDesc",
      "advanced.holoModeSend",
      "advanced.holoModeReceive",
      "advanced.holoModeContacts",
      "advanced.holoModeEcies",
      "advanced.agentTitle",
      "advanced.holoAgentTitle",
      "advanced.registerTitle",
      "advanced.contactLabel",
      "advanced.registerHelp",
      "advanced.publishDht",
      "advanced.x25519Title",
      "advanced.x25519Copy",
      "advanced.checking",
      "advanced.generatePublish",
      "advanced.x25519Present",
      "advanced.x25519Missing",
    ];

    for (const key of advancedKeys) {
      expect(i18n.en[key], key).toBeTruthy();
      expect(i18n.fr[key], key).toBeTruthy();
      expect(i18n.ko[key], key).toBeTruthy();
      expect(i18n.fr[key], key).not.toBe(i18n.en[key]);
      expect(i18n.ko[key], key).not.toBe(i18n.en[key]);
      expect(html).toContain(`"${key}"`);
      expect(packagedHtml).toContain(`"${key}"`);
    }

    for (const marker of [
      'data-i18n="advanced.title"',
      'data-i18n="advanced.intro"',
      'data-i18n="advanced.senderTitle"',
      'data-i18n="advanced.portableTitle"',
      'data-i18n="advanced.registerTitle"',
      'data-i18n="advanced.x25519Title"',
      "tr('advanced.publicModeTitle'",
      "tr('advanced.senderModeWeb'",
      "tr('advanced.x25519Missing'",
    ]) {
      expect(html).toContain(marker);
      expect(packagedHtml).toContain(marker);
    }
  });

  it("localizes received download confirmations and progress messages", () => {
    for (const key of [
      "receive.downloadSuccess",
      "receive.downloadToast",
      "receive.p2pSuccess",
      "receive.progressWeb",
      "receive.progressDht",
      "receive.progressDecrypt",
      "receive.progressFinalizing",
      "receive.metaDownloads",
      "receive.statusAvailable",
      "home.magicLinkCreated",
      "home.progressCancelled",
      "home.progressCancelledEstimate",
      "home.progressComplete",
      "home.progressEncrypting",
      "home.progressFailed",
      "home.progressFailedEstimate",
      "home.progressReadyToShare",
      "home.progressRemaining",
      "home.progressSelecting",
      "home.progressTransferring",
      "home.progressVerifying",
      "home.progressWaitingPeer",
    ]) {
      expect(html).toContain(`"${key}"`);
      expect(packagedHtml).toContain(`"${key}"`);
    }
    expect(html).toContain("trFormat('receive.downloadSuccess'");
    expect(html).toContain("trFormat('receive.p2pSuccess'");
    expect(html).not.toContain("Le navigateur l'a place dans Telechargements");
    expect(html).not.toContain("OK ${esc(p.manifest.file_name)} telecharge");
    expect(html).not.toContain("Fichier dechiffre et envoye vers Telechargements.");
  });

  it("keeps advanced panels out of the primary navigation", () => {
    expect(html).not.toContain('id="tab-privacy"');
    expect(html).toContain('id="tab-identity" onclick="showTab(\'identity\')" data-i18n="nav.advanced"');
    expect(visibleHtml).toContain("Advanced");
    expect(html).not.toContain("Coffre local");
    expect(html).not.toContain("showTab('wallet')");
    expect(packagedHtml).not.toContain('id="tab-privacy"');
  });
});
