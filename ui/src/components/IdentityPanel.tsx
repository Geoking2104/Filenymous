import { useState, useEffect } from "react";
import { hashContact }          from "../crypto/contact";
import { identityZome }         from "../holochain/identity";
import { useStore }             from "../store/useStore";
import { loadOrCreateKeyPair, loadPublicKeyBytes } from "../crypto/keystore";

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

  // M3: Load or display existing X25519 public key on mount
  useEffect(() => {
    loadPublicKeyBytes().then((bytes) => {
      if (bytes) setX25519Pub(toBase64(bytes));
    }).catch(() => {/* no key yet */});
  }, []);

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
            <div className="info-box" style={{ background:"#f0fdf4",border:"1px solid #86efac" }}>
              🔒 Clé X25519 active — les expéditeurs peuvent vous envoyer des fichiers sans exposer la clé AES dans l'URL.
            </div>
            <div style={{ fontSize:".72rem",fontFamily:"monospace",wordBreak:"break-all",color:"var(--muted)",marginTop:".5rem" }}>
              <span style={{ color:"var(--text)" }}>X25519 pub : </span>{x25519Pub.slice(0, 40)}…
            </div>
          </div>
        ) : (
          <div className="info-box">
            ⚠️ Aucune clé X25519 — liez d'abord un contact pour générer votre clé de chiffrement.
          </div>
        )}
      </div>

      {/* Contacts liés */}
      <div className="card">
        <div className="card-label">Contacts liés</div>
        <div className="info-box">📡 Votre email ou téléphone n'est <strong>jamais publié en clair</strong> — seul son hash SHA-256 est sur le DHT.</div>

        {contacts.map((c) => (
          <div key={c.hash} style={{ display:"flex",alignItems:"center",gap:".85rem",padding:".85rem 1rem",background:"#fff",border:"1px solid var(--border)",borderRadius:"12px",marginBottom:".55rem",boxShadow:"var(--shadow)" }}>
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
