import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { QRCodeCanvas, QRCodeSVG } from "qrcode.react";
import { canWrite, initClient } from "../../holochain/client";
import { isValidContact, sendTransfer } from "../../transfer/sendTransfer";
import { useStore } from "../../store/useStore";
import {
  fileExtLabel,
  formatBytes,
  type LocalFileItem,
  type SharePath,
  type ShareResult,
} from "../types";

/** Inline pigeon logo (SVG data-URI) — fully local */
const PIGEON_LOGO =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
      <ellipse cx="14.5" cy="17" rx="5.2" ry="4.2" transform="rotate(-8 14.5 17)" fill="#0f172a"/>
      <circle cx="21" cy="12.8" r="3.4" fill="#0f172a"/>
      <path d="M24 12.5 L27.5 13.8 L24 14.8 Z" fill="#f59e0b"/>
      <circle cx="22.3" cy="12.2" r="1.1" fill="#fff"/>
      <path d="M9 14 Q6 8 11 7.5 Q15 9 14 14" fill="#22d3ee"/>
    </svg>`,
  );

export default function SendWorkspace() {
  const { t, i18n } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const qrCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const addressBook = useStore((s) => s.addressBook);
  const selectedRecipient = useStore((s) => s.selectedRecipient);
  const setSelectedRecipient = useStore((s) => s.setSelectedRecipient);
  const addParcel = useStore((s) => s.addParcel);
  const net = useStore((s) => s.net);

  const [files, setFiles] = useState<LocalFileItem[]>([]);
  const [path, setPath] = useState<SharePath>("link");
  const [recipient, setRecipient] = useState("");
  const [expiry, setExpiry] = useState("7d");
  const [maxDl, setMaxDl] = useState("1");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<(ShareResult & { mode?: string }) | null>(null);
  const [copied, setCopied] = useState(false);
  const [writeReady, setWriteReady] = useState(false);

  useEffect(() => {
    void initClient().then(() => setWriteReady(canWrite()));
  }, [net.mode]);

  useEffect(() => {
    if (selectedRecipient) {
      setPath("contact");
      setRecipient(selectedRecipient);
      setSelectedRecipient("");
    }
  }, [selectedRecipient, setSelectedRecipient]);

  const browserOnly = !writeReady;

  const addFiles = useCallback((list: FileList | File[]) => {
    const arr = Array.from(list);
    const total = arr.reduce((s, f) => s + f.size, 0);
    const existing = files.reduce((s, f) => s + f.size, 0);
    if (existing + total > 5 * 1024 ** 3) {
      setError(t("send.limitExceeded"));
      return;
    }
    const next: LocalFileItem[] = arr.map((file) => ({
      id: `f-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: file.name,
      size: file.size,
      mimeType: file.type || "application/octet-stream",
      file,
    }));
    setFiles((prev) => [...prev, ...next]);
    setError("");
  }, [files, t]);

  const removeFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
  };

  const createShare = async () => {
    if (!files.length) {
      inputRef.current?.click();
      return;
    }
    if (!isValidContact(recipient)) {
      setError(t("send.emailOrPhone"));
      return;
    }
    if (!writeReady) {
      setError(t("send.browserOnly"));
      return;
    }

    const realFiles = files.map((f) => f.file).filter((f): f is File => !!f);
    if (!realFiles.length) {
      setError(t("send.errorTransfer", { message: "no File handles" }));
      return;
    }

    setBusy(true);
    setError("");
    setPct(0);
    setStep(t("send.progressAes"));

    try {
      const out = await sendTransfer({
        files: realFiles,
        recipient,
        expiry,
        maxDownloads: parseInt(maxDl, 10) || 0,
        onProgress: (p, key, params) => {
          setPct(p);
          setStep(t(key, params));
        },
      });

      addParcel({
        parcel_eh: out.parcelEhB64,
        file_name: out.fileName,
        to: recipient,
        size: out.totalSize,
        date: new Date().toLocaleDateString(i18n.language === "en" ? "en-GB" : "fr-FR"),
        status: "pending",
        downloads: 0,
        max_dl: out.maxDownloads,
        link: out.link,
        mode: out.mode,
      });

      setResult({
        code: out.code,
        link: out.link,
        createdAt: Date.now(),
        mode: out.mode,
      });
    } catch (e) {
      const msg = String(e);
      if (msg.includes("no_write")) setError(t("send.browserOnly"));
      else setError(t("send.errorTransfer", { message: msg }));
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    if (!result) return;
    try {
      await navigator.clipboard?.writeText(result.link);
    } catch {
      /* ignore */
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const downloadQr = () => {
    const canvas = qrCanvasRef.current;
    if (!canvas) return;
    const url = canvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = `filenymous-qr-${result?.code?.replace(/·/g, "") ?? "share"}.png`;
    a.click();
  };

  const reset = () => {
    setResult(null);
    setFiles([]);
    setRecipient("");
    setCopied(false);
    setError("");
    setPct(0);
    setStep("");
  };

  if (result) {
    return (
      <div className="v3-result">
        <div className="v3-step">{t("ux.sendReady")}</div>
        <p className="v3-muted" style={{ marginBottom: 0 }}>
          {result.mode === "agent" ? t("send.notified") : t("ux.sendGiveCode")}
        </p>
        <div className="v3-code">{result.code}</div>

        <div className="v3-qr-wrap">
          <div className="v3-qr">
            <QRCodeSVG
              value={result.link}
              size={200}
              level="H"
              marginSize={2}
              bgColor="#ffffff"
              fgColor="#0f172a"
              title={t("ux.sendQrTitle")}
              imageSettings={{
                src: PIGEON_LOGO,
                height: 36,
                width: 36,
                excavate: true,
              }}
            />
            <div className="v3-qr-canvas-hidden" aria-hidden="true">
              <QRCodeCanvas
                ref={qrCanvasRef}
                value={result.link}
                size={400}
                level="H"
                marginSize={2}
                bgColor="#ffffff"
                fgColor="#0f172a"
                imageSettings={{
                  src: PIGEON_LOGO,
                  height: 72,
                  width: 72,
                  excavate: true,
                }}
              />
            </div>
          </div>
          <p className="v3-qr-caption">{t("ux.sendQrCaption")}</p>
          <button type="button" className="v3-qr-dl" onClick={downloadQr}>
            {t("ux.sendQrDownload")}
          </button>
        </div>

        <div className="v3-link-row">
          <input readOnly value={result.link} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="v3-copy-btn" onClick={copyLink}>
            {copied ? `✓ ${t("common.copied")}` : t("common.copy")}
          </button>
        </div>
        <button type="button" className="v3-btn-ghost" onClick={reset}>
          {t("ux.sendNewShare")}
        </button>
        <div className="v3-status">
          <span className="v3-pulse" />
          {t("ux.sendWaiting")}
        </div>
      </div>
    );
  }

  if (busy) {
    return (
      <div className="v3-result">
        <div style={{ fontSize: "2.5rem", marginBottom: "0.6rem" }}>🔒</div>
        <div className="v3-step">{step || t("ux.sendPreparing")}</div>
        <p className="v3-muted">{t("send.localOnlyProgress")}</p>
        <div className="v3-progress">
          <div className="v3-progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="v3-status">{pct}%</div>
      </div>
    );
  }

  return (
    <div>
      {browserOnly && (
        <div className="v3-warn" style={{ marginBottom: "1rem" }}>
          ⚠ {t("send.browserOnly")}
        </div>
      )}

      <div className="v3-step">{t("ux.sendStepFile")}</div>
      <div
        className={`v3-drop${dragging ? " is-drag" : ""}`}
        role="button"
        tabIndex={0}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          onChange={(e) => {
            if (e.currentTarget.files) addFiles(e.currentTarget.files);
            e.currentTarget.value = "";
          }}
          onClick={(e) => e.stopPropagation()}
        />
        <div className="v3-drop-bird" aria-hidden="true">
          🕊
        </div>
        <strong>{t("ux.sendDropTitle")}</strong>
        <span>{t("ux.sendDropHint")}</span>
      </div>

      {files.length > 0 && (
        <div className="v3-files">
          {files.map((f) => (
            <div key={f.id} className="v3-file">
              <div className="v3-file-thumb">{fileExtLabel(f.name)}</div>
              <div className="v3-file-meta">
                <strong>{f.name}</strong>
                <small>
                  {formatBytes(f.size)} · {t("ux.sendEncryptedLocal")}
                </small>
              </div>
              <button
                type="button"
                className="v3-file-rm"
                onClick={() => removeFile(f.id)}
                aria-label={t("common.remove")}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="v3-step" style={{ marginTop: "1.2rem" }}>
        {t("ux.sendStepShare")}
      </div>
      <div className="v3-paths">
        <button
          type="button"
          className={`v3-path${path === "link" ? " active" : ""}`}
          onClick={() => setPath("link")}
        >
          <strong>{t("ux.sendPathLinkTitle")}</strong>
          <span>{t("ux.sendPathLinkDesc")}</span>
        </button>
        <button
          type="button"
          className={`v3-path${path === "contact" ? " active" : ""}`}
          onClick={() => setPath("contact")}
        >
          <strong>{t("ux.sendPathContactTitle")}</strong>
          <span>{t("ux.sendPathContactDesc")}</span>
        </button>
      </div>

      {path === "link" ? (
        <div className="v3-field">
          <label className="v3-label">{t("send.emailOrPhone")}</label>
          <input
            type="text"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder={t("send.placeholderContact")}
            className="v3-input"
          />
        </div>
      ) : (
        <div className="v3-field">
          <label className="v3-label">{t("send.chooseContact")}</label>
          {addressBook.length === 0 ? (
            <div className="v3-warn">{t("send.noContacts")}</div>
          ) : (
            <div className="v3-contact-list">
              {addressBook.map((c) => (
                <button
                  key={c.hash}
                  type="button"
                  className={`v3-contact${recipient === c.contact ? " active" : ""}`}
                  onClick={() => setRecipient(c.contact)}
                >
                  <strong>{c.contact}</strong>
                  <small>
                    {c.x25519Key
                      ? t("send.keyReady")
                      : c.resolvedAgent
                        ? t("send.noX25519")
                        : t("send.notResolved")}
                  </small>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="v3-options">
        <div>
          <label className="v3-label">{t("send.expiry")}</label>
          <select value={expiry} onChange={(e) => setExpiry(e.target.value)} className="v3-input">
            <option value="24h">{t("send.expiry24h")}</option>
            <option value="7d">{t("send.expiry7d")}</option>
            <option value="30d">{t("send.expiry30d")}</option>
            <option value="never">{t("common.never")}</option>
          </select>
        </div>
        <div>
          <label className="v3-label">{t("send.maxDownloads")}</label>
          <select value={maxDl} onChange={(e) => setMaxDl(e.target.value)} className="v3-input">
            <option value="1">{t("send.times1")}</option>
            <option value="3">{t("send.times3")}</option>
            <option value="10">{t("send.times10")}</option>
            <option value="0">{t("common.unlimited")}</option>
          </select>
        </div>
      </div>

      {error && <div className="v3-warn" style={{ marginTop: "0.75rem" }}>⚠ {error}</div>}

      <button
        type="button"
        className="v3-btn-primary"
        onClick={createShare}
        disabled={busy || (!!files.length && (!isValidContact(recipient) || browserOnly))}
      >
        {path === "link" ? t("send.btnMagic") : t("send.btnContact")}
      </button>
      <p className="v3-footnote">{t("send.localEncryptNote")}</p>
    </div>
  );
}
