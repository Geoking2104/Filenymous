/**
 * ReceivePanel v2 — download via one-time link + manual paste + i18n
 *
 * Supported link formats:
 *   #<parcel_eh_b64url>:<aes_key_b64url>              (DHT parcel, key in fragment)
 *   #<parcel_eh_b64url>:p.<salt>.<wrapped_key>        (DHT parcel, password-protected)
 *   #sl=<cipher>.<key>.<meta>                         (self-contained, no conductor)
 *   #slp=<cipher>.<wrapped_key>.<salt>.<meta>         (self-contained, password-protected)
 */

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { importAesKey } from "../crypto/aes";
import { b64urlDecode } from "../crypto/b64url";
import { unwrapKeyWithPassword } from "../crypto/password";
import { decryptChunks, saveBlob } from "../crypto/chunker";
import {
  parseWebLink,
  decryptWebLinkBlob,
  unlockWebLink,
  type ParsedWebLink,
} from "../holochain/webLink";
import { parcelZome, webBridgeGetParcel } from "../holochain/delivery";
import { fileStorageZome, webBridgeGetFile } from "../holochain/fileStorage";
import { hasConductor, initClient } from "../holochain/client";
import type { ParcelOutput } from "../holochain/types";

type RxState = "idle" | "found" | "locked" | "downloading" | "done" | "error";

/** A password-protected transfer waiting to be unlocked. */
type LockedSource =
  | { kind: "weblink"; parsed: ParsedWebLink }
  | { kind: "parcel"; parcel: ParcelOutput; saltB64: string; wrappedB64: string };

function fmtSize(b: number, units: string[]) {
  if (!b) return `0 ${units[0]}`;
  const k = 1024;
  const i = Math.floor(Math.log(b) / Math.log(k));
  return parseFloat((b / Math.pow(k, i)).toFixed(1)) + " " + units[i];
}

function parseMagicInput(raw: string): { parcelEhB64: string; keyMaterial: string } | null {
  let value = raw.trim();
  if (!value) return null;
  if (value.includes("#")) value = value.split("#").pop() || "";
  if (value.startsWith("#")) value = value.slice(1);
  if (!value.includes(":")) return null;
  const [parcelEhB64, keyMaterial] = value.split(":");
  if (!parcelEhB64 || !keyMaterial) return null;
  return { parcelEhB64, keyMaterial };
}

