/**
 * SendPanel v2 — QR without external dependency + pure-browser UX + i18n
 */

import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { hashContact } from "../crypto/contact";
import { generateAesKey, exportAesKey } from "../crypto/aes";
import { encryptFile } from "../crypto/chunker";
import { encryptAesKeyForRecipient, importX25519PublicKey } from "../crypto/ecies";
import { identityZome } from "../holochain/identity";
import { fileStorageZome } from "../holochain/fileStorage";
import { parcelZome } from "../holochain/delivery";
import { canWrite } from "../holochain/client";
import { useStore } from "../store/useStore";

const CHUNK_SIZE = 256 * 1024;

type SendState = "idle" | "uploading" | "done";

function isValidContact(v: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || /^\+[1-9]\d{7,14}$/.test(v);
}

function fmtSize(b: number, units: string[]) {
  if (!b) return `0 ${units[0]}`;
  const k = 1024;
  const i = Math.floor(Math.log(b) / Math.log(k));
  return parseFloat((b / Math.pow(k, i)).toFixed(1)) + " " + units[i];
}

function fileIcon(name: string) {
  const e = (name.split(".").pop() || "").toLowerCase();
  return (
    ({
      pdf: "📕",
      zip: "🗜",
      tar: "🗜",
      gz: "🗜",
      jpg: "🖼",
      jpeg: "🖼",
      png: "🖼",
      gif: "🖼",
      mp4: "🎬",
      mov: "🎬",
      mp3: "🎵",
      doc: "📝",
      docx: "📝",
      xls: "📊",
      xlsx: "📊",
      rs: "💻",
      ts: "💻",
      js: "💻",
      py: "💻",
    } as Record<string, string>)[e] ?? "📄"
  );
}

