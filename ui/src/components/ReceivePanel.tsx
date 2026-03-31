/**
 * ReceivePanel — resolve a transfer link and download the file.
 *
 * The link format is: ?d=<transfer_id>&k=<base64_aes_key>
 * In M3, the key will be ECIES-encrypted; in M2 it's transmitted in the URL
 * (acceptable for prototype, TODO before production).
 */

import { useState, useEffect } from "react";
import { importAesKey }  from "../crypto/aes";
import { decryptChunks, saveBlob } from "../crypto/chunker";
import { transferZome }  from "../holochain/transfer";
import { storageZome }   from "../holochain/storage";
import type { TransferManifest } from "../holochain/types";

type RxState = "idle" | "found" | "done";

function fmtSize(b: number) {
  if (!b) return "0 o";
  const k=1024,s=["o","Ko","Mo","Go","To"],i=Math.floor(Math.log(b)/Math.log(k));
  return parseFloat((b/Math.pow(k,i)).toFixed(1))+" "+s[i];
}

export default function ReceivePanel() {
  const [rxLink,  setRxLink]  = useState("");
  const [state,   setState]   = useState<RxState>("idle");
  const [manifest, setManifest] = useState<TransferManifest | null>(null);
  const [pct,     setPct]     = useState(0);
  const [step,    setStep]    = useState("");
  const [loading, setLoading] = useState(false);

  // Auto-resolve if URL contains ?d= param
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    if (p.get("d")) {
      setRxLink(location.href);
      resolveLink(location.href);
    }
  }, []); // eslint-disable-line

  const resolveLink = async (link: string) => {
    setLoading(true);
    try {
      const url        = new URL(link);
      const transferId = url.searchParams.get("d");
      if (!transferId) throw new Error("Lien invalide");
      const result = await transferZome.getTransfer(transferId);
      if (!result) throw new Error("Transfert introuvable ou expiré");
      setManifest(result.manifest);
      setState("found");
    } catch (e) {
      alert("Erreur : " + String(e));
    } finally {
      setLoading(false);
    }
  };

  const download = async () => {
    if (!manifest) return;
    setLoading(true); setPct(0);
    const progress = (p: number, s: string) => { setPct(p); setStep(s); };
    try {
      // Extract AES key from URL (M2 — plaintext, TODO ECIES in M3)
      const url     = new URL(rxLink);
      const keyB64  = url.searchParams.get("k");
      if (!keyB64) throw new Error("Clé de déchiffrement absente du lien");
      const keyRaw  = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0));
      const aesKey  = await importAesKey(keyRaw);

      progress(15, "Récupération des chunks DHT…");
      const { chunks } = await storageZome.getChunks(manifest.transfer_id);

      progress(50, "Déchiffrement AES-256-GCM…");
      const encryptedBuffers = chunks.map((c) =>
        c.chunk.encrypted_data instanceof Uint8Array
          ? c.chunk.encrypted_data
          : new Uint8Array(c.chunk.encrypted_data as number[])
      );

      const blob = await decryptChunks(encryptedBuffers, aesKey, undefined, {
        onChunk: (i, total) => progress(50 + Math.round((i/total)*40), `Chunk ${i+1}/${total} déchiffré…`),
      });

      progress(95, "Sauvegarde du fichier…");
      saveBlob(blob, manifest.file_name);

      // Record download on DHT
      await transferZome.recordDownload({
        transfer_id:    manifest.transfer_id,
        download_count: 1,
      });

      progress(100, "Terminé !");
      setState("done");
    } catch (e) {
      alert("Erreur lors du téléchargement : " + String(e));
    } finally {
      setLoading(false);
    }
  };

  if (state === "done") return (
    <div className="card" style={{ textAlign:"center",padding:"2.5rem" }}>
      <div style={{ fontSize:"3rem",marginBottom:".8rem" }}>🎉</div>
      <div style={{ fontSize:"1.1rem",fontWeight:700,marginBottom:".4rem" }}>Fichier téléchargé !</div>
      <div style={{ fontSize:".87rem",color:"var(--muted)",marginBottom:"1.4rem" }}>
        «{manifest?.file_name}» déchiffré et sauvegardé.
      </div>
      <button className="btn-ghost" onClick={() => { setState("idle"); setRxLink(""); setManifest(null); setPct(0); }}>
        Recevoir un autre fichier
      </button>
    </div>
  );

  if (state === "found" && manifest) return (
    <div className="card">
      <div style={{ display:"flex",alignItems:"center",gap:".9rem",marginBottom:"1.3rem" }}>
        <div style={{ fontSize:"2.2rem",background:"var(--grad-soft)",borderRadius:"10px",width:"52px",height:"52px",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>📄</div>
        <div>
          <div style={{ fontSize:"1rem",fontWeight:700 }}>{manifest.file_name}</div>
          <div style={{ fontSize:".78rem",color:"var(--muted)" }}>{fmtSize(manifest.file_size)} · {manifest.chunk_count} chunks chiffrés</div>
        </div>
      </div>

      <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:".6rem",marginBottom:"1.1rem" }}>
        <div style={{ background:"var(--bg)",border:"1px solid var(--border)",borderRadius:"9px",padding:".65rem .9rem" }}>
          <div style={{ fontSize:".7rem",color:"var(--muted)",marginBottom:".15rem" }}>Téléchargements max</div>
          <div style={{ fontSize:".85rem",fontWeight:600 }}>{manifest.max_downloads === 0 ? "Illimité" : manifest.max_downloads}</div>
        </div>
        <div style={{ background:"var(--bg)",border:"1px solid var(--border)",borderRadius:"9px",padding:".65rem .9rem" }}>
          <div style={{ fontSize:".7rem",color:"var(--muted)",marginBottom:".15rem" }}>Statut</div>
          <div style={{ fontSize:".85rem",fontWeight:600 }}>{manifest.status}</div>
        </div>
      </div>

      {pct > 0 && pct < 100 && (
        <div style={{ marginBottom: ".8rem" }}>
          <div className="progress-bar"><div className="progress-fill" style={{ width:pct+"%" }} /></div>
          <div style={{ fontSize:".77rem",color:"var(--muted)",marginTop:".35rem" }}>{step}</div>
        </div>
      )}

      <div className="info-box">🔒 Déchiffrement dans votre navigateur — le fichier en clair ne quitte pas votre appareil.</div>

      <button className="btn-success btn-full" style={{ padding:".75rem" }} disabled={loading} onClick={download}>
        {loading
          ? <span style={{ display:"flex",alignItems:"center",justifyContent:"center",gap:".5rem" }}><span className="spin" />{step || "Chargement…"}</span>
          : "⬇ Télécharger & Déchiffrer"
        }
      </button>
    </div>
  );

  // idle
  return (
    <div className="card">
      <div style={{ textAlign:"center",padding:"2.5rem 1rem" }}>
        <div style={{ fontSize:"3rem",marginBottom:".8rem" }}>📥</div>
        <div style={{ fontSize:"1.1rem",fontWeight:700,marginBottom:".4rem" }}>Recevoir un fichier</div>
        <div style={{ fontSize:".87rem",color:"var(--muted)",marginBottom:"1.6rem" }}>Collez le lien reçu par email ou SMS.</div>
        <div className="form-row" style={{ maxWidth:"420px",margin:"0 auto 1.2rem",textAlign:"left" }}>
          <label className="form-label">Lien de transfert</label>
          <input type="text" value={rxLink} onChange={(e) => setRxLink(e.target.value)} placeholder="https://…?d=…&k=…" />
        </div>
        <button className="btn-primary" style={{ padding:".6rem 2rem" }} disabled={!rxLink || loading}
          onClick={() => resolveLink(rxLink)}>
          {loading ? <span className="spin" /> : "Accéder au fichier"}
        </button>
      </div>
    </div>
  );
}
