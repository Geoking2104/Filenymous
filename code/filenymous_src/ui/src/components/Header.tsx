import { useStore, type Tab } from "../store/useStore";

const TABS: { id: Tab; label: string }[] = [
  { id: "send",     label: "Envoyer" },
  { id: "receive",  label: "Recevoir" },
  { id: "history",  label: "Historique" },
  { id: "identity", label: "Identité" },
];

const STYLE = `
  .header { background:#fff; border-bottom:1px solid #e5e7eb; padding:.9rem 2rem; display:flex; align-items:center; justify-content:space-between; position:sticky; top:0; z-index:50; }
  .logo { display:flex; align-items:center; gap:.6rem; font-size:1.15rem; font-weight:800; color:#6366f1; letter-spacing:-.03em; }
  .logo-mark { width:34px; height:34px; border-radius:9px; background:linear-gradient(135deg,#6366f1,#8b5cf6); display:flex; align-items:center; justify-content:center; font-size:1rem; color:#fff; box-shadow:0 2px 8px rgba(99,102,241,.4); }
  .nav { display:flex; gap:.15rem; }
  .nav-btn { background:transparent; color:#6b7280; padding:.4rem .85rem; font-size:.88rem; font-weight:500; border-radius:8px; border:none; }
  .nav-btn:hover { background:#f3f4f6; color:#1e1b4b; }
  .nav-btn.active { background:#ede9fe; color:#6366f1; font-weight:600; }
  .peer-badge { display:flex; align-items:center; gap:.4rem; font-size:.78rem; color:#6b7280; padding:.3rem .75rem; background:#f9fafb; border:1.5px solid #e5e7eb; border-radius:20px; }
  .dot { width:7px; height:7px; border-radius:50%; }
  .dot-on  { background:#059669; box-shadow:0 0 0 3px rgba(5,150,105,.15); }
  .dot-off { background:#dc2626; }
`;

export default function Header() {
  const { tab, setTab, net, transfers } = useStore();
  const pending = transfers.filter((t) => t.status === "pending").length;

  return (
    <>
      <style>{STYLE}</style>
      <header className="header">
        <div className="logo">
          <div className="logo-mark">⟁</div>
          Filenymous
        </div>

        <nav className="nav">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              className={`nav-btn${tab === id ? " active" : ""}`}
              onClick={() => setTab(id)}
            >
              {label}
              {id === "history" && pending > 0 && (
                <span style={{ color: "var(--g1)", marginLeft: ".2rem" }}>
                  ({pending})
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="peer-badge">
          <span className={`dot ${net.connected ? "dot-on" : "dot-off"}`} />
          {net.connected ? `${net.peers} pairs DHT` : "Hors-ligne"}
        </div>
      </header>
    </>
  );
}
