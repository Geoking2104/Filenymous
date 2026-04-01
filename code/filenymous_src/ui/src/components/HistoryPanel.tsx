import { useState } from "react";
import { transferZome } from "../holochain/transfer";
import { storageZome }  from "../holochain/storage";
import { useStore }     from "../store/useStore";

type Filter = "all" | "pending" | "downloaded" | "revoked";

function fmtSize(b: number) {
  if (!b) return "0 o";
  const k=1024,s=["o","Ko","Mo","Go","To"],i=Math.floor(Math.log(b)/Math.log(k));
  return parseFloat((b/Math.pow(k,i)).toFixed(1))+" "+s[i];
}

export default function HistoryPanel() {
  const { transfers, updateTransferStatus } = useStore();
  const [filt, setFilt] = useState<Filter>("all");
  const [copied, setCopied] = useState<string | null>(null);

  const visible = filt === "all" ? transfers : transfers.filter((t) => t.status === filt);

  const copyLink = (t: typeof transfers[0]) => {
    navigator.clipboard.writeText(t.link).catch(()=>{});
    setCopied(t.transfer_id);
    setTimeout(() => setCopied(null), 2000);
  };

  const revoke = async (t: typeof transfers[0]) => {
    if (!confirm(`Révoquer «${t.file_name}» ? Le destinataire ne pourra plus télécharger.`)) return;
    try {
      await transferZome.revokeTransfer(t.transfer_id);
      await storageZome.deleteChunks(t.transfer_id);
      updateTransferStatus(t.transfer_id, "revoked");
    } catch (e) { alert("Erreur révocation : " + String(e)); }
  };

  const statusLabel: Record<string, string> = { pending:"En attente", downloaded:"Téléchargé", revoked:"Révoqué", expired:"Expiré" };
  const statusClass: Record<string, string> = { pending:"badge-pending", downloaded:"badge-done", revoked:"badge-revoked", expired:"badge-expired" };

  return (
    <div>
      <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:"1rem" }}>
        <div style={{ fontSize:"1rem",fontWeight:700 }}>Transferts sortants</div>
        <div style={{ display:"flex",gap:".3rem" }}>
          {(["all","pending","downloaded","revoked"] as Filter[]).map((f) => (
            <button key={f} className={filt===f?"btn-primary btn-sm":"btn-ghost btn-sm"} onClick={() => setFilt(f)}>
              {{all:"Tous",pending:"En attente",downloaded:"Téléchargés",revoked:"Révoqués"}[f]}
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 && (
        <div className="empty"><div style={{ fontSize:"2.2rem",marginBottom:".6rem" }}>📭</div>Aucun transfert</div>
      )}

      {visible.map((t) => (
        <div key={t.transfer_id} style={{ display:"flex",alignItems:"flex-start",gap:".9rem",padding:"1rem 1.1rem",background:"#fff",border:"1px solid var(--border)",borderRadius:"12px",marginBottom:".6rem",boxShadow:"var(--shadow)",transition:"border-color .15s" }}>
          <div style={{ width:"38px",height:"38px",borderRadius:"9px",background:"var(--grad-soft)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"1.2rem",flexShrink:0 }}>📄</div>
          <div style={{ flex:1,minWidth:0 }}>
            <div style={{ fontSize:".9rem",fontWeight:600,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>{t.file_name}</div>
            <div style={{ fontSize:".75rem",color:"var(--muted)",marginTop:".1rem" }}>{t.to} · {fmtSize(t.size)} · {t.date}</div>
            <div style={{ marginTop:".35rem",display:"flex",alignItems:"center",gap:".4rem" }}>
              <span className={`badge ${statusClass[t.status]}`}>{statusLabel[t.status]}</span>
              {t.status === "downloaded" && <span style={{ fontSize:".73rem",color:"var(--muted)" }}>{t.downloads}/{t.max_dl===0?"∞":t.max_dl} dl</span>}
            </div>
          </div>
          <div style={{ display:"flex",gap:".35rem",flexShrink:0 }}>
            <button className="btn-ghost btn-sm" onClick={() => copyLink(t)}>
              {copied === t.transfer_id ? "✓" : "🔗"}
            </button>
            {t.status === "pending" && (
              <button className="btn-danger btn-sm" onClick={() => revoke(t)}>Révoquer</button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
