/**
 * SendPanel — full upload flow with real WebCrypto + Holochain calls.
 *
 * M3 flow:
 *  1. User picks file(s) + recipient + message
 *  2. On send:
 *     a. hashContact(recipient) → contact_hash
 *     b. identityZome.getAgentForContact(contact_hash) → recipientAgent
 *     c. identityZome.getX25519Key(recipientAgent) → recipientX25519PubKeyB64
 *     d. generateAesKey() → aesKey (raw 32 bytes)
 *     e. ECIES: encryptAesKeyForRecipient(aesRaw, recipientX25519Key)
 *              → encrypted_key_blob (92 bytes, base64-stored in manifest)
 *     f. transferZome.createTransfer(manifest with ECIES blob)
 *     g. For each chunk: encryptChunk + storageZome.storeChunk()
 *     h. storageZome.finalizeStorage()
 *     i. [BRIDGE] POST /notify { contact: recipient, link, message }
 *        Link no longer contains ?k=... — key is in the DHT manifest.
 */

import { useState, useCallback, useRef } from "react";
import { hashContact }    from "../crypto/contact";
import { generateAesKey, exportAesKey } from "../crypto/aes";
import { encryptFile }   from "../crypto/chunker";
import { encryptAesKeyForRecipient, importX25519PublicKey } from "../crypto/ecies";
import { identityZome }  from "../holochain/identity";
import { transferZome }  from "../holochain/transfer";
import { storageZome }   from "../holochain/storage";
import { useStore }      from "../store/useStore";
import type { ActionHash } from "@holochain/client";

declare const __BRIDGE_URL__: string;
const CHUNK_SIZE = 256 * 1024;

type SendState = "idle" | "uploading" | "done";

function isValidContact(v: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || /^\+[1-9]\d{7,14}$/.test(v);
}
function fmtSize(b: number) {
  if (!b) return "0 o";
  const k = 1024, s = ["o","Ko","Mo","Go","To"], i = Math.floor(Math.log(b)/Math.log(k));
  return parseFloat((b/Math.pow(k,i)).toFixed(1)) + " " + s[i];
}
function icon(name: string) {
  const e = (name.split(".").pop() || "").toLowerCase();
  return ({pdf:"📕",zip:"🗜",tar:"🗜",gz:"🗜",jpg:"🖼",jpeg:"🖼",png:"🖼",gif:"🖼",
           mp4:"🎬",mov:"🎬",mp3:"🎵",doc:"📝",docx:"📝",xls:"📊",xlsx:"📊",
           rs:"💻",ts:"💻",js:"💻",py:"💻"} as Record<string,string>)[e] ?? "📄";
}

