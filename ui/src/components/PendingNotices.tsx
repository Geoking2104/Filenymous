/**
 * PendingNotices — Boîte de réception des fichiers entrants.
 *
 * Affiche les parcels en attente pour le contact de l'utilisateur courant.
 * Requiert un conducteur Holochain local (lecture DHT + ECIES decrypt).
 *
 * Flow :
 *   1. Charger le contact_hash depuis le keystore local
 *   2. parcelZome.getPendingParcelsForContact(contactHash)
 *   3. Pour chaque parcel : afficher nom, taille, expéditeur
 *   4. Bouton "Télécharger" → déchiffrement ECIES + download
 */

import { useState, useEffect } from "react";
import { importAesKey }             from "../crypto/aes";
import { decryptAesKeyFromBlob }    from "../crypto/ecies";
import { loadPrivateKey }           from "../crypto/keystore";
import { decryptChunks, saveBlob } from "../crypto/chunker";
import { parcelZome }               from "../holochain/delivery";
import { fileStorageZome }          from "../holochain/fileStorage";
import { hasConductor }             from "../holochain/client";
import type { ParcelOutput }        from "../holochain/types";

function fmtSize(b: number) {
  if (!b) return "0 o";
  const k=1024,s=["o","Ko","Mo","Go","To"],i=Math.floor(Math.log(b)/Math.log(k));
  return parseFloat((b/Math.pow(k,i)).toFixed(1))+" "+s[i];
}
function fmtDate(ts: number) {
  return new Date(Math.floor(ts / 1000)).toLocaleDateString("fr-FR");
}

export default function PendingNotices() {
  const [parcels,    setParcels]    = useState<ParcelOutput[]>([]);
  const [loading,    setLoading]    = useState(false);
  const [contactHash, setContactHash] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null); // parcel_eh en cours
  const [step,       setStep]       = useState("");

  useEffect(() => {
    if (!hasConductor()) return;
    loadInbox();
  }, []); // eslint-disable-line

  const loadInbox = async () => {
    setLoading(true);
    try {
      // Récupérer le contact_hash depuis le keystore
      const stored = localStorage.getItem("filenymous:my_contact_hash");
      if (!stored) { setLoading(false); return; }
      setContactHash(stored);

      const results = await parcelZome.getPendingParcelsForContact(stored);
      setParcels(results);
    } catch (e) {
      console.error("Inbox:", e);
    } finally {
      setLoading(false);
    }
  };

  const downloadParcel = async (p: ParcelOutput) => {
    const ehStr = JSON.stringify(p.parcel_eh);
    setDownloading(ehStr);
    setStep("Chargement de votre clé X25519…");

    try {
      // Charger la clé privée X25519 depuis IndexedDB
      const privKey = await loadPrivateKey();

      setStep("Déchiffrement ECIES de la clé AES…");
      const blobB64  = p.manifest.encrypted_key_blob;
      const eciesBlob = Uint8Array.from(atob(blobB64), (c) => c.charCodeAt(0));
      const aesRawBytes = await decryptAesKeyFromBlob(eciesBlob, privKey);
      const aesKey      = await importAesKey(aesRawBytes);

      setStep("Récupération des chunks DHT…");
      const fileResult = await fileStorageZome.getFile(p.manifest.file_hash);
      if (!fileResult) throw new Error("Fichier introuvable sur le DHT.");

      setStep("Déchiffrement AES-256-GCM…");
      const blob = await decryptChunks(fileResult.chunks, aesKey, "application/octet-stream", {
        onChunk: (i, total) => setStep(`Chunk ${i+1}/${total} déchiffré…`),
      });

      saveBlob(blob, p.manifest.file_name);

      // Confirmer le téléchargement sur le DHT
      await parcelZome.confirmDownload(p.parcel_eh);

      // Retirer de la liste locale
      setParcels((prev) => prev.filter((x) => JSON.stringify(x.parcel_eh) !== ehStr));
    } catch (e) {
      alert("Erreur téléchargement : " + String(e));
    } finally {
      setDownloading(null);
      setStep("");
    }
  };

  if (!hasConductor()) return (
    <div className="card" style={{ textAlign:"center", padding:"2.5rem" }}>
      <div style={{ fontSize:"2.5rem", marginBottom:".8rem" }}>🌐</div>
      <div style={{ fontSize:"1rem", fontWeight:700, marginBottom:".4rem" }}>Mode Web Bridge actif</div>
      <div style={{ fontSize:".87rem", color:"var(--muted)" }}>
        La boîte de réception requiert <strong>Holochain Launcher</strong>.<br/>
        Pour recevoir un fichier via lien, utilisez directement l'URL partagée par l'expéditeur.
      </div>
    </div>
  );

  return (
    <div>
      <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:"1rem" }}>
        <div style={{ fontSize:"1rem", fontWeight:700 }}>Fichiers reçus</div>
        <button className="btn-ghost btn-sm" onClick={loadInbox} disabled={loading}>
          {loading ? <span className="spin" style={{ borderTopColor:"var(--g1)" }} /> : "↻ Actualiser"}
        </button>
      </div>

      {!contactHash && (
        <div className="warn-box">
          ⚠ Aucun contact enregistré. Rendez-vous dans <strong>Identité</strong> pour publier votre email ou téléphone sur le DHT.
        </div>
      )}

      {parcels.length === 0 && !loading && (
        <div className="empty">
          <div style={{ fontSize:"2.2rem", marginBottom:".6rem" }}>📭</div>
          Aucun fichier en attente
        </div>
      )}

      {parcels.map((p) => {
        const ehStr      = JSON.stringify(p.parcel_eh);
        const isThisOne  = downloading === ehStr;
        const expiryDate = p.manifest.expiry_us > 0
          ? fmtDate(p.manifest.expiry_us)
          : null;

        return (
          <div key={ehStr} style={{ display:"flex",alignItems:"flex-start",gap:".9rem",padding:"1rem 1.1rem",background:"#fff",border:"1px solid var(--border)",borderRadius:"12px",marginBottom:".6rem",boxShadow:"var(--shadow)" }}>
            <div style={{ width:"42px",height:"42px",borderRadius:"9px",background:"var(--grad-soft)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"1.3rem",flexShrink:0 }}>📄</div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:".9rem",fontWeight:600,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>
                {p.manifest.file_name}
              </div>
              <div style={{ fontSize:".75rem",color:"var(--muted)",marginTop:".15rem" }}>
                {fmtSize(p.manifest.file_size)}
                {expiryDate && ` · Expire le ${expiryDate}`}
              </div>
              {isThisOne && (
                <div style={{ fontSize:".75rem",color:"var(--g2)",marginTop:".3rem" }}>{step}</div>
              )}
            </div>
            <button
              className="btn-success btn-sm"
              disabled={downloading !== null}
              onClick={() => downloadParcel(p)}
              style={{ flexShrink:0, minWidth:"90px" }}>
              {isThisOne
                ? <span style={{ display:"flex",alignItems:"center",gap:".3rem" }}><span className="spin"/>…</span>
                : "⬇ Recevoir"
              }
            </button>
          </div>
        );
      })}
    </div>
  );
}
