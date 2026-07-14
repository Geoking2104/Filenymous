/**
 * SendPanel v2 — sans bridge, deux modes de livraison :
 *
 * Mode A — Agent DHT (destinataire enregistré) :
 *   1. Résolution contact_hash → AgentPubKey
 *   2. Récupération clé X25519 du destinataire
 *   3. Chiffrement AES-256-GCM des chunks
 *   4. Upload chunks via file_storage_zome
 *   5. ECIES wrapping de la clé AES
 *   6. create_parcel → remote_signal au destinataire
 *   7. Affichage lien de secours (copier-coller)
 *
 * Mode B — Lien one-time (destinataire non enregistré) :
 *   1. Chiffrement AES-256-GCM des chunks
 *   2. Upload chunks via file_storage_zome → file_hash
 *   3. create_parcel (encrypted_key_blob vide)
 *   4. Génération URL : https://app/#<parcel_eh_b64>:<aes_key_b64>
 *      (le fragment # ne transite pas sur le réseau)
 *   5. L'utilisateur partage ce lien par son propre canal (email, SMS…)
 */

import { useState, useRef, useEffect } from "react";
import { hashContact }                          from "../crypto/contact";
import { generateAesKey, exportAesKey }         from "../crypto/aes";
import { encryptFile }                          from "../crypto/chunker";
import { encryptAesKeyForRecipient, importX25519PublicKey } from "../crypto/ecies";
import { identityZome }                         from "../holochain/identity";
import { fileStorageZome }                      from "../holochain/fileStorage";
import { parcelZome }                           from "../holochain/delivery";
import { canWrite }                            from "../holochain/client";
import { useStore }                             from "../store/useStore";

const CHUNK_SIZE = 256 * 1024; // 256 KB

type SendState = "idle" | "uploading" | "done";

function isValidContact(v: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || /^\+[1-9]\d{7,14}$/.test(v);
}
function fmtSize(b: number) {
  if (!b) return "0 o";
  const k=1024,s=["o","Ko","Mo","Go","To"],i=Math.floor(Math.log(b)/Math.log(k));
  return parseFloat((b/Math.pow(k,i)).toFixed(1))+" "+s[i];
}
function fileIcon(name: string) {
  const e=(name.split(".").pop()||"").toLowerCase();
  return ({pdf:"📕",zip:"🗜",tar:"🗜",gz:"🗜",jpg:"🖼",jpeg:"🖼",png:"🖼",gif:"🖼",
           mp4:"🎬",mov:"🎬",mp3:"🎵",doc:"📝",docx:"📝",xls:"📊",xlsx:"📊",
           rs:"💻",ts:"💻",js:"💻",py:"💻"} as Record<string,string>)[e]??"📄";
}
function encodeB64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
}