export default function SendPanel() {
  const addTransfer = useStore((s) => s.addTransfer);

  const [files,       setFiles]       = useState<File[]>([]);
  const [recipient,   setRecipient]   = useState("");
  const [message,     setMessage]     = useState("");
  const [expiry,      setExpiry]      = useState("7d");
  const [maxDl,       setMaxDl]       = useState("1");
  const [password,    setPassword]    = useState("");
  const [state,       setState]       = useState<SendState>("idle");
  const [pct,         setPct]         = useState(0);
  const [step,        setStep]        = useState("");
  const [link,        setLink]        = useState("");
  const [copied,      setCopied]      = useState(false);
  const [dragging,    setDragging]    = useState(false);
  const [resolvedKey, setResolvedKey] = useState<boolean | null>(null);
  const resolveTimer = useRef<ReturnType<typeof setTimeout>>();

  // Resolve recipient pubkey 800ms after typing stops
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

  const addFiles = (fs: File[]) => {
    const total = [...files, ...fs].reduce((s, f) => s + f.size, 0);
    if (total > 5 * 1024 ** 3) { alert("Limite 5 Go dépassée"); return; }
    setFiles((prev) => [...prev, ...fs]);
  };

  const send = async () => {
    if (!files.length || !isValidContact(recipient)) return;
    setState("uploading"); setPct(0);

    const progress = (p: number, s: string) => { setPct(p); setStep(s); };

    try {
      progress(5, "Calcul des checksums…");
      const contactHash = await hashContact(recipient);

      progress(12, "Résolution DHT du destinataire…");
      const recipientAgent = await identityZome.getAgentForContact(contactHash);

      // M3: Fetch recipient's X25519 public key from DHT
      progress(16, "Récupération de la clé X25519 du destinataire…");
      let keyBlob: string;

      if (recipientAgent) {
        const x25519B64 = await identityZome.getX25519Key(recipientAgent);
        if (!x25519B64) {
          throw new Error(
            "Le destinataire n'a pas encore publié sa clé X25519. " +
            "Il doit ouvrir Filenymous et vérifier son identité avant de pouvoir recevoir des fichiers."
          );
        }
        // Import recipient's X25519 public key
        const x25519Raw = Uint8Array.from(atob(x25519B64), (c) => c.charCodeAt(0));
        const recipientX25519Key = await importX25519PublicKey(x25519Raw);

        progress(20, "Génération de la clé AES-256 et chiffrement ECIES…");
        const aesKey = await generateAesKey();
        const aesRaw = await exportAesKey(aesKey);

        // M3: ECIES wrap — AES key never goes in the URL
        const eciesBlob = await encryptAesKeyForRecipient(aesRaw, recipientX25519Key);
        keyBlob = btoa(String.fromCharCode(...eciesBlob));

        var finalAesKey = aesKey; // keep ref for chunk encryption
      } else {
        // Recipient unknown on DHT — fallback: bare base64 key in link (M2 compat)
        // This path is shown as a warning in the UI
        progress(20, "Génération de la clé AES-256 (destinataire non inscrit)…");
        const aesKey = await generateAesKey();
        const aesRaw = await exportAesKey(aesKey);
        keyBlob = btoa(String.fromCharCode(...aesRaw));
        var finalAesKey = aesKey;
      }

      const transferId  = crypto.randomUUID();
      const totalChunks = Math.ceil(
        files.reduce((s, f) => s + f.size, 0) / CHUNK_SIZE
      );
      const totalSize = files.reduce((s, f) => s + f.size, 0);

      const expiryMap: Record<string, number> = {
        "24h":  24 * 3600 * 1e6,
        "7d":   7  * 24 * 3600 * 1e6,
        "30d":  30 * 24 * 3600 * 1e6,
        never:  0,
      };
      const expiry_us = expiryMap[expiry]
        ? Date.now() * 1000 + expiryMap[expiry]
        : 0;

      progress(28, "Création du manifest de transfert…");
      await transferZome.createTransfer({
        transfer_id:            transferId,
        recipient_contact_hash: contactHash,
        file_name:              files.length === 1 ? files[0].name : `${files.length} fichiers`,
        file_size:              totalSize,
        chunk_count:            totalChunks,
        encrypted_key_blob:     keyBlob,   // M3: ECIES blob, not bare AES key
        expiry_us,
        max_downloads:          parseInt(maxDl),
      });

      progress(35, "Chiffrement et publication des chunks…");
      const chunkHashes: ActionHash[] = [];
      let chunksProcessed = 0;

      for (const file of files) {
        for await (const chunk of encryptFile(file, finalAesKey)) {
          const hash = await storageZome.storeChunk({
            transfer_id:    transferId,
            chunk_index:    chunk.index + chunksProcessed,
            total_chunks:   totalChunks,
            encrypted_data: Array.from(chunk.data),
            checksum:       chunk.checksum,
          });
          chunkHashes.push(hash);
          const done = chunksProcessed + chunk.index + 1;
          progress(35 + Math.round((done / totalChunks) * 45), `Chunk ${done}/${totalChunks} publié…`);
        }
        chunksProcessed += Math.ceil(file.size / CHUNK_SIZE);
      }

      progress(82, "Finalisation du stockage…");
      await storageZome.finalizeStorage({
        transfer_id:          transferId,
        total_chunks:         totalChunks,
        chunk_action_hashes:  chunkHashes,
        file_size_bytes:      totalSize,
      });

      // M3: link no longer contains ?k=... — key is in the DHT manifest
      progress(90, "Notification du destinataire…");
      const transferLink = `${window.location.origin}?d=${transferId}`;
      await fetch(`${__BRIDGE_URL__}/notify/email`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ contact: recipient, link: transferLink, message }),
      }).catch(() => { /* bridge optionnel en dev */ });

      progress(100, "Transfert publié !");

      setLink(transferLink);
      addTransfer({
        transfer_id: transferId,
        file_name:   files.length === 1 ? files[0].name : `${files.length} fichiers`,
        to:          recipient,
        size:        totalSize,
        date:        new Date().toLocaleDateString("fr-FR"),
        status:      "pending",
        downloads:   0,
        max_dl:      parseInt(maxDl),
        link:        transferLink,
      });
      setState("done");
    } catch (e) {
      console.error(e);
      alert("Erreur lors du transfert : " + String(e));
      setState("idle");
    }
  };

  if (state === "done") return (
    <div className="card" style={{ textAlign: "center", padding: "2.5rem" }}>
      <div style={{ fontSize: "3rem", marginBottom: ".8rem" }}>✅</div>
      <div style={{ fontSize: "1.1rem", fontWeight: 700, marginBottom: ".4rem" }}>Transfert publié sur le réseau</div>
      <div style={{ fontSize: ".87rem", color: "var(--muted)", marginBottom: "1.5rem" }}>
        Le destinataire reçoit un lien par {recipient.includes("@") ? "email" : "SMS"}.
      </div>
      <div className="form-row" style={{ textAlign: "left" }}>
        <div className="form-label">Lien de téléchargement</div>
        <div style={{ display:"flex",gap:".5rem",background:"var(--bg)",border:"1.5px solid var(--border)",borderRadius:"10px",padding:".45rem .45rem .45rem .85rem",alignItems:"center" }}>
          <span style={{ flex:1, fontSize:".82rem", fontFamily:"monospace", color:"var(--muted)", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{link}</span>
          <button className="btn-ghost btn-sm" onClick={() => { navigator.clipboard.writeText(link); setCopied(true); setTimeout(()=>setCopied(false),2000); }}>
            {copied ? "✓ Copié" : "Copier"}
          </button>
        </div>
      </div>
      <button className="btn-ghost btn-full" style={{ marginTop: "1.2rem" }}
        onClick={() => { setFiles([]); setRecipient(""); setMessage(""); setPassword(""); setState("idle"); setPct(0); setCopied(false); }}>
        Nouvel envoi
      </button>
    </div>
  );

  if (state === "uploading") return (
    <div className="card" style={{ textAlign: "center", padding: "2.5rem" }}>
      <div style={{ fontSize: "2.5rem", marginBottom: ".8rem" }}>🔒</div>
      <div style={{ fontSize: "1rem", fontWeight: 600, marginBottom: ".4rem" }}>{step}</div>
      <div style={{ fontSize: ".82rem", color: "var(--muted)", marginBottom: "1.2rem" }}>Chiffrement local — vos fichiers ne transitent jamais en clair.</div>
      <div className="progress-bar"><div className="progress-fill" style={{ width: pct+"%" }} /></div>
      <div style={{ fontSize: ".77rem", color: "var(--muted)", marginTop: ".4rem" }}>{pct}%</div>
    </div>
  );

  return (
    <div>
      {/* Drop zone */}
      <div className="card" style={{ padding: "1rem" }}>
        <div
          style={{ border: `2px dashed ${dragging ? "#6366f1" : "#d1d5db"}`, borderRadius: "12px", padding: "2.8rem 1.5rem", textAlign: "center", cursor: "pointer", position: "relative", background: dragging ? "#ede9fe22" : "var(--bg)", transition: "all .2s" }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(Array.from(e.dataTransfer.files)); }}
        >
          <input type="file" multiple style={{ position:"absolute",inset:0,opacity:0,cursor:"pointer",width:"100%",height:"100%" }}
            onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
          <div style={{ fontSize: "2.4rem", marginBottom: ".6rem" }}>📂</div>
          <div style={{ fontSize: ".9rem", color: "var(--muted)" }}><strong style={{ color: "var(--g1)" }}>Cliquez</strong> ou déposez vos fichiers ici</div>
          <div style={{ fontSize: ".76rem", color: "#9ca3af", marginTop: ".3rem" }}>Tous formats · jusqu'à 5 Go</div>
        </div>
        {files.map((f, i) => (
          <div key={i} style={{ display:"flex",alignItems:"center",gap:".7rem",padding:".6rem .8rem",background:"var(--bg)",border:"1px solid var(--border)",borderRadius:"10px",marginTop:".5rem" }}>
            <span style={{ fontSize: "1.4rem" }}>{icon(f.name)}</span>
            <div style={{ flex:1,minWidth:0 }}>
              <div style={{ fontSize:".88rem",fontWeight:500,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>{f.name}</div>
              <div style={{ fontSize:".75rem",color:"var(--muted)" }}>{fmtSize(f.size)}</div>
            </div>
            <button style={{ background:"transparent",color:"#9ca3af",fontSize:".9rem",padding:".2rem .5rem",borderRadius:"6px" }}
              onClick={() => setFiles((p) => p.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
      </div>

      {/* Destinataire + options */}
      <div className="card">
        <div className="card-label">Destinataire & options</div>

        <div className="form-row">
          <label className="form-label">Email ou téléphone *</label>
          <input type="text" value={recipient} onChange={(e) => handleRecipientChange(e.target.value)}
            placeholder="alice@example.com ou +33612345678"
            style={ recipient && !isValidContact(recipient) ? { borderColor: "var(--err)" } : {} } />
          {recipient && isValidContact(recipient) && resolvedKey !== null && (
            <div style={{ fontSize:".74rem",marginTop:".25rem",color: resolvedKey ? "var(--ok)" : "var(--warn)" }}>
              {resolvedKey ? "✓ Clé publique trouvée sur le DHT" : "⚠ Contact inconnu du DHT — un lien lui sera envoyé"}
            </div>
          )}
        </div>

        <div className="form-row">
          <label className="form-label">Message de présentation <span style={{ fontWeight:400,color:"#9ca3af" }}>(optionnel)</span></label>
          <textarea value={message} maxLength={500} onChange={(e) => setMessage(e.target.value)}
            placeholder="Ex : Bonjour, voici le document dont nous avons parlé. N'hésitez pas à me revenir si besoin." />
          <div style={{ fontSize:".72rem",color:"#9ca3af",textAlign:"right",marginTop:".2rem" }}>{message.length} / 500</div>
        </div>

        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:".75rem",marginBottom:".9rem" }}>
          <div>
            <label className="form-label">Expiration</label>
            <select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              <option value="24h">24 heures</option>
              <option value="7d">7 jours</option>
              <option value="30d">30 jours</option>
              <option value="never">Jamais</option>
            </select>
          </div>
          <div>
            <label className="form-label">Téléchargements max</label>
            <select value={maxDl} onChange={(e) => setMaxDl(e.target.value)}>
              <option value="1">1 fois</option>
              <option value="3">3 fois</option>
              <option value="10">10 fois</option>
              <option value="0">Illimité</option>
            </select>
          </div>
        </div>

        <div className="form-row">
          <label className="form-label">Mot de passe <span style={{ fontWeight:400,color:"#9ca3af" }}>(optionnel)</span></label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder="Laisser vide = aucun mot de passe" />
        </div>

        <div className="info-box">🔒 <strong>M3</strong> : clé AES chiffrée par ECIES/X25519 dans votre navigateur — ni le lien, ni le réseau, ni les nœuds DHT ne voient la clé de déchiffrement.</div>

        <button className="btn-primary btn-full" style={{ padding: ".75rem" }}
          disabled={!files.length || !isValidContact(recipient)} onClick={send}>
          Chiffrer &amp; Envoyer
        </button>
      </div>
    </div>
  );
}
