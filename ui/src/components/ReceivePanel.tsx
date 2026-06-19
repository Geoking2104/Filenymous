/**
 * ReceivePanel v2 — gère le téléchargement via lien one-time.
 *
 * Format de l'URL fragment :  #<parcel_eh_b64url>:<aes_key_b64url>
 *   - parcel_eh_b64url : EntryHash du ParcelManifest (base64url)
 *   - aes_key_b64url   : Clé AES-256 brute (base64url) — NE transite PAS sur le réseau
 *
 * Mode WebSocket (conducteur local) :
 *   → parcelZome.getParcel() + fileStorageZome.getFile()
 *
 * Mode Web Bridge (aucun conducteur) :
 *   → webBridgeGetParcel() + webBridgeGetFile() via HTTP GET
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
  const k=1024,s=["o","Ko","Mo","Go","To"],i=Math.floor(Math.log(b)/Math.log(k));
  return parseFloat((b/Math.pow(k,i)).toFixed(1))+" "+s[i];
}

function decodeB64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g,"+").replace(/_/g,"/").padEnd(s.length + (4 - s.length % 4) % 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export default function ReceivePanel() {
  const [state,   setState]   = useState<RxState>("idle");
  const [parcel,  setParcel]  = useState<ParcelOutput | null>(null);
  const [aesKey,  setAesKey]  = useState<CryptoKey | null>(null);
  const [pct,     setPct]     = useState(0);
  const [step,    setStep]    = useState("");
  const [errMsg,  setErrMsg]  = useState("");

  // Décodage automatique depuis le fragment URL
  useEffect(() => {
    const hash = window.location.hash.slice(1); // retire le #
    if (!hash.includes(":")) return;

    const [parcelEhB64, aesKeyB64] = hash.split(":");
    if (!parcelEhB64 || !aesKeyB64) return;

    resolveFromUrl(parcelEhB64, aesKeyB64);
  }, []); // eslint-disable-line

  const resolveFromUrl = async (parcelEhB64: string, aesKeyB64: string) => {
    setState("idle");
    try {
      await initClient();

      setPct(10); setStep("Récupération du manifest DHT…");

      // Convertir base64url → bytes → EntryHash Holochain
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

      // Import de la clé AES depuis le fragment URL
      const aesRaw = decodeB64Url(aesKeyB64);
      const key    = await importAesKey(aesRaw);

      setParcel(result);
      setAesKey(key);
      setState("found");
      setPct(0);
    } catch (e) {
      setErrMsg("Erreur : " + String(e));
      setState("error");
    }
  };

  const download = async () => {
    if (!parcel || !aesKey) return;
    setState("downloading"); setPct(0);
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
        // Encoder file_hash en base64url pour Web Bridge
        const fileHashB64 = btoa(String.fromCharCode(...fileHashBytes))
          .replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
        const fileResult = await webBridgeGetFile(fileHashB64);
        if (!fileResult) throw new Error("Fichier introuvable via Web Bridge.");
        chunks = fileResult.chunks;
      }

      prog(55, "Déchiffrement AES-256-GCM…");
      const blob = await decryptChunks(chunks, aesKey, "application/octet-stream", {
        onChunk: (i, total) => prog(55 + Math.round((i/total)*35), `Chunk ${i+1}/${total} déchiffré…`),
      });

      prog(95, "Sauvegarde…");
      saveBlob(blob, parcel.manifest.file_name);

      // Confirmer le téléchargement si le conducteur est disponible
      if (hasConductor()) {
        try {
          await parcelZome.confirmDownload(parcel.parcel_eh);
        } catch { /* non bloquant */ }
      }

      prog(100, "Terminé !");
      setState("done");
    } catch (e) {
      setErrMsg("Erreur lors du téléchargement : " + String(e));
      setState("error");
    }
  };

  if (state === "error") return (
    <div className="card" style={{ textAlign:"center", padding:"2.5rem" }}>
      <div style={{ fontSize:"3rem", marginBottom:".8rem" }}>❌</div>
      <div style={{ fontSize:"1rem", fontWeight:700, color:"var(--err)", marginBottom:".6rem" }}>Impossible d'accéder au fichier</div>
      <div style={{ fontSize:".87rem", color:"var(--muted)" }}>{errMsg}</div>
    </div>
  );

  if (state === "done") return (
    <div className="card" style={{ textAlign:"center", padding:"2.5rem" }}>
      <div style={{ fontSize:"3rem", marginBottom:".8rem" }}>🎉</div>
      <div style={{ fontSize:"1.1rem", fontWeight:700, marginBottom:".4rem" }}>Fichier téléchargé !</div>
      <div style={{ fontSize:".87rem", color:"var(--muted)" }}>«{parcel?.manifest.file_name}» déchiffré et sauvegardé localement.</div>
    </div>
  );

  if ((state === "found" || state === "downloading") && parcel) return (
    <div className="card">
      <div style={{ display:"flex",alignItems:"center",gap:".9rem",marginBottom:"1.3rem" }}>
        <div style={{ fontSize:"2.2rem",background:"var(--grad-soft)",borderRadius:"10px",width:"52px",height:"52px",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>📄</div>
        <div>
          <div style={{ fontSize:"1rem",fontWeight:700 }}>{parcel.manifest.file_name}</div>
          <div style={{ fontSize:".78rem",color:"var(--muted)" }}>
            {fmtSize(parcel.manifest.file_size)} · {parcel.manifest.chunk_count} chunks chiffrés
          </div>
        </div>
      </div>

      <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:".6rem",marginBottom:"1.1rem" }}>
        <div style={{ background:"var(--bg)",border:"1px solid var(--border)",borderRadius:"9px",padding:".65rem .9rem" }}>
          <div style={{ fontSize:".7rem",color:"var(--muted)",marginBottom:".15rem" }}>Téléchargements</div>
          <div style={{ fontSize:".85rem",fontWeight:600 }}>
            {parcel.download_count}/{parcel.manifest.max_downloads === 0 ? "∞" : parcel.manifest.max_downloads}
          </div>
        </div>
        <div style={{ background:"var(--bg)",border:"1px solid var(--border)",borderRadius:"9px",padding:".65rem .9rem" }}>
          <div style={{ fontSize:".7rem",color:"var(--muted)",marginBottom:".15rem" }}>Réseau</div>
          <div style={{ fontSize:".85rem",fontWeight:600 }}>{hasConductor() ? "Holochain local" : "Holo Web Bridge"}</div>
        </div>
      </div>

      {state === "downloading" && (
        <div style={{ marginBottom:".8rem" }}>
          <div className="progress-bar"><div className="progress-fill" style={{ width:pct+"%" }} /></div>
          <div style={{ fontSize:".77rem",color:"var(--muted)",marginTop:".35rem" }}>{step}</div>
        </div>
      )}

      <div className="info-box">
        🔒 Clé AES dans le fragment <code>#</code> de l'URL — elle n'a jamais transité sur le réseau.
        Déchiffrement 100&nbsp;% local.
      </div>

      <button className="btn-success btn-full" style={{ padding:".75rem" }}
        disabled={state === "downloading"} onClick={download}>
        {state === "downloading"
          ? <span style={{ display:"flex",alignItems:"center",justifyContent:"center",gap:".5rem" }}><span className="spin"/>{step||"…"}</span>
          : "⬇ Télécharger & Déchiffrer"
        }
      </button>
    </div>
  );

  // idle — ne s'affiche que si le fragment URL est mal formé ou absent
  return (
    <div className="card" style={{ textAlign:"center", padding:"3rem 1.5rem" }}>
      <div style={{ fontSize:"3rem", marginBottom:".8rem" }}>🔗</div>
      <div style={{ fontSize:"1.1rem", fontWeight:700, marginBottom:".6rem" }}>Lien invalide ou manquant</div>
      <div style={{ fontSize:".87rem", color:"var(--muted)" }}>
        Ce panel s'ouvre automatiquement depuis un lien Filenymous.<br/>
        Format attendu : <code>https://filenymous.app/#&lt;parcel&gt;:&lt;key&gt;</code>
      </div>
    </div>
  );
}