function encodeB64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export default function SendPanel() {
  const { t, i18n } = useTranslation();
  const units = [t("size.b"), t("size.kb"), t("size.mb"), t("size.gb"), t("size.tb")];

  const addParcel = useStore((s) => s.addParcel);
  const selectedRecipient = useStore((s) => s.selectedRecipient);
  const setSelectedRecipient = useStore((s) => s.setSelectedRecipient);
  const addressBook = useStore((st) => st.addressBook);
  const net = useStore((s) => s.net);

  const [files, setFiles] = useState<File[]>([]);
  const [recipient, setRecipient] = useState("");
  const [expiry, setExpiry] = useState("7d");
  const [maxDl, setMaxDl] = useState("1");
  const [state, setState] = useState<SendState>("idle");
  const [pct, setPct] = useState(0);
  const [step, setStep] = useState("");
  const [link, setLink] = useState("");
  const [mode, setMode] = useState<"agent" | "link" | null>(null);
  const [copied, setCopied] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [resolvedKey, setResolvedKey] = useState<boolean | null>(null);
  const [uiMode, setUiMode] = useState<"magic" | "contact">("magic");
  const resolveTimer = useRef<ReturnType<typeof setTimeout>>();

  const writeReady = canWrite();
  const browserOnly = net.mode === "local-only" || net.mode === "web-bridge" || !writeReady;

  const progress = (p: number, s: string) => {
    setPct(p);
    setStep(s);
  };

  const handleRecipientChange = (v: string) => {
    setRecipient(v);
    setResolvedKey(null);
    clearTimeout(resolveTimer.current);
    if (!isValidContact(v)) return;
    resolveTimer.current = setTimeout(async () => {
      try {
        const h = await hashContact(v);
        const k = await identityZome.getAgentForContact(h);
        setResolvedKey(k !== null);
      } catch {
        setResolvedKey(false);
      }
    }, 800);
  };

  useEffect(() => {
    if (selectedRecipient) {
      setUiMode("contact");
      handleRecipientChange(selectedRecipient);
      setSelectedRecipient("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRecipient]);

  const addFiles = (fs: File[]) => {
    const total = [...files, ...fs].reduce((s, f) => s + f.size, 0);
    if (total > 5 * 1024 ** 3) {
      alert(t("send.limitExceeded"));
      return;
    }
    setFiles((p) => [...p, ...fs]);
  };

  const send = async () => {
    if (!files.length || !isValidContact(recipient)) return;
    if (!canWrite()) return;

    setState("uploading");
    setPct(0);

    try {
      progress(5, t("send.progressResolve"));
      const contactHash = await hashContact(recipient);
      const recipientAgent = await identityZome.getAgentForContact(contactHash);

      progress(12, t("send.progressAes"));
      const aesKey = await generateAesKey();
      const aesRaw = await exportAesKey(aesKey);

      const totalSize = files.reduce((s, f) => s + f.size, 0);
      const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);
      const fileName =
        files.length === 1 ? files[0].name : t("send.nFiles", { count: files.length });

      progress(18, t("send.progressEncrypt"));
      const encryptedChunks: Uint8Array[] = [];
      let chunksProcessed = 0;
      for (const file of files) {
        for await (const chunk of encryptFile(file, aesKey)) {
          encryptedChunks.push(chunk.data);
          chunksProcessed++;
          progress(
            18 + Math.round((chunksProcessed / totalChunks) * 35),
            t("send.progressChunk", { current: chunksProcessed, total: totalChunks }),
          );
        }
      }

      progress(55, t("send.progressPublish"));
      const fileHash = await fileStorageZome.createFile(fileName, encryptedChunks);

      let encryptedKeyBlob = "";
      let deliveryMode: "agent" | "link" = "link";

      if (recipientAgent) {
        progress(72, t("send.progressWrap"));
        const x25519B64 = await identityZome.getX25519Key(recipientAgent);
        if (x25519B64) {
          const x25519Raw = Uint8Array.from(atob(x25519B64), (c) => c.charCodeAt(0));
          const recipKey = await importX25519PublicKey(x25519Raw);
          const blob = await encryptAesKeyForRecipient(aesRaw, recipKey);
          encryptedKeyBlob = btoa(String.fromCharCode(...blob));
          deliveryMode = "agent";
        }
      }

      const expiryMap: Record<string, number> = {
        "24h": 24 * 3600 * 1e6,
        "7d": 7 * 24 * 3600 * 1e6,
        "30d": 30 * 24 * 3600 * 1e6,
        never: 0,
      };
      const expiry_us = expiryMap[expiry] ? Date.now() * 1000 + expiryMap[expiry] : 0;

      progress(80, t("send.progressManifest"));
      const parcelOut = await parcelZome.createParcel({
        file_hash: fileHash,
        file_name: fileName,
        file_size: totalSize,
        chunk_count: totalChunks,
        recipient_contact_hash: contactHash,
        encrypted_key_blob: encryptedKeyBlob,
        expiry_us,
        max_downloads: parseInt(maxDl),
      });

      progress(92, t("send.progressLink"));
      const parcelEhB64 = encodeB64Url(new Uint8Array(parcelOut.parcel_eh as unknown as number[]));

      let transferLink: string;
      if (deliveryMode === "agent") {
        transferLink = `${window.location.origin}/#${parcelEhB64}`;
      } else {
        const aesB64 = encodeB64Url(aesRaw);
        transferLink = `${window.location.origin}/#${parcelEhB64}:${aesB64}`;
      }

      progress(100, t("send.progressDone"));
      setLink(transferLink);
      setMode(deliveryMode);

      addParcel({
        parcel_eh: parcelEhB64,
        file_name: fileName,
        to: recipient,
        size: totalSize,
        date: new Date().toLocaleDateString(i18n.language === "en" ? "en-GB" : "fr-FR"),
        status: "pending",
        downloads: 0,
        max_dl: parseInt(maxDl),
        link: transferLink,
        mode: deliveryMode,
      });

      setState("done");
    } catch (e) {
      console.error(e);
      alert(t("send.errorTransfer", { message: String(e) }));
      setState("idle");
    }
  };

  if (state === "done")
    return (
      <div className="card" style={{ textAlign: "center", padding: "2.5rem" }}>
        <div style={{ fontSize: "3rem", marginBottom: ".8rem" }}>✅</div>
        <div style={{ fontSize: "1.1rem", fontWeight: 700, marginBottom: ".4rem" }}>
          {t("send.published")}
        </div>
        {mode === "agent" ? (
          <div style={{ fontSize: ".87rem", color: "var(--muted)", marginBottom: "1.5rem" }}>
            {t("send.notified")}
          </div>
        ) : (
          <div className="warn-box" style={{ textAlign: "left", marginBottom: "1.2rem" }}>
            ⚠ {t("send.notRegistered")}
          </div>
        )}

        {link && (
          <>
            <div style={{ display: "flex", justifyContent: "center", margin: "1.5rem 0" }}>
              <div style={{ background: "white", padding: "16px", borderRadius: "16px" }}>
                <img
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(link)}`}
                  alt="QR Code"
                  width={180}
                  height={180}
                  style={{ display: "block" }}
                />
              </div>
            </div>
            <p style={{ fontSize: ".78rem", color: "var(--muted)", marginBottom: "1.2rem" }}>
              {t("send.scanQr")}
            </p>
          </>
        )}

        <div className="form-row" style={{ textAlign: "left" }}>
          <div className="form-label">{t("send.downloadLink")}</div>
          <div
            style={{
              display: "flex",
              gap: ".5rem",
              background: "var(--bg)",
              border: "1.5px solid var(--border)",
              borderRadius: "10px",
              padding: ".45rem .45rem .45rem .85rem",
              alignItems: "center",
            }}
          >
            <span
              style={{
                flex: 1,
                fontSize: ".82rem",
                fontFamily: "monospace",
                color: "var(--muted)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {link}
            </span>
            <button
              className="btn-ghost btn-sm"
              onClick={() => {
                navigator.clipboard.writeText(link);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? `✓ ${t("common.copied")}` : t("common.copy")}
            </button>
          </div>
        </div>
        <button
          className="btn-ghost btn-full"
          style={{ marginTop: "1.2rem" }}
          onClick={() => {
            setFiles([]);
            setRecipient("");
            setState("idle");
            setPct(0);
            setCopied(false);
            setMode(null);
          }}
        >
          {t("send.newSend")}
        </button>
      </div>
    );

  if (state === "uploading")
    return (
      <div className="card" style={{ textAlign: "center", padding: "2.5rem" }}>
        <div style={{ fontSize: "2.5rem", marginBottom: ".8rem" }}>🔒</div>
        <div style={{ fontSize: "1rem", fontWeight: 600, marginBottom: ".4rem" }}>{step}</div>
        <div style={{ fontSize: ".82rem", color: "var(--muted)", marginBottom: "1.2rem" }}>
          {t("send.localOnlyProgress")}
        </div>
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: pct + "%" }} />
        </div>
        <div style={{ fontSize: ".77rem", color: "var(--muted)", marginTop: ".4rem" }}>{pct}%</div>
      </div>
    );

  return (
    <div>
      <div style={{ marginBottom: "1.4rem" }}>
        <h1 style={{ fontSize: "2rem", fontWeight: 600, letterSpacing: "-.03em", lineHeight: 1.1 }}>
          {t("send.title")}
        </h1>
        <p style={{ color: "var(--muted)", marginTop: ".35rem" }}>{t("send.subtitle")}</p>
      </div>

      {browserOnly && (
        <div className="warn-box" style={{ marginBottom: "1rem" }}>
          ⚠ {t("send.browserOnly")}
        </div>
      )}

      <div
        style={{
          display: "flex",
          background: "rgba(255,255,255,.05)",
          borderRadius: "16px",
          padding: "4px",
          marginBottom: "1rem",
          width: "fit-content",
        }}
      >
        <button
          type="button"
          onClick={() => setUiMode("magic")}
          style={{
            padding: ".5rem 1.4rem",
            borderRadius: "12px",
            fontSize: ".86rem",
            fontWeight: 600,
            transition: "all .2s",
            background: uiMode === "magic" ? "#fff" : "transparent",
            color: uiMode === "magic" ? "#09090b" : "var(--muted)",
          }}
        >
          {t("send.magicLink")}
        </button>
        <button
          type="button"
          onClick={() => setUiMode("contact")}
          style={{
            padding: ".5rem 1.4rem",
            borderRadius: "12px",
            fontSize: ".86rem",
            fontWeight: 600,
            transition: "all .2s",
            background: uiMode === "contact" ? "#fff" : "transparent",
            color: uiMode === "contact" ? "#09090b" : "var(--muted)",
          }}
        >
          {t("send.toContact")}
        </button>
      </div>

      <div className="card" style={{ padding: "1rem" }}>
        <div
          style={{
            border: `2px dashed ${dragging ? "var(--g1)" : "rgba(255,255,255,.2)"}`,
            borderRadius: "18px",
            padding: "2.8rem 1.5rem",
            textAlign: "center",
            cursor: "pointer",
            position: "relative",
            background: dragging ? "rgba(34,211,238,.07)" : "rgba(255,255,255,.02)",
            transition: "all .2s",
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            addFiles(Array.from(e.dataTransfer.files));
          }}
        >
          <input
            type="file"
            multiple
            style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer", width: "100%", height: "100%" }}
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <div style={{ fontSize: "2.4rem", marginBottom: ".6rem" }}>📂</div>
          <div style={{ fontSize: ".9rem", color: "var(--muted)" }}>
            <strong style={{ color: "var(--g1)" }}>{t("send.dropClick")}</strong>{" "}
            {t("send.dropHint").replace(t("send.dropClick"), "").trim()}
          </div>
          <div style={{ fontSize: ".76rem", color: "var(--muted)", marginTop: ".3rem" }}>
            {t("send.dropFormats")}
          </div>
        </div>
        {files.map((f, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: ".7rem",
              padding: ".6rem .8rem",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: "10px",
              marginTop: ".5rem",
            }}
          >
            <span style={{ fontSize: "1.4rem" }}>{fileIcon(f.name)}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: ".88rem",
                  fontWeight: 500,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {f.name}
              </div>
              <div style={{ fontSize: ".75rem", color: "var(--muted)" }}>{fmtSize(f.size, units)}</div>
            </div>
            <button
              style={{
                background: "transparent",
                color: "var(--err)",
                fontSize: ".9rem",
                padding: ".2rem .5rem",
                borderRadius: "6px",
              }}
              onClick={() => setFiles((p) => p.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-label">{t("send.recipientOptions")}</div>
        {uiMode === "magic" ? (
          <div className="form-row">
            <label className="form-label">{t("send.emailOrPhone")}</label>
            <input
              type="text"
              value={recipient}
              onChange={(e) => handleRecipientChange(e.target.value)}
              placeholder={t("send.placeholderContact")}
              style={recipient && !isValidContact(recipient) ? { borderColor: "var(--err)" } : {}}
            />
          </div>
        ) : (
          <div className="form-row">
            <label className="form-label">{t("send.chooseContact")}</label>
            {addressBook.length === 0 ? (
              <div className="warn-box" style={{ marginBottom: 0 }}>
                {t("send.noContacts")}
              </div>
            ) : (
              <div style={{ display: "grid", gap: ".5rem", maxHeight: "15rem", overflow: "auto" }}>
                {addressBook.map((c) => (
                  <button
                    key={c.hash}
                    type="button"
                    onClick={() => handleRecipientChange(c.contact)}
                    style={{
                      textAlign: "left",
                      padding: ".7rem .9rem",
                      borderRadius: "14px",
                      transition: "all .15s",
                      border:
                        recipient === c.contact ? "1px solid var(--g1)" : "1px solid var(--border)",
                      background:
                        recipient === c.contact ? "rgba(34,211,238,.1)" : "rgba(255,255,255,.04)",
                      color: "var(--text)",
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: ".9rem" }}>{c.contact}</div>
                    {c.x25519Key ? (
                      <div style={{ fontSize: ".72rem", color: "var(--ok)" }}>{t("send.keyReady")}</div>
                    ) : c.resolvedAgent ? (
                      <div style={{ fontSize: ".72rem", color: "var(--warn)" }}>{t("send.noX25519")}</div>
                    ) : (
                      <div style={{ fontSize: ".72rem", color: "var(--muted)" }}>{t("send.notResolved")}</div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {recipient && isValidContact(recipient) && resolvedKey !== null && (
          <div
            style={{
              fontSize: ".74rem",
              margin: "-.4rem 0 .9rem",
              color: resolvedKey ? "var(--ok)" : "var(--warn)",
            }}
          >
            {resolvedKey ? t("send.agentRegistered") : t("send.agentUnknown")}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: ".75rem", marginBottom: ".9rem" }}>
          <div>
            <label className="form-label">{t("send.expiry")}</label>
            <select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              <option value="24h">{t("send.expiry24h")}</option>
              <option value="7d">{t("send.expiry7d")}</option>
              <option value="30d">{t("send.expiry30d")}</option>
              <option value="never">{t("common.never")}</option>
            </select>
          </div>
          <div>
            <label className="form-label">{t("send.maxDownloads")}</label>
            <select value={maxDl} onChange={(e) => setMaxDl(e.target.value)}>
              <option value="1">{t("send.times1")}</option>
              <option value="3">{t("send.times3")}</option>
              <option value="10">{t("send.times10")}</option>
              <option value="0">{t("common.unlimited")}</option>
            </select>
          </div>
        </div>

        <div className="info-box">🔒 {t("send.infoCrypto")}</div>

        <button
          className="btn-primary btn-full"
          style={{ padding: ".75rem" }}
          disabled={!files.length || !isValidContact(recipient) || !writeReady}
          onClick={send}
        >
          {uiMode === "magic" ? t("send.btnMagic") : t("send.btnContact")}
        </button>
        <p style={{ textAlign: "center", fontSize: ".72rem", color: "var(--muted)", marginTop: ".7rem" }}>
          {t("send.localEncryptNote")}
        </p>
      </div>
    </div>
  );
}
