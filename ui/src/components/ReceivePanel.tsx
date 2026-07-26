/**
 * ReceivePanel v2 — download via one-time link + manual paste
 *
 * Format: #<parcel_eh_b64url>:<aes_key_b64url>
 */

import { useState, useEffect } from "react";
import { importAesKey }           from "../crypto/aes";
import { decryptChunks, saveBlob } from "../crypto/chunker";
import { parcelZome, webBridgeGetParcel } from "../holochain/delivery";
import { fileStorageZome, webBridgeGetFile } from "../holochain/fileStorage";
import { hasConductor, initClient } from "../holochain/client";
import type { ParcelOutput } from "../holochain/types";

type RxState = "idle" | "found" | "downloading" | "done" | "error";

function fmtSize(b: number) {
  if (!b) return "0 o";
  const k = 1024, s = ["o", "Ko", "Mo", "Go", "To"], i = Math.floor(Math.log(b) / Math.log(k));
  return parseFloat((b / Math.pow(k, i)).toFixed(1)) + " " + s[i];
}

function decodeB64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(s.length + (4 - s.length % 4) % 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Extract parcelEh + aesKey from a full URL or a raw #fragment */
function parseMagicInput(raw: string): { parcelEhB64: string; aesKeyB64: string } | null {
  let value = raw.trim();
  if (!value) return null;

  // Full URL → take hash fragment
  if (value.includes("#")) {
    value = value.split("#").pop() || "";
  }
  // Strip leading #
  if (value.startsWith("#")) value = value.slice(1);

  if (!value.includes(":")) return null;
  const [parcelEhB64, aesKeyB64] = value.split(":");
  if (!parcelEhB64 || !aesKeyB64) return null;
  return { parcelEhB64, aesKeyB64 };
}

export default function ReceivePanel() {
  const [state, setState]     = useState<RxState>("idle");
  const [parcel, setParcel]   = useState<ParcelOutput | null>(null);
  const [aesKey, setAesKey]   = useState<CryptoKey | null>(null);
  const [pct, setPct]         = useState(0);
  const [step, setStep]       = useState("");
  const [errMsg, setErrMsg]   = useState("");
  const [paste, setPaste]     = useState("");

  // Auto from URL hash
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash.includes(":")) return;
    const [parcelEhB64, aesKeyB64] = hash.split(":");
    if (!parcelEhB64 || !aesKeyB64) return;
    resolveFromUrl(parcelEhB64, aesKeyB64);
  }, []); // eslint-disable-line

  const resolveFromUrl = async (parcelEhB64: string, aesKeyB64: string) => {
    setState("idle");
    setErrMsg("");
    try {
      await initClient();
      setPct(10);
      setStep("Récupération du manifest DHT…");

      const parcelEhBytes = decodeB64Url(parcelEhB64);

      let result: ParcelOutput | null;
      if (hasConductor()) {
        result = await parcelZome.getParcel(Array.from(parcelEhBytes) as unknown as any);
      } else {
        result = await webBridgeGetParcel(parcelEhB64);
      }

      if (!result) {
        setErrMsg("Transfert introuvable ou expiré.");
        setState("error");
        return;
      }
      if (result.is_revoked) {
        setErrMsg("Ce transfert a été révoqué par l'expéditeur.");
        setState("error");
        return;
      }
      if (result.manifest.expiry_us > 0 && Date.now() * 1000 > result.manifest.expiry_us) {
        setErrMsg("Ce transfert a expiré.");
        setState("error");
        return;
      }

      const aesRaw = decodeB64Url(aesKeyB64);
      const key = await importAesKey(aesRaw);

      setParcel(result);
      setAesKey(key);
      setState("found");
      setPct(0);
    } catch (e) {
      setErrMsg("Erreur : " + String(e));
      setState("error");
    }
  };

  const handlePasteSubmit = () => {
    const parsed = parseMagicInput(paste);
    if (!parsed) {
      setErrMsg("Lien ou code invalide. Format attendu : …/#parcel:key");
      setState("error");
      return;
    }
    resolveFromUrl(parsed.parcelEhB64, parsed.aesKeyB64);
  };

  const download = async () => {
    if (!parcel || !aesKey) return;
    setState("downloading");
    setPct(0);
    const prog = (p: number, s: string) => { setPct(p); setStep(s); };

    try {
      prog(15, "Récupération des chunks DHT…");

      let chunks: Uint8Array[];
      const fileHashBytes = parcel.manifest.file_hash as unknown as number[];

      if (hasConductor()) {
        const fileResult = await fileStorageZome.getFile(fileHashBytes as unknown as any);
        if (!fileResult) throw new Error("Fichier introuvable sur le DHT.");
        chunks = fileResult.chunks;
      } else {
        const fileHashB64 = btoa(String.fromCharCode(...fileHashBytes))
          .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
        const fileResult = await webBridgeGetFile(fileHashB64);
        if (!fileResult) throw new Error("Fichier introuvable via Web Bridge.");
        chunks = fileResult.chunks;
      }

      prog(55, "Déchiffrement AES-256-GCM…");
      const blob = await decryptChunks(chunks, aesKey, "application/octet-stream", {
        onChunk: (i, total) => prog(55 + Math.round((i / total) * 35), `Chunk ${i + 1}/${total} déchiffré…`),
      });

      prog(95, "Sauvegarde…");
      saveBlob(blob, parcel.manifest.file_name);

      if (hasConductor()) {
        try { await parcelZome.confirmDownload(parcel.parcel_eh); } catch { /* non bloquant */ }
      }

      prog(100, "Terminé !");
      setState("done");
    } catch (e) {
      setErrMsg("Erreur lors du téléchargement : " + String(e));
      setState("error");
    }
  };

  if (state === "error") return (
    <div className="card" style={{ textAlign: "center", padding: "2.5rem" }}>
      <div style={{ fontSize: "3rem", marginBottom: ".8rem" }}>❌</div>
      <div style={{ fontSize: "1rem", fontWeight: 700, color: "var(--err)", marginBottom: ".6rem" }}>
        Impossible d'accéder au fichier
      </div>
      <div style={{ fontSize: ".87rem", color: "var(--muted)", marginBottom: "1.2rem" }}>{errMsg}</div>
      <button className="btn-ghost" onClick={() => { setState("idle"); setErrMsg(""); setPaste(""); }}>
        Réessayer
      </button>
    </div>
  );

  if (state === "done") return (
    <div className="card" style={{ textAlign: "center", padding: "2.5rem" }}>
      <div style={{ fontSize: "3rem", marginBottom: ".8rem" }}>🎉</div>
      <div style={{ fontSize: "1.1rem", fontWeight: 700, marginBottom: ".4rem" }}>Fichier téléchargé !</div>
      <div style={{ fontSize: ".87rem", color: "var(--muted)" }}>
        «{parcel?.manifest.file_name}» déchiffré et sauvegardé localement.
      </div>
    </div>
  );

  if ((state === "found" || state === "downloading") && parcel) return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: ".9rem", marginBottom: "1.3rem" }}>
        <div style={{ fontSize: "2.2rem", background: "var(--grad-soft)", borderRadius: "10px", width: "52px", height: "52px", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>📄</div>
        <div>
          <div style={{ fontSize: "1rem", fontWeight: 700 }}>{parcel.manifest.file_name}</div>
          <div style={{ fontSize: ".78rem", color: "var(--muted)" }}>
            {fmtSize(parcel.manifest.file_size)} · {parcel.manifest.chunk_count} chunks chiffrés
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: ".6rem", marginBottom: "1.1rem" }}>
        <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "9px", padding: ".65rem .9rem" }}>
          <div style={{ fontSize: ".7rem", color: "var(--muted)", marginBottom: ".15rem" }}>Téléchargements</div>
          <div style={{ fontSize: ".85rem", fontWeight: 600 }}>
            {parcel.download_count}/{parcel.manifest.max_downloads === 0 ? "∞" : parcel.manifest.max_downloads}
          </div>
        </div>
        <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "9px", padding: ".65rem .9rem" }}>
          <div style={{ fontSize: ".7rem", color: "var(--muted)", marginBottom: ".15rem" }}>Réseau</div>
          <div style={{ fontSize: ".85rem", fontWeight: 600 }}>{hasConductor() ? "Holochain local" : "Holo Web Bridge"}</div>
        </div>
      </div>

      {state === "downloading" && (
        <div style={{ marginBottom: ".8rem" }}>
          <div className="progress-bar"><div className="progress-fill" style={{ width: pct + "%" }} /></div>
          <div style={{ fontSize: ".77rem", color: "var(--muted)", marginTop: ".35rem" }}>{step}</div>
        </div>
      )}

      <div className="info-box">
        🔒 Clé AES dans le fragment <code>#</code> de l'URL — elle n'a jamais transité sur le réseau.
        Déchiffrement 100&nbsp;% local.
      </div>

      <button className="btn-success btn-full" style={{ padding: ".75rem" }}
        disabled={state === "downloading"} onClick={download}>
        {state === "downloading"
          ? <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: ".5rem" }}><span className="spin" />{step || "…"}</span>
          : "⬇ Télécharger & Déchiffrer"
        }
      </button>
    </div>
  );

  // idle — manual paste
  return (
    <div className="card" style={{ padding: "2rem" }}>
      <div style={{ textAlign: "center", marginBottom: "1.5rem" }}>
        <div style={{ fontSize: "2.5rem", marginBottom: ".5rem" }}>🔗</div>
        <div style={{ fontSize: "1.15rem", fontWeight: 700, marginBottom: ".35rem" }}>Receive a file</div>
        <div style={{ fontSize: ".87rem", color: "var(--muted)" }}>
          Collez un Magic Link ou un code Filenymous
        </div>
      </div>

      <div className="form-row">
        <label className="form-label">Magic Link ou code</label>
        <input
          type="text"
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handlePasteSubmit()}
          placeholder="https://filenymous.eu/#parcel:key  ou  parcel:key"
          style={{ fontFamily: "monospace", fontSize: ".85rem" }}
        />
      </div>

      <button
        className="btn-primary btn-full"
        style={{ padding: ".75rem", marginTop: ".5rem" }}
        disabled={!paste.trim()}
        onClick={handlePasteSubmit}
      >
        Continuer
      </button>

      <p style={{ textAlign: "center", fontSize: ".75rem", color: "var(--muted)", marginTop: "1rem" }}>
        La clé de déchiffrement reste dans le fragment # — elle ne transite jamais sur le réseau.
      </p>
    </div>
  );
}
