/**
 * HistoryPanel v2 — historique des parcels envoyés.
 * Source : store Zustand (état local de session) + parcels DHT via get_my_sent_parcels.
 */

import { useState, useEffect } from "react";
import { parcelZome }     from "../holochain/delivery";
import { hasConductor }   from "../holochain/client";
import { useStore }       from "../store/useStore";
import type { LocalParcel } from "../holochain/types";

type Filter = "all" | "pending" | "downloaded" | "revoked";

function fmtSize(b: number) {
  if (!b) return "0 o";
  const k=1024,s=["o","Ko","Mo","Go","To"],i=Math.floor(Math.log(b)/Math.log(k));
  return parseFloat((b/Math.pow(k,i)).toFixed(1))+" "+s[i];
}

export default function HistoryPanel() {
  const { parcels, updateParcelStatus } = useStore();
  const [filt,   setFilt]   = useState<Filter>("all");
  const [copied, setCopied] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Synchronise les statuts depuis le DHT au montage
  useEffect(() => {
    if (!hasConductor() || parcels.length === 0) return;
    syncFromDht();
  }, []); // eslint-disable-line

  const syncFromDht = async () => {
    setRefreshing(true);
    try {
      const dhtParcels = await parcelZome.getMySentParcels();
      for (const p of dhtParcels) {
        const ehStr = btoa(String.fromCharCode(...(p.parcel_eh as unknown as number[])))
          .replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
        const newStatus: LocalParcel["status"] = p.is_revoked
          ? "revoked"
          : p.manifest.expiry_us > 0 && Date.now() * 1000 > p.manifest.expiry_us
            ? "expired"
            : p.download_count > 0
              ? "downloaded"
              : "pending";
        updateParcelStatus(ehStr, newStatus);
      }
    } catch { /* silencieux */ }
    setRefreshing(false);
  };

  const copyLink = (p: LocalParcel) => {
    navigator.clipboard.writeText(p.link).catch(()=>{});
    setCopied(p.parcel_eh);
    setTimeout(() => setCopied(null), 2000);
  };

  const revoke = async (p: LocalParcel) => {
    if (!confirm(`Révoquer «${p.file_name}» ? Le destinataire ne pourra plus télécharger.`)) return;
    if (!hasConductor()) { alert("Révocation impossible en mode Web Bridge."); return; }
    try {
      const ehBytes = Uint8Array.from(atob(p.parcel_eh.replace(/-/g,"+").replace(/_/g,"/")), c => c.charCodeAt(0));
      await parcelZome.revokeParcel(Array.from(ehBytes) as unknown as any);
      updateParcelStatus(p.parcel_eh, "revoked");
    } catch (e) { alert("Erreur révocation : " + String(e)); }
  };

  const visible = filt === "all" ? parcels : parcels.filter((p) => p.status === filt);

  const statusLabel: Record<string, string> = { pending:"En attente", downloaded:"Téléchargé", revoked:"Révoqué", expired:"Expiré" };
  const statusClass: Record<string, string> = { pending:"badge-pending", downloaded:"badge-done", revoked:"badge-revoked", expired:"badge-expired" };
  const modeLabel: Record<string, string>   = { agent:"Via DHT agent", link:"Via lien one-time" };

  return (
    <div>
      <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:"1rem" }}>
        <div style={{ fontSize:"1rem", fontWeight:700 }}>Transferts envoyés</div>
        <div style={{ display:"flex", gap:".4rem" }}>
          <button className="btn-ghost btn-sm" onClick={syncFromDht} disabled={refreshing || !hasConductor()}>
            {refreshing ? <span className="spin" style={{ borderTopColor:"var(--g1)" }} /> : "↻"}
          </button>
          {(["all","pending","downloaded","revoked"] as Filter[]).map((f) => (
            <button key={f} className={filt===f?"btn-primary btn-sm":"btn-ghost btn-sm"} onClick={()=>setFilt(f)}>
              {{all:"Tous",pending:"En attente",downloaded:"Téléchargés",revoked:"Révoqués"}[f]}
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 && (
        <div className="empty"><div style={{ fontSize:"2.2rem",marginBottom:".6rem" }}>📭</div>Aucun transfert</div>
      )}

      {visible.map((p) => (
        <div key={p.parcel_eh} style={{ display:"flex",alignItems:"flex-start",gap:".9rem",padding:"1rem 1.1rem",background:"rgba(255,255,255,.05)",border:"1px solid var(--border)",borderRadius:"14px",marginBottom:".6rem",boxShadow:"var(--shadow)" }}>
          <div style={{ width:"38px",height:"38px",borderRadius:"9px",background:"var(--grad-soft)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"1.2rem",flexShrink:0 }}>📄</div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:".9rem",fontWeight:600,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>{p.file_name}</div>
            <div style={{ fontSize:".75rem",color:"var(--muted)",marginTop:".1rem" }}>
              {p.to} · {fmtSize(p.size)} · {p.date}
            </div>
            <div style={{ marginTop:".35rem",display:"flex",alignItems:"center",gap:".4rem",flexWrap:"wrap" }}>
              <span className={`badge ${statusClass[p.status]}`}>{statusLabel[p.status]}</span>
              <span style={{ fontSize:".7rem",color:"var(--muted)" }}>{modeLabel[p.mode]}</span>
              {p.status === "downloaded" && (
                <span style={{ fontSize:".73rem",color:"var(--muted)" }}>{p.downloads}/{p.max_dl===0?"∞":p.max_dl} dl</span>
              )}
            </div>
          </div>
          <div style={{ display:"flex",gap:".35rem",flexShrink:0 }}>
            <button className="btn-ghost btn-sm" onClick={() => copyLink(p)} title="Copier le lien">
              {copied === p.parcel_eh ? "✓" : "🔗"}
            </button>
            {p.status === "pending" && hasConductor() && (
              <button className="btn-danger btn-sm" onClick={() => revoke(p)}>Révoquer</button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
