import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "..", "..");

describe("P2P direct web mode", () => {
  const html = readFileSync(resolve(root, "docs/demo/index.html"), "utf8");

  it("exposes direct WebRTC transfer controls with one-time code wording", () => {
    expect(html).toContain("P2P direct");
    expect(html).toContain("One-time code");
    expect(html).toContain("p2pSignalUrl");
    expect(html).toContain("createOneTimeCode");
    expect(html).toContain("randomLetters");
    expect(html).toContain("\\d{3}-\\d{3}-[A-Z]{3}");
    expect(html).toContain("startP2PSend");
    expect(html).toContain("joinP2PReceive");
    expect(html).toContain("RTCPeerConnection");
    expect(html).toContain("RTCDataChannel");
    expect(html).not.toContain("Code telephonique");
    expect(html).not.toContain("code telephonique");
    expect(html).not.toContain("createPhoneCode");
  });

  it("keeps direct P2P available in advanced web sends before falling back to links", () => {
    expect(html).toContain("if (!options.preferWebLink && p2pSupported())");
    expect(html).toContain("return await startP2PSend()");
    expect(html).toContain("Direct P2P is unavailable");
    expect(html).not.toContain("S.file.size > CFG.webInlineMaxBytes");
    expect(html).not.toContain("Mode Web anonyme limite a");
  });

  it("uses the OpenDPE VPS WebSocket relay in public web mode", () => {
    expect(html).toContain("wss://www.opendpe.net/filenymous-signal/");
    expect(html).not.toContain("wss://opendpe.net/filenymous-signal/");
    expect(html).not.toContain("wss://signal.filenymous.eu");
  });

  it("uses the hardened signaling payload contract expected by the relay", () => {
    expect(html).toContain("sendSignal({ kind: 'ice', candidate: ev.candidate })");
    expect(html).toContain("sendSignal({ kind: 'offer', sdp })");
    expect(html).toContain("sendSignal({ kind: 'answer', sdp: answer.sdp })");
    expect(html).toContain("payload.kind === 'offer'");
    expect(html).toContain("payload.kind === 'answer'");
    expect(html).toContain("payload.kind === 'ice'");
  });

  it("keeps P2P file keys protected by the full human-readable code", () => {
    expect(html).toContain("wrapP2PTransferKey");
    expect(html).toContain("unwrapP2PTransferKey");
    expect(html).toContain("p2p-code-v1");
    expect(html).toContain("legacySignalRoomCode");
    expect(html).toContain("openSignalSocketWithFallback");
  });

  it("prevents stale sender sessions from causing signaling role-taken errors", () => {
    expect(html).toContain("S.activeP2PSession");
    expect(html).toContain("closeActiveP2PSession");
    expect(html).toContain("closeActiveP2PSession('complete', session)");
    expect(html).toContain("role-taken");
    expect(html).toContain("Previous code was still active. A fresh code was created automatically.");
  });

  it("lets the sender initiate when the receiver joined the code first", () => {
    expect(html).toContain("let lastOfferSdp = null");
    expect(html).toContain("const sendOffer = async () =>");
    expect(html).toContain("lastOfferSdp = offer.sdp");
    expect(html).toContain("const sdp = pc.localDescription?.sdp || lastOfferSdp");
    expect(html).toContain("if (sdp) sendSignal({ kind: 'offer', sdp })");
    expect(html).toContain("for (const ice of localIceSignals) sendSignal(ice)");
    expect(html).toContain("await sendOffer();");
  });
});
