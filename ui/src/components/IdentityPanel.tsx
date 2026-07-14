import { useState, useEffect } from "react";
import { hashContact }          from "../crypto/contact";
import { identityZome }         from "../holochain/identity";
import { useStore }             from "../store/useStore";
import {
  loadOrCreateKeyPair,
  loadPublicKeyBytes,
  exportKeyPairBackup,
  importKeyPairBackup,
} from "../crypto/keystore";

declare const __BRIDGE_URL__: string;

/** Convert raw bytes to base64 string */
function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

export default function IdentityPanel() {
  const { pubkey, contacts, addContact, removeContact } = useStore();
  const [newContact, setNewContact] = useState("");
  const [otpStep,    setOtpStep]    = useState(false);
  const [otpCode,    setOtpCode]    = useState("");
  const [pkCopied,   setPkCopied]   = useState(false);
  const [loading,    setLoading]    = useState(false);
  const [x25519Pub,  setX25519Pub]  = useState<string | null>(null);
  const [keyBusy,    setKeyBusy]    = useState(false);
  const [published,  setPublished]  = useState(false);

  // M3: Load or display existing X25519 public key on mount
  useEffect(() => {
    loadPublicKeyBytes().then((bytes) => {
      if (bytes) setX25519Pub(toBase64(bytes));
    }).catch(() => {/* no key yet */});
  }, []);

  /** M3 — generate (or load) the local X25519 keypair without requiring an OTP flow. */
  const generateKey = async () => {
    setKeyBusy(true);
    try {
      const { publicKeyBytes } = await loadOrCreateKeyPair();
      setX25519Pub(toBase64(publicKeyBytes));
      setPublished(false);
    } catch (e) { alert("Erreur generation de cle : " + String(e)); }
    finally { setKeyBusy(false); }
  };

  /** M3 — publish the local X25519 public key on the DHT (requires conductor). */
  const publishKey = async () => {
    if (!x25519Pub) return;
    setKeyBusy(true);
    try {
      await identityZome.publishX25519Key(x25519Pub);
      setPublished(true);
    } catch (e) { alert("Publication impossible — verifiez la connexion au conducteur Holochain : " + String(e)); }
    finally { setKeyBusy(false); }
  };

  /** Backup — download the keypair as filenymous-keys.json (private key included). */
  const exportKeys = async () => {
    const backup = await exportKeyPairBackup();
    if (!backup) { alert("Aucune cle a exporter — generez d'abord votre cle X25519."); return; }
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url;
    a.download = "filenymous-keys.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  /** Backup — restore a keypair from a filenymous-keys.json file. */
  const importKeys = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      if (!data.publicKey || !data.privateKey) throw new Error("Fichier de sauvegarde invalide");
      await importKeyPairBackup(data.publicKey, data.privateKey);
      setX25519Pub(data.publicKey);
      setPublished(false);
      alert("Cles importees. Pensez a republier votre cle publique sur le DHT si necessaire.");
    } catch (e) { alert("Import impossible : " + String(e)); }
  };

  const validContact = (v: string) =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || /^\+[1-9]\d{7,14}$/.test(v);

  const sendOtp = async () => {
    setLoading(true);
    try {
      await fetch(`${__BRIDGE_URL__}/otp/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact: newContact }),
      });
      setOtpStep(true);
    } catch { alert("Erreur envoi OTP — bridge indisponible en dev"); setOtpStep(true); }
    finally { setLoading(false); }
  };

  const verifyOtp = async () => {
    setLoading(true);
    try {
      await fetch(`${__BRIDGE_URL__}/otp/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact: newContact, code: otpCode }),
      });

      // M3: generate (or load) X25519 keypair and publish it alongside the ContactClaim
      const { publicKeyBytes } = await loadOrCreateKeyPair();
      const pubKeyB64 = toBase64(publicKeyBytes);

      const h = await hashContact(newContact);
      await identityZome.claimContact(h);
      await identityZome.publishX25519Key(pubKeyB64);

      setX25519Pub(pubKeyB64);
      addContact({ contact: newContact, hash: h });
      setOtpStep(false); setOtpCode(""); setNewContact("");
    } catch (e) { alert("Erreur vérification : " + String(e)); }
    finally { setLoading(false); }
  };

  const revokeContact = async (hash: string, contact: string) => {
    if (!confirm(`Révoquer le ContactClaim pour ${contact} ?`)) return;
    try {
      await identityZome.revokeContactClaim(hash);
      removeContact(hash);
    } catch (e) { alert("Erreur révocation : " + String(e)); }
  };

  return (
    <div>
      {/* Clé publique Holochain */}
      <div className="card">
        <div className="card-label">Ma clé publique (agent Holochain)</div>
        <div style={{ display:"flex",alignItems:"center",gap:".8rem" }}>
          <div style={{ width:"38px",height:"38px",borderRadius:"50%",background:"var(--grad)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:".95rem",color:"#fff",fontWeight:700,flexShrink:0 }}>
            {(contacts[0]?.contact ?? "?")[0].toUpperCase()}
          </div>
          <div style={{ flex:1,minWidth:0 }}>
            <div style={{ fontSize:".74rem",color:"var(--muted)",marginBottom:".15rem" }}>AgentPubKey Ed25519</div>
            <div style={{ fontSize:".72rem",fontFamily:"monospace",wordBreak:"break-all",color:"var(--text)" }}>
              {pubkey || "Non connecté au conductor"}
            </div>
          </div>
          <button className="btn-ghost btn-sm"
            onClick={() => { navigator.clipboard.writeText(pubkey).catch(()=>{}); setPkCopied(true); setTimeout(()=>setPkCopied(false),2000); }}>
            {pkCopied ? "✓ Copié" : "Copier"}
          </button>
        </div>
      </div>

      {/* M3 — Clé X25519 pour le chiffrement ECIES */}
      <div className="card">
        <div className="card-label">Clé de chiffrement (X25519 — M3)</div>
        {x25519Pub ? (
          <div>
            <div className="info-box" style={{ background:"rgba(52,211,153,.1)",border:"1px solid rgba(52,211,153,.35)" }}>
              🔒 Clé X25519 active — les expéditeurs peuvent vous envoyer des fichiers sans exposer la clé AES dans l'URL.
            </div>
            <div style={{ fontSize:".72rem",fontFamily:"monospace",wordBreak:"break-all",color:"var(--muted)",marginTop:".5rem" }}>
              <span style={{ color:"var(--text)" }}>X25519 pub : </span>{x25519Pub.slice(0, 40)}…
            </div>
          </div>
        ) : (
          <div className="info-box">
            ⚠️ Aucune clé X25519 — générez votre clé ci-dessous, ou liez un contact (la clé sera créée automatiquement).
          </div>
        )}

        <div style={{ display:"flex", gap:".6rem", marginTop:".8rem", flexWrap:"wrap" }}>
          <button className="btn-ghost" disabled={keyBusy || !!x25519Pub} onClick={generateKey}>
            {keyBusy && !x25519Pub ? <span className="spin" /> : "Générer ma clé X25519"}
          </button>
          <button className="btn-primary" disabled={keyBusy || !x25519Pub || published} onClick={publishKey}>
            {published ? "✓ Publiée sur le DHT" : keyBusy && x25519Pub ? <span className="spin" /> : "Publier sur le DHT"}
          </button>
        </div>
        <p style={{ fontSize:".74rem", color:"var(--muted)", marginTop:".5rem" }}>
          Votre clé privée ne quitte jamais ce navigateur (IndexedDB). Seule la clé publique est publiée sur Holochain.
        </p>
      </div>

      {/* Mes clés — sauvegarde / restauration */}
      <div className="card">
        <div className="card-label">Mes clés (sauvegarde)</div>
        <div style={{ display:"flex", gap:".6rem", flexWrap:"wrap" }}>
          <button className="btn-ghost" onClick={exportKeys}>Exporter mes clés</button>
          <label className="btn-ghost" style={{ display:"inline-flex", alignItems:"center", cursor:"pointer", margin:0 }}>
            Importer mes clés
            <input
              type="file"
              accept=".json"
              style={{ display:"none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) importKeys(f); e.target.value = ""; }}
            />
          </label>
        </div>
        <p style={{ fontSize:".74rem", color:"var(--muted)", marginTop:".5rem" }}>
          Le fichier exporté contient votre <strong>clé privée</strong>. Conservez-le en lieu sûr et ne le partagez jamais.
        </p>
      </div>

      {/* Contacts liés */}
      <div className="card">
        <div className="card-label">Contacts liés</div>
        <div className="info-box">📡 Votre email ou téléphone n'est <strong>jamais publié en clair</strong> — seul son hash SHA-256 est sur le DHT.</div>

        {contacts.map((c) => (
          <div key={c.hash} style={{ display:"flex",alignItems:"center",gap:".85rem",padding:".85rem 1rem",background:"rgba(255,255,255,.05)",border:"1px solid var(--border)",borderRadius:"14px",marginBottom:".55rem",boxShadow:"var(--shadow)" }}>
            <div style={{ width:"38px",height:"38px",borderRadius:"50%",background:"var(--grad)",display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:700,flexShrink:0 }}>
              {c.contact[0].toUpperCase()}
            </div>
            <div style={{ flex:1,minWidth:0 }}>
              <div style={{ fontSize:".88rem",fontWeight:500 }}>{c.contact}</div>
              <div style={{ fontSize:".7rem",color:"var(--muted)",fontFamily:"monospace",marginTop:".1rem",wordBreak:"break-all" }}>SHA-256 : {c.hash}</div>
              <div style={{ fontSize:".72rem",color:"var(--ok)",marginTop:".1rem" }}>✓ Vérifié OTP · Publié sur le DHT</div>
            </div>
            <button className="btn-danger btn-sm" onClick={() => revokeContact(c.hash, c.contact)}>Révoquer</button>
          </div>
        ))}

        {contacts.length === 0 && (
          <div className="empty" style={{ padding:"1.2rem" }}>Aucun contact lié</div>
        )}

        <hr style={{ border:"none",borderTop:"1px solid var(--border)",margin:"1rem 0" }} />
        <div className="card-label" style={{ marginBottom:".7rem" }}>Lier un nouveau contact</div>

        {!otpStep ? (
          <div style={{ display:"flex",gap:".6rem" }}>
            <input type="text" value={newContact} onChange={(e)=>setNewContact(e.target.value)} placeholder="email ou +33…" />
            <button className="btn-primary" disabled={!validContact(newContact) || loading} onClick={sendOtp}>
              {loading ? <span className="spin" /> : "Vérifier"}
            </button>
          </div>
        ) : (
          <div>
            <div style={{ fontSize:".82rem",color:"var(--muted)",marginBottom:".6rem" }}>Code envoyé à <strong>{newContact}</strong>. Valable 10 min.</div>
            <div style={{ display:"flex",gap:".6rem" }}>
              <input type="text" value={otpCode} onChange={(e)=>setOtpCode(e.target.value)}
                maxLength={6} placeholder="Code à 6 chiffres"
                style={{ letterSpacing:".25em",textAlign:"center",fontWeight:700 }} />
              <button className="btn-success" disabled={otpCode.length<6||loading} onClick={verifyOtp}>
                {loading ? <span className="spin" /> : "Confirmer"}
              </button>
              <button className="btn-ghost" onClick={()=>{setOtpStep(false);setOtpCode("");}}>Annuler</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