export default function SendPanel() {
  const addParcel           = useStore((s) => s.addParcel);
  const selectedRecipient   = useStore((s) => s.selectedRecipient);
  const setSelectedRecipient = useStore((s) => s.setSelectedRecipient);

  const [files,       setFiles]       = useState<File[]>([]);
  const [recipient,   setRecipient]   = useState("");
  const [expiry,      setExpiry]      = useState("7d");
  const [maxDl,       setMaxDl]       = useState("1");
  const [state,       setState]       = useState<SendState>("idle");
  const [pct,         setPct]         = useState(0);
  const [step,        setStep]        = useState("");
  const [link,        setLink]        = useState("");
  const [mode,        setMode]        = useState<"agent"|"link"|null>(null);
  const [copied,      setCopied]      = useState(false);
  const [dragging,    setDragging]    = useState(false);
  const [resolvedKey, setResolvedKey] = useState<boolean | null>(null);
  const resolveTimer = useRef<ReturnType<typeof setTimeout>>();

  const progress = (p: number, s: string) => { setPct(p); setStep(s); };

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
      } catch { setResolvedKey(false); }
    }, 800);
  };

  // Pre-remplit le destinataire quand on arrive depuis l'onglet Contacts
  useEffect(() => {
    if (selectedRecipient) {
      handleRecipientChange(selectedRecipient);
      setSelectedRecipient("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRecipient]);

  const addFiles = (fs: File[]) => {
    const total = [...files, ...fs].reduce((s, f) => s + f.size, 0);
    if (total > 5 * 1024 ** 3) { alert("Limite 5 Go dépassée"); return; }
    setFiles((p) => [...p, ...fs]);
  };

  const send = async () => {
    if (!files.length || !isValidContact(recipient)) return;
    if (!canWrite()) {
      alert("Envoi impossible sans Holo Web Conductor ou conducteur Holochain local.");
      return;
    }

    setState("uploading"); setPct(0);

    try {
      // ── 1. Résolution du contact ───────────────────────────────────────────
      progress(5, "Résolution du destinataire sur le DHT…");
      const contactHash     = await hashContact(recipient);
      const recipientAgent  = await identityZome.getAgentForContact(contactHash);

      // ── 2. Génération + chiffrement AES ───────────────────────────────────
      progress(12, "Génération de la clé AES-256…");
      const aesKey    = await generateAesKey();
      const aesRaw    = await exportAesKey(aesKey);

      // ── 3. Chiffrement des chunks ──────────────────────────────────────────
      const totalSize   = files.reduce((s, f) => s + f.size, 0);
      const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);
      const fileName    = files.length === 1 ? files[0].name : `${files.length} fichiers`;

      progress(18, "Chiffrement local des chunks…");
      const encryptedChunks: Uint8Array[] = [];
      let chunksProcessed = 0;
      for (const file of files) {
        for await (const chunk of encryptFile(file, aesKey)) {
          encryptedChunks.push(chunk.data);
          chunksProcessed++;
          progress(18 + Math.round((chunksProcessed / totalChunks) * 35),
            `Chunk ${chunksProcessed}/${totalChunks} chiffré…`);
        }
      }

      // ── 4. Upload sur la DHT (file_storage_zome) ──────────────────────────
      progress(55, "Publication des chunks sur le DHT…");
      const fileHash = await fileStorageZome.createFile(fileName, encryptedChunks);

      // ── 5. ECIES wrapping ou mode lien ────────────────────────────────────
      let encryptedKeyBlob = "";
      let deliveryMode: "agent" | "link" = "link";

      if (recipientAgent) {
        progress(72, "Wrapping ECIES de la clé AES (X25519)…");
        const x25519B64 = await identityZome.getX25519Key(recipientAgent);
        if (x25519B64) {
          const x25519Raw  = Uint8Array.from(atob(x25519B64), (c) => c.charCodeAt(0));
          const recipKey   = await importX25519PublicKey(x25519Raw);
          const blob       = await encryptAesKeyForRecipient(aesRaw, recipKey);
          encryptedKeyBlob = btoa(String.fromCharCode(...blob));
          deliveryMode     = "agent";
        }
      }

      // ── 6. Expiry ─────────────────────────────────────────────────────────
      const expiryMap: Record<string, number> = {
        "24h":  24  * 3600 * 1e6,
        "7d":   7   * 24 * 3600 * 1e6,
        "30d":  30  * 24 * 3600 * 1e6,
        never:  0,
      };
      const expiry_us = expiryMap[expiry] ? Date.now() * 1000 + expiryMap[expiry] : 0;

      // ── 7. Création du ParcelManifest sur le DHT ───────────────────────────
      progress(80, "Création du manifest sur le DHT…");
      const parcelOut = await parcelZome.createParcel({
        file_hash:              fileHash,
        file_name:              fileName,
        file_size:              totalSize,
        chunk_count:            totalChunks,
        recipient_contact_hash: contactHash,
        encrypted_key_blob:     encryptedKeyBlob,
        expiry_us,
        max_downloads:          parseInt(maxDl),
      });

      // ── 8. Construction du lien de téléchargement ─────────────────────────
      progress(92, "Génération du lien…");
      // EntryHash → base64url pour l'URL
      const parcelEhB64 = encodeB64Url(new Uint8Array(parcelOut.parcel_eh as unknown as number[]));

      let transferLink: string;
      if (deliveryMode === "agent") {
        // Lien de secours sans clé (le destinataire agent utilise sa clé X25519)
        transferLink = `${window.location.origin}/#${parcelEhB64}`;
      } else {
        // Clé AES dans le fragment # (ne transite pas sur le réseau)
        const aesB64 = encodeB64Url(aesRaw);
        transferLink = `${window.location.origin}/#${parcelEhB64}:${aesB64}`;
      }

      progress(100, "Transfert publié !");
      setLink(transferLink);
      setMode(deliveryMode);

      addParcel({
        parcel_eh: parcelEhB64,
        file_name: fileName,
        to:        recipient,
        size:      totalSize,
        date:      new Date().toLocaleDateString("fr-FR"),
        status:    "pending",
        downloads: 0,
        max_dl:    parseInt(maxDl),
        link:      transferLink,
        mode:      deliveryMode,
      });

      setState("done");
    } catch (e) {
      console.error(e);
      alert("Erreur lors du transfert : " + String(e));
      setState("idle");
    }
  };

  if (state === "done") return (
    <div className="card" style={{ textAlign:"center", padding:"2.5rem" }}>
      <div style={{ fontSize:"3rem", marginBottom:".8rem" }}>✅</div>
      <div style={{ fontSize:"1.1rem", fontWeight:700, marginBottom:".4rem" }}>
        Transfert publié sur le réseau Holo
      </div>
      {mode === "agent" ? (
        <div style={{ fontSize:".87rem", color:"var(--muted)", marginBottom:"1.5rem" }}>
          Le destinataire a été notifié en temps réel via le DHT. Voici également le lien de secours.
        </div>
      ) : (
        <div className="warn-box" style={{ textAlign:"left", marginBottom:"1.2rem" }}>
          ⚠ Destinataire non enregistré sur le DHT. Partagez ce lien vous-même (email, SMS, messagerie).
          La clé de déchiffrement est dans le fragment <code>#</code> — elle ne transite pas sur le réseau.
        </div>
      )}
      <div className="form-row" style={{ textAlign:"left" }}>
        <div className="form-label">Lien de téléchargement</div>
        <div style={{ display:"flex",gap:".5rem",background:"var(--bg)",border:"1.5px solid var(--border)",borderRadius:"10px",padding:".45rem .45rem .45rem .85rem",alignItems:"center" }}>
          <span style={{ flex:1,fontSize:".82rem",fontFamily:"monospace",color:"var(--muted)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>{link}</span>
          <button className="btn-ghost btn-sm" onClick={() => { navigator.clipboard.writeText(link); setCopied(true); setTimeout(()=>setCopied(false),2000); }}>
            {copied ? "✓ Copié" : "Copier"}
          </button>
        </div>
      </div>
      <button className="btn-ghost btn-full" style={{ marginTop:"1.2rem" }}
        onClick={() => { setFiles([]); setRecipient(""); setState("idle"); setPct(0); setCopied(false); setMode(null); }}>
        Nouvel envoi
      </button>
    </div>
  );

  if (state === "uploading") return (
    <div className="card" style={{ textAlign:"center", padding:"2.5rem" }}>
      <div style={{ fontSize:"2.5rem", marginBottom:".8rem" }}>🔒</div>
      <div style={{ fontSize:"1rem", fontWeight:600, marginBottom:".4rem" }}>{step}</div>
      <div style={{ fontSize:".82rem", color:"var(--muted)", marginBottom:"1.2rem" }}>
        Chiffrement local — vos fichiers ne transitent jamais en clair. Aucun serveur tiers.
      </div>
      <div className="progress-bar"><div className="progress-fill" style={{ width:pct+"%" }} /></div>
      <div style={{ fontSize:".77rem", color:"var(--muted)", marginTop:".4rem" }}>{pct}%</div>
    </div>
  );

  return (
    <div>
      {/* Zone de dépôt */}
      <div className="card" style={{ padding:"1rem" }}>
        <div style={{ border:`2px dashed ${dragging?"#6366f1":"#d1d5db"}`,borderRadius:"12px",padding:"2.8rem 1.5rem",textAlign:"center",cursor:"pointer",position:"relative",background:dragging?"#ede9fe22":"var(--bg)",transition:"all .2s" }}
          onDragOver={(e)=>{e.preventDefault();setDragging(true);}}
          onDragLeave={()=>setDragging(false)}
          onDrop={(e)=>{e.preventDefault();setDragging(false);addFiles(Array.from(e.dataTransfer.files));}}>
          <input type="file" multiple style={{ position:"absolute",inset:0,opacity:0,cursor:"pointer",width:"100%",height:"100%" }}
            onChange={(e)=>{addFiles(Array.from(e.target.files??[]));e.target.value="";}} />
          <div style={{ fontSize:"2.4rem", marginBottom:".6rem" }}>📂</div>
          <div style={{ fontSize:".9rem", color:"var(--muted)" }}><strong style={{ color:"var(--g1)" }}>Cliquez</strong> ou déposez vos fichiers ici</div>
          <div style={{ fontSize:".76rem", color:"#9ca3af", marginTop:".3rem" }}>Tous formats · jusqu'à 5 Go</div>
        </div>
        {files.map((f,i) => (
          <div key={i} style={{ display:"flex",alignItems:"center",gap:".7rem",padding:".6rem .8rem",background:"var(--bg)",border:"1px solid var(--border)",borderRadius:"10px",marginTop:".5rem" }}>
            <span style={{ fontSize:"1.4rem" }}>{fileIcon(f.name)}</span>
            <div style={{ flex:1,minWidth:0 }}>
              <div style={{ fontSize:".88rem",fontWeight:500,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>{f.name}</div>
              <div style={{ fontSize:".75rem",color:"var(--muted)" }}>{fmtSize(f.size)}</div>
            </div>
            <button style={{ background:"transparent",color:"#9ca3af",fontSize:".9rem",padding:".2rem .5rem",borderRadius:"6px" }}
              onClick={()=>setFiles((p)=>p.filter((_,j)=>j!==i))}>✕</button>
          </div>
        ))}
      </div>

      {/* Destinataire + options */}
      <div className="card">
        <div className="card-label">Destinataire & options</div>
        <div className="form-row">
          <label className="form-label">Email ou téléphone *</label>
          <input type="text" value={recipient} onChange={(e)=>handleRecipientChange(e.target.value)}
            placeholder="alice@example.com ou +33612345678"
            style={recipient&&!isValidContact(recipient)?{borderColor:"var(--err)"}:{}} />
          {recipient && isValidContact(recipient) && resolvedKey !== null && (
            <div style={{ fontSize:".74rem",marginTop:".25rem",color:resolvedKey?"var(--ok)":"var(--warn)" }}>
              {resolvedKey
                ? "✓ Agent enregistré sur le DHT — livraison directe + lien de secours"
                : "⚠ Contact non enregistré — un lien one-time sera généré (partagez-le vous-même)"}
            </div>
          )}
        </div>

        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:".75rem",marginBottom:".9rem" }}>
          <div>
            <label className="form-label">Expiration</label>
            <select value={expiry} onChange={(e)=>setExpiry(e.target.value)}>
              <option value="24h">24 heures</option>
              <option value="7d">7 jours</option>
              <option value="30d">30 jours</option>
              <option value="never">Jamais</option>
            </select>
          </div>
          <div>
            <label className="form-label">Téléchargements max</label>
            <select value={maxDl} onChange={(e)=>setMaxDl(e.target.value)}>
              <option value="1">1 fois</option>
              <option value="3">3 fois</option>
              <option value="10">10 fois</option>
              <option value="0">Illimité</option>
            </select>
          </div>
        </div>

        <div className="info-box">
          🔒 Chiffrement <strong>AES-256-GCM + ECIES/X25519</strong> dans le navigateur.
          Aucun serveur Filenymous ne voit la clé ni les données. Stockage sur <strong>Holo DHT</strong>.
        </div>

        <button className="btn-primary btn-full" style={{ padding:".75rem" }}
          disabled={!files.length || !isValidContact(recipient)} onClick={send}>
          Chiffrer &amp; Envoyer
        </button>
      </div>
    </div>
  );
}
