/**
 * Header v2 — navigation avec le nouvel onglet "inbox".
 * Affiche le mode réseau (WebSocket / Web Bridge).
 */
import { useStore } from "../store/useStore";
import type { Tab } from "../store/useStore";

interface HeaderProps { minimal?: boolean }

export default function Header({ minimal = false }: HeaderProps) {
  const { tab, setTab, net } = useStore();

  const tabs: Array<{ id: Tab; label: string; icon: string }> = [
    { id: "room",     label: "Room",      icon: "◎" },
    { id: "send",     label: "Envoyer",   icon: "📤" },
    { id: "inbox",    label: "Reçus",     icon: "📥" },
    { id: "history",  label: "Historique",icon: "📋" },
    { id: "identity", label: "Identité",  icon: "🔑" },
    { id: "privacy",  label: "Vie privée",icon: "🛡" },
  ];

  const modeLabel = net.mode === "holo-web" ? "Holo Web"
    : net.mode === "websocket" ? "Holochain local"
    : net.mode === "web-bridge" ? "Holo Web Bridge"
    : net.mode === "local-only" ? "Local"
    : "Connexion...";
  const modeColor = net.mode === "holo-web" || net.mode === "websocket" ? "#059669"
    : net.mode === "web-bridge" ? "#d97706"
    : "#9ca3af";

  return (
    <header style={{ background:"var(--grad)", color:"#fff", padding:"0", boxShadow:"0 2px 12px rgba(99,102,241,.25)" }}>
      {/* Barre titre */}
      <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",padding:".8rem 1.5rem" }}>
        <div style={{ display:"flex",alignItems:"center",gap:".6rem" }}>
          <span style={{ fontSize:"1.4rem" }}>⟁</span>
          <span style={{ fontWeight:800,fontSize:"1.1rem",letterSpacing:"-.02em" }}>Filenymous</span>
        </div>
        <div style={{ fontSize:".72rem",background:"rgba(255,255,255,.18)",borderRadius:"20px",padding:".2rem .65rem",display:"flex",alignItems:"center",gap:".35rem" }}>
          <span style={{ width:"7px",height:"7px",borderRadius:"50%",background:modeColor,display:"inline-block",flexShrink:0 }} />
          {modeLabel}
        </div>
      </div>

      {/* Onglets (masqués en mode minimal) */}
      {!minimal && (
        <nav style={{ display:"flex",borderTop:"1px solid rgba(255,255,255,.15)" }}>
          {tabs.map(({ id, label, icon }) => (
            <button key={id}
              onClick={() => setTab(id)}
              style={{
                flex:1, padding:".55rem .2rem", background:"transparent", color:"#fff",
                borderRadius:0, fontWeight: tab===id ? 700 : 400,
                borderBottom: tab===id ? "2px solid #fff" : "2px solid transparent",
                fontSize:".75rem", display:"flex", flexDirection:"column", alignItems:"center", gap:".1rem",
                opacity: tab===id ? 1 : 0.7, transition:"opacity .15s",
              }}>
              <span style={{ fontSize:"1rem" }}>{icon}</span>
              <span>{label}</span>
            </button>
          ))}
        </nav>
      )}
    </header>
  );
}