export default function ReceivePanel() {
  const { t } = useTranslation();
  const units = [t("size.b"), t("size.kb"), t("size.mb"), t("size.gb"), t("size.tb")];

  const [state, setState] = useState<RxState>("idle");
  const [parcel, setParcel] = useState<ParcelOutput | null>(null);
  const [aesKey, setAesKey] = useState<CryptoKey | null>(null);
  const [pct, setPct] = useState(0);
  const [step, setStep] = useState("");
  const [errMsg, setErrMsg] = useState("");
  const [paste, setPaste] = useState("");
  const webLinkRef = useRef<ParsedWebLink | null>(null);
  const [webLinkName, setWebLinkName] = useState("");
  const [webLinkSize, setWebLinkSize] = useState(0);
  const [doneName, setDoneName] = useState("");

  // Password unlock state
  const [locked, setLocked] = useState<LockedSource | null>(null);
  const [password, setPassword] = useState("");
  const [pwError, setPwError] = useState("");
  const [unlocking, setUnlocking] = useState(false);

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    // Self-contained web link (#sl=... / #slp=...): decrypt locally, no conductor needed.
    if (hash.startsWith("sl=") || hash.startsWith("slp=")) {
      resolveWebLink(hash);
      return;
    }
    if (!hash.includes(":")) return;
    const [parcelEhB64, keyMaterial] = hash.split(":");
    if (!parcelEhB64 || !keyMaterial) return;
    resolveFromUrl(parcelEhB64, keyMaterial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resolveWebLink = async (fragment: string) => {
    setState("idle");
    setErrMsg("");
    try {
      setPct(10);
      setStep(t("receive.progressManifest"));
      const parsed = await parseWebLink(fragment);
      if (!parsed) {
        setErrMsg(t("receive.invalidLink"));
        setState("error");
        return;
      }
      setWebLinkName(parsed.name);
      setWebLinkSize(parsed.size);
      if (parsed.locked) {
        setLocked({ kind: "weblink", parsed });
        setPassword("");
        setPwError("");
        setPct(0);
        setState("locked");
        return;
      }
      // Unlocked link: stash it so download() can decrypt it locally.
      webLinkRef.current = parsed;
      setPct(0);
      setState("found");
    } catch (e) {
      setErrMsg(t("receive.errorPrefix", { message: String(e) }));
      setState("error");
    }
  };

  const resolveFromUrl = async (parcelEhB64: string, keyMaterial: string) => {
    setState("idle");
    setErrMsg("");
    try {
      await initClient();
      setPct(10);
      setStep(t("receive.progressManifest"));

      const parcelEhBytes = b64urlDecode(parcelEhB64);

      let result: ParcelOutput | null;
      if (hasConductor()) {
        result = await parcelZome.getParcel(Array.from(parcelEhBytes) as unknown as any);
      } else {
        result = await webBridgeGetParcel(parcelEhB64);
      }

      if (!result) {
        setErrMsg(t("receive.notFound"));
        setState("error");
        return;
      }
      if (result.is_revoked) {
        setErrMsg(t("receive.revoked"));
        setState("error");
        return;
      }
      if (result.manifest.expiry_us > 0 && Date.now() * 1000 > result.manifest.expiry_us) {
        setErrMsg(t("receive.expired"));
        setState("error");
        return;
      }

      // Password-protected parcel: key material is "p.<salt>.<wrapped>".
      if (keyMaterial.startsWith("p.")) {
        const parts = keyMaterial.split(".");
        if (parts.length !== 3 || !parts[1] || !parts[2]) {
          setErrMsg(t("receive.invalidLink"));
          setState("error");
          return;
        }
        setLocked({ kind: "parcel", parcel: result, saltB64: parts[1], wrappedB64: parts[2] });
        setPassword("");
        setPwError("");
        setPct(0);
        setState("locked");
        return;
      }

      const aesRaw = b64urlDecode(keyMaterial);
      const key = await importAesKey(aesRaw);

      setParcel(result);
      setAesKey(key);
      setState("found");
      setPct(0);
    } catch (e) {
      setErrMsg(t("receive.errorPrefix", { message: String(e) }));
      setState("error");
    }
  };

  const handlePasteSubmit = () => {
    const parsed = parseMagicInput(paste);
    if (!parsed) {
      setErrMsg(t("receive.invalidLink"));
      setState("error");
      return;
    }
    resolveFromUrl(parsed.parcelEhB64, parsed.keyMaterial);
  };

  const unlock = async () => {
    if (!locked || !password) return;
    setUnlocking(true);
    setPwError("");
    try {
      if (locked.kind === "weblink") {
        await unlockWebLink(locked.parsed, password);
        webLinkRef.current = locked.parsed;
        setLocked(null);
        setPassword("");
        setPct(0);
        setState("found");
      } else {
        const raw = await unwrapKeyWithPassword(
          password,
          b64urlDecode(locked.saltB64),
          b64urlDecode(locked.wrappedB64),
        );
        const key = await importAesKey(raw);
        setParcel(locked.parcel);
        setAesKey(key);
        setLocked(null);
        setPassword("");
        setPct(0);
        setState("found");
      }
    } catch {
      setPwError(t("receive.passwordWrong"));
    } finally {
      setUnlocking(false);
    }
  };

  const download = async () => {
    // Self-contained web link: decrypt the embedded ciphertext locally.
    if (webLinkRef.current) {
      const p = webLinkRef.current;
      setState("downloading");
      setPct(0);
      try {
        setStep(t("receive.progressDecrypt"));
        const blob = await decryptWebLinkBlob(p);
        setPct(95);
        setStep(t("receive.progressSave"));
        saveBlob(blob, p.name);
        setDoneName(p.name);
        setPct(100);
        setState("done");
      } catch (e) {
        setErrMsg(t("receive.errorDownload", { message: String(e) }));
        setState("error");
      }
      return;
    }
    if (!parcel || !aesKey) return;
    setState("downloading");
    setPct(0);
    const prog = (p: number, s: string) => {
      setPct(p);
      setStep(s);
    };

    try {
      prog(15, t("receive.progressChunks"));

      let chunks: Uint8Array[];
      const fileHashBytes = parcel.manifest.file_hash as unknown as number[];

      if (hasConductor()) {
        const fileResult = await fileStorageZome.getFile(fileHashBytes as unknown as any);
        if (!fileResult) throw new Error(t("receive.fileMissingDht"));
        chunks = fileResult.chunks;
      } else {
        const fileHashB64 = b64urlFromBytes(fileHashBytes);
        const fileResult = await webBridgeGetFile(fileHashB64);
        if (!fileResult) throw new Error(t("receive.fileMissingBridge"));
        chunks = fileResult.chunks;
      }

      prog(55, t("receive.progressDecrypt"));
      const blob = await decryptChunks(chunks, aesKey, "application/octet-stream", {
        onChunk: (i, total) =>
          prog(55 + Math.round((i / total) * 35), t("receive.progressChunk", { current: i + 1, total })),
      });

      prog(95, t("receive.progressSave"));
      saveBlob(blob, parcel.manifest.file_name);
      setDoneName(parcel.manifest.file_name);

      if (hasConductor()) {
        try {
          await parcelZome.confirmDownload(parcel.parcel_eh);
        } catch {
          /* non-blocking */
        }
      }

      prog(100, t("receive.progressDone"));
      setState("done");
    } catch (e) {
      setErrMsg(t("receive.errorDownload", { message: String(e) }));
      setState("error");
    }
  };

  const resetToIdle = () => {
    setState("idle");
    setErrMsg("");
    setPwError("");
    setPaste("");
    setLocked(null);
    setPassword("");
  };

  if (state === "error")
    return (
      <div className="card" style={{ textAlign: "center", padding: "2.5rem" }}>
        <div style={{ fontSize: "3rem", marginBottom: ".8rem" }}>❌</div>
        <div style={{ fontSize: "1rem", fontWeight: 700, color: "var(--err)", marginBottom: ".6rem" }}>
          {t("receive.accessDenied")}
        </div>
        <div style={{ fontSize: ".87rem", color: "var(--muted)", marginBottom: "1.2rem" }}>{errMsg}</div>
        <button className="btn-ghost" onClick={resetToIdle}>
          {t("common.retry")}
        </button>
      </div>
    );

  if (state === "locked" && locked) {
    const fileName =
      locked.kind === "weblink" ? locked.parsed.name : locked.parcel.manifest.file_name;
    const fileSize =
      locked.kind === "weblink" ? locked.parsed.size : locked.parcel.manifest.file_size;
    return (
      <div className="card" style={{ padding: "2rem" }}>
        <div style={{ textAlign: "center", marginBottom: "1rem" }}>
          <div style={{ fontSize: "2.5rem", marginBottom: ".5rem" }}>🔒</div>
          <div style={{ fontSize: "1.15rem", fontWeight: 700, marginBottom: ".35rem" }}>
            {t("receive.passwordTitle")}
          </div>
          <div style={{ fontSize: ".87rem", color: "var(--muted)" }}>{t("receive.passwordHint")}</div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: ".4rem",
            marginBottom: "1.1rem",
            fontSize: ".85rem",
            color: "var(--muted)",
          }}
        >
          <span style={{ fontWeight: 600, color: "var(--text)" }}>{fileName}</span>
          <span>·</span>
          <span>{fmtSize(fileSize, units)}</span>
        </div>

        <div className="form-row">
          <label className="form-label">{t("receive.passwordLabel")}</label>
          <input
            type="password"
            value={password}
            autoFocus
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && unlock()}
            autoComplete="off"
          />
        </div>

        {pwError && (
          <div style={{ color: "var(--err)", fontSize: ".8rem", marginBottom: ".7rem" }}>{pwError}</div>
        )}

        <button
          className="btn-primary btn-full"
          style={{ padding: ".75rem" }}
          disabled={!password || unlocking}
          onClick={unlock}
        >
          {unlocking ? "…" : `🔓 ${t("receive.passwordUnlock")}`}
        </button>

        <p style={{ textAlign: "center", fontSize: ".75rem", color: "var(--muted)", marginTop: "1rem" }}>
          {t("receive.passwordNote")}
        </p>
      </div>
    );
  }

  if (state === "done")
    return (
      <div className="card" style={{ textAlign: "center", padding: "2.5rem" }}>
        <div style={{ fontSize: "3rem", marginBottom: ".8rem" }}>🎉</div>
        <div style={{ fontSize: "1.1rem", fontWeight: 700, marginBottom: ".4rem" }}>
          {t("receive.downloaded")}
        </div>
        <div style={{ fontSize: ".87rem", color: "var(--muted)" }}>
          {t("receive.savedLocally", { name: doneName || parcel?.manifest.file_name || webLinkName })}
        </div>
      </div>
    );

  if ((state === "found" || state === "downloading") && (parcel || webLinkRef.current))
    return (
      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: ".9rem", marginBottom: "1.3rem" }}>
          <div
            style={{
              fontSize: "2.2rem",
              background: "var(--grad-soft)",
              borderRadius: "10px",
              width: "52px",
              height: "52px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            📄
          </div>
          <div>
            <div style={{ fontSize: "1rem", fontWeight: 700 }}>{parcel?.manifest.file_name ?? webLinkName}</div>
            <div style={{ fontSize: ".78rem", color: "var(--muted)" }}>
              {fmtSize(parcel?.manifest.file_size ?? webLinkSize, units)} ·{" "}
              {parcel
                ? t("receive.chunksEncrypted", { count: parcel.manifest.chunk_count })
                : t("receive.webLinkNote")}
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: ".6rem", marginBottom: "1.1rem" }}>
          <div
            style={{
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: "9px",
              padding: ".65rem .9rem",
            }}
          >
            <div style={{ fontSize: ".7rem", color: "var(--muted)", marginBottom: ".15rem" }}>
              {t("receive.downloads")}
            </div>
            <div style={{ fontSize: ".85rem", fontWeight: 600 }}>
              {parcel
                ? `${parcel.download_count}/${parcel.manifest.max_downloads === 0 ? "∞" : parcel.manifest.max_downloads}`
                : "—"}
            </div>
          </div>
          <div
            style={{
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: "9px",
              padding: ".65rem .9rem",
            }}
          >
            <div style={{ fontSize: ".7rem", color: "var(--muted)", marginBottom: ".15rem" }}>
              {t("receive.network")}
            </div>
            <div style={{ fontSize: ".85rem", fontWeight: 600 }}>
              {parcel
                ? hasConductor()
                  ? t("net.holochainLocal")
                  : t("net.holoWebBridge")
                : t("net.localOnly")}
            </div>
          </div>
        </div>

        {state === "downloading" && (
          <div style={{ marginBottom: ".8rem" }}>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: pct + "%" }} />
            </div>
            <div style={{ fontSize: ".77rem", color: "var(--muted)", marginTop: ".35rem" }}>{step}</div>
          </div>
        )}

        <div className="info-box">🔒 {t("receive.aesInHash")}</div>

        <button
          className="btn-success btn-full"
          style={{ padding: ".75rem" }}
          disabled={state === "downloading"}
          onClick={download}
        >
          {state === "downloading" ? (
            <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: ".5rem" }}>
              <span className="spin" />
              {step || "…"}
            </span>
          ) : (
            `⬇ ${t("receive.downloadDecrypt")}`
          )}
        </button>
      </div>
    );

  return (
    <div className="card" style={{ padding: "2rem" }}>
      <div style={{ textAlign: "center", marginBottom: "1.5rem" }}>
        <div style={{ fontSize: "2.5rem", marginBottom: ".5rem" }}>🔗</div>
        <div style={{ fontSize: "1.15rem", fontWeight: 700, marginBottom: ".35rem" }}>
          {t("receive.title")}
        </div>
        <div style={{ fontSize: ".87rem", color: "var(--muted)" }}>{t("receive.subtitle")}</div>
      </div>

      <div className="form-row">
        <label className="form-label">{t("receive.linkOrCode")}</label>
        <input
          type="text"
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handlePasteSubmit()}
          placeholder={t("receive.placeholder")}
          style={{ fontFamily: "monospace", fontSize: ".85rem" }}
        />
      </div>

      <button
        className="btn-primary btn-full"
        style={{ padding: ".75rem", marginTop: ".5rem" }}
        disabled={!paste.trim()}
        onClick={handlePasteSubmit}
      >
        {t("common.continue")}
      </button>

      <p style={{ textAlign: "center", fontSize: ".75rem", color: "var(--muted)", marginTop: "1rem" }}>
        {t("receive.keyNote")}
      </p>
    </div>
  );
}

/** base64url encode raw bytes (for file hash path segments). */
function b64urlFromBytes(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}
