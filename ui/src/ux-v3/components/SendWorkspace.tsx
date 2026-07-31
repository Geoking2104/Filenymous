import { useCallback, useRef, useState, type DragEvent } from "react";
import { QRCodeCanvas, QRCodeSVG } from "qrcode.react";
import {
  createShareCode,
  fileExtLabel,
  formatBytes,
  type LocalFileItem,
  type SharePath,
  type ShareResult,
} from "../types";

interface Props {
  /** Hook real encryption / Magic Link here */
  onShare?: (files: LocalFileItem[], path: SharePath) => Promise<ShareResult> | ShareResult;
}

/** Petit logo pigeon inline (SVG data-URI) — 100 % local, zéro réseau */
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

export default function SendWorkspace({ onShare }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const qrCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [files, setFiles] = useState<LocalFileItem[]>([]);
  const [path, setPath] = useState<SharePath>("link");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ShareResult | null>(null);
  const [copied, setCopied] = useState(false);

  const addFiles = useCallback((list: FileList | File[]) => {
    const next: LocalFileItem[] = Array.from(list).map((file) => ({
      id: `f-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: file.name,
      size: file.size,
      mimeType: file.type || "application/octet-stream",
      file,
    }));
    setFiles((prev) => [...prev, ...next]);
  }, []);

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
    setBusy(true);
    try {
      const code = createShareCode();
      const link = `https://filenymous.eu/#${code.replace(/·/g, "")}:…`;
      const res =
        (await onShare?.(files, path)) ??
        ({ code, link, createdAt: Date.now() } satisfies ShareResult);
      setResult(res);
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
    setCopied(false);
  };

  if (result) {
    return (
      <div className="v3-result">
        <div className="v3-step">Partage prêt</div>
        <p className="v3-muted" style={{ marginBottom: 0 }}>
          Donnez ce code ou ce lien au destinataire
        </p>
        <div className="v3-code">{result.code}</div>

        <div className="v3-qr-wrap">
          <div className="v3-qr">
            {/* Affichage SVG net (écrans retina) */}
            <QRCodeSVG
              value={result.link}
              size={200}
              level="H"
              marginSize={2}
              bgColor="#ffffff"
              fgColor="#0f172a"
              title="QR code Filenymous — scannez pour ouvrir le partage"
              imageSettings={{
                src: PIGEON_LOGO,
                height: 36,
                width: 36,
                excavate: true,
              }}
            />
            {/* Canvas caché pour export PNG haute qualité */}
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
          <p className="v3-qr-caption">Scannez pour ouvrir le partage</p>
          <button type="button" className="v3-qr-dl" onClick={downloadQr}>
            ⬇ Télécharger le QR
          </button>
        </div>

        <div className="v3-link-row">
          <input readOnly value={result.link} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="v3-copy-btn" onClick={copyLink}>
            {copied ? "✓ Copié" : "Copier"}
          </button>
        </div>
        <button type="button" className="v3-btn-ghost" onClick={reset}>
          Nouveau partage
        </button>
        <div className="v3-status">
          <span className="v3-pulse" />
          En attente du destinataire · restez sur cette page
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="v3-step">1 · Fichier</div>
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
        <strong>Déposez vos fichiers ici</strong>
        <span>ou cliquez pour parcourir — chiffrement local immédiat</span>
      </div>

      {files.length > 0 && (
        <div className="v3-files">
          {files.map((f) => (
            <div key={f.id} className="v3-file">
              <div className="v3-file-thumb">{fileExtLabel(f.name)}</div>
              <div className="v3-file-meta">
                <strong>{f.name}</strong>
                <small>
                  {formatBytes(f.size)} · chiffré localement
                </small>
              </div>
              <button type="button" className="v3-file-rm" onClick={() => removeFile(f.id)} aria-label="Retirer">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="v3-step" style={{ marginTop: "1.2rem" }}>
        2 · Comment partager
      </div>
      <div className="v3-paths">
        <button
          type="button"
          className={`v3-path${path === "link" ? " active" : ""}`}
          onClick={() => setPath("link")}
        >
          <strong>🔗 Lien magique</strong>
          <span>Un lien chiffré à coller. Simple et universel.</span>
        </button>
        <button
          type="button"
          className={`v3-path${path === "contact" ? " active" : ""}`}
          onClick={() => setPath("contact")}
        >
          <strong>👤 Contact</strong>
          <span>Envoyer à quelqu’un de votre carnet (clé X25519).</span>
        </button>
      </div>

      <button
        type="button"
        className="v3-btn-primary"
        onClick={createShare}
        disabled={busy}
      >
        {busy ? "Préparation…" : "Créer le partage privé"}
      </button>
    </div>
  );
}
