/**
 * Composant racine — v2.
 * Nouveaux onglets : send | inbox | history | identity | privacy
 * - "inbox" remplace "receive" : liste les parcels entrants en attente
 * - Le lien one-time (#fragment) est toujours géré par ReceivePanel (chargé via URL)
 */

import { useEffect } from "react";
import { initClient, onSignal } from "./holochain/client";
import { useStore }       from "./store/useStore";
import type { FilenymousSignal } from "./holochain/types";
import Header             from "./components/Header";
import Footer             from "./components/Footer";
import RoomPanel          from "./components/RoomPanel";
import SendPanel          from "./components/SendPanel";
import ReceivePanel       from "./components/ReceivePanel";
import HistoryPanel       from "./components/HistoryPanel";
import IdentityPanel      from "./components/IdentityPanel";
import ContactsPanel       from "./components/ContactsPanel";
import PrivacyPanel       from "./components/PrivacyPanel";
import WalletPanel        from "./components/WalletPanel";

const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --g1:#165dff; --g2:#0f766e; --g3:#7c3aed;
    --grad:linear-gradient(135deg,#165dff,#0f766e);
    --grad-soft:linear-gradient(135deg,#eef4ff,#e8f7f3);
    --text:#111827; --muted:#667085; --border:#d9e2ec;
    --bg:#f6f8fb; --white:#ffffff;
    --ok:#059669; --err:#dc2626; --warn:#b45309;
    --radius:10px;
    --font:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    --shadow:0 10px 30px rgba(17,24,39,.06);
  }
  html { font-size:15px; }
  body { font-family:var(--font); background:var(--bg); color:var(--text); min-height:100vh; line-height:1.55; }
  input,select,textarea {
    font-family:inherit; font-size:inherit; background:var(--white); color:var(--text);
    border:1.5px solid var(--border); border-radius:var(--radius);
    padding:.6rem .9rem; outline:none; width:100%;
    transition:border-color .15s,box-shadow .15s;
  }
  input:focus,select:focus,textarea:focus { border-color:var(--g1); box-shadow:0 0 0 3px rgba(99,102,241,.15); }
  textarea { resize:vertical; min-height:76px; }
  button { font-family:inherit; font-size:inherit; cursor:pointer; border:none; border-radius:var(--radius); padding:.6rem 1.2rem; transition:all .15s; }
  button:active { transform:scale(.98); }
  button:disabled { opacity:.45; cursor:not-allowed; transform:none; }
  .btn-primary { background:var(--text); color:#fff; font-weight:700; box-shadow:0 8px 18px rgba(17,24,39,.14); }
  .btn-primary:hover:not(:disabled) { background:#000; box-shadow:0 12px 24px rgba(17,24,39,.18); }
  .btn-ghost { background:transparent; color:var(--g1); border:1.5px solid var(--border); font-weight:500; }
  .btn-ghost:hover:not(:disabled) { border-color:var(--g1); background:#ede9fe33; }
  .btn-danger { background:var(--err); color:#fff; font-weight:600; }
  .btn-success { background:var(--ok); color:#fff; font-weight:600; }
  .btn-full { width:100%; }
  .btn-sm { padding:.3rem .75rem; font-size:.82rem; }
  .card { background:var(--white); border:1px solid var(--border); border-radius:8px; padding:1.6rem; margin-bottom:1rem; box-shadow:var(--shadow); }
  .card-label { font-size:.74rem; font-weight:800; color:var(--g1); text-transform:uppercase; letter-spacing:.06em; margin-bottom:.9rem; }
  .form-row { margin-bottom:.9rem; }
  .form-label { display:block; font-size:.8rem; font-weight:600; color:var(--muted); margin-bottom:.35rem; }
  .info-box { background:#ede9fe; border:1px solid #c4b5fd; border-radius:10px; padding:.75rem 1rem; font-size:.82rem; color:#4c1d95; margin-bottom:1rem; display:flex; gap:.6rem; }
  .warn-box { background:#fef3c7; border:1px solid #fcd34d; border-radius:10px; padding:.75rem 1rem; font-size:.82rem; color:#92400e; margin-bottom:1rem; display:flex; gap:.6rem; }
  .progress-bar { height:6px; border-radius:3px; background:#e5e7eb; overflow:hidden; }
  .progress-fill { height:100%; border-radius:3px; background:var(--grad); transition:width .35s ease; }
  .badge { display:inline-flex; align-items:center; font-size:.72rem; font-weight:600; padding:.18rem .55rem; border-radius:20px; }
  .badge-pending { background:#fef3c7; color:var(--warn); }
  .badge-done    { background:#d1fae5; color:var(--ok); }
  .badge-revoked { background:#fee2e2; color:var(--err); }
  .badge-expired { background:#f3f4f6; color:var(--muted); }
  .spin { display:inline-block; width:13px; height:13px; border:2px solid rgba(255,255,255,.35); border-top-color:#fff; border-radius:50%; animation:sp .6s linear infinite; }
  @keyframes sp { to { transform:rotate(360deg); } }
  .empty { text-align:center; padding:3rem 1rem; color:var(--muted); font-size:.9rem; }
  .main { flex:1; max-width:1040px; margin:0 auto; width:100%; padding:2.2rem 1.2rem 4rem; }
  .app  { display:flex; flex-direction:column; min-height:100vh; }
  .site-header { position:sticky; top:0; z-index:10; background:rgba(255,255,255,.92); backdrop-filter:blur(18px); border-bottom:1px solid var(--border); }
  .header-inner { display:flex; align-items:center; justify-content:space-between; gap:1rem; max-width:1120px; margin:0 auto; padding:.85rem 1.2rem; }
  .brand { display:flex; align-items:center; gap:.7rem; padding:0; background:transparent; color:var(--text); text-align:left; }
  .brand:active { transform:none; }
  .brand-mark { width:34px; height:34px; border-radius:8px; display:grid; place-items:center; background:var(--text); color:#fff; font-weight:900; }
  .brand strong { display:block; font-size:1rem; line-height:1.05; }
  .brand small { display:block; color:var(--muted); font-size:.72rem; margin-top:.12rem; }
  .net-pill { display:inline-flex; align-items:center; gap:.4rem; padding:.35rem .7rem; border:1px solid var(--border); border-radius:999px; color:var(--muted); font-size:.75rem; background:#fff; white-space:nowrap; }
  .net-pill span { width:8px; height:8px; border-radius:50%; background:#9ca3af; }
  .net-pill.is-online span { background:var(--ok); }
  .top-tabs { max-width:1120px; margin:0 auto; padding:0 .8rem .65rem; display:flex; gap:.35rem; overflow-x:auto; }
  .top-tabs button { min-width:104px; display:flex; align-items:center; justify-content:center; gap:.45rem; background:transparent; color:var(--muted); border:1px solid transparent; border-radius:8px; padding:.55rem .8rem; font-weight:700; font-size:.86rem; }
  .top-tabs button:hover { color:var(--text); background:#f1f5f9; }
  .top-tabs button.active { color:var(--text); background:#fff; border-color:var(--border); box-shadow:0 6px 18px rgba(17,24,39,.06); }
  .tab-icon { width:16px; height:16px; display:inline-block; position:relative; color:currentColor; }
  .tab-icon::before, .tab-icon::after { content:""; position:absolute; inset:3px; border:1.8px solid currentColor; border-radius:4px; }
  .tab-icon[data-icon="up"]::after { inset:2px 6px auto 6px; width:5px; height:5px; border-width:1.8px 1.8px 0 0; transform:rotate(-45deg); border-radius:1px; }
  .tab-icon[data-icon="down"]::after { inset:auto 6px 2px 6px; width:5px; height:5px; border-width:0 0 1.8px 1.8px; transform:rotate(-45deg); border-radius:1px; }
  .tab-icon[data-icon="room"]::before { border-radius:50%; }
  .tab-icon[data-icon="room"]::after { inset:6px 1px 1px 6px; border-radius:50%; background:currentColor; }
  .tab-icon[data-icon="list"]::before { inset:3px; }
  .tab-icon[data-icon="list"]::after { inset:5px 4px auto 4px; height:1.8px; background:currentColor; box-shadow:0 4px 0 currentColor,0 8px 0 currentColor; border:0; }
  .tab-icon[data-icon="contacts"]::before { border-radius:50%; inset:2px 5px 6px 5px; }
  .tab-icon[data-icon="contacts"]::after { inset:auto 2px 1px 2px; height:5px; border-width:1.8px 1.8px 0 1.8px; border-radius:6px 6px 0 0; }
  .tab-icon[data-icon="id"]::before { inset:2px; border-radius:4px; }
  .tab-icon[data-icon="id"]::after { inset:5px auto auto 5px; width:4px; height:4px; border-radius:50%; background:currentColor; border:0; box-shadow:6px 1px 0 -1px currentColor, 6px 4px 0 -1px currentColor; }
  .tab-icon[data-icon="gear"]::before { border-radius:50%; }
  .tab-icon[data-icon="gear"]::after { inset:6px; border-radius:50%; background:currentColor; border:0; }
  .advanced-grid { display:grid; gap:1rem; }
  .advanced-intro { margin-bottom:1rem; }
  .room-shell { display:grid; gap:1rem; }
  .room-hero { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:1.4rem; margin-bottom:0; }
  .room-hero h1 { font-size:clamp(1.6rem,3vw,2.35rem); line-height:1.05; margin-bottom:.55rem; letter-spacing:0; }
  .room-hero p, .room-summary { color:var(--muted); font-size:.95rem; max-width:620px; }
  .room-actions { display:flex; gap:.55rem; flex-wrap:wrap; justify-content:flex-end; }
  .room-invite-card { display:grid; grid-template-columns:minmax(0,280px) minmax(0,1fr); gap:1rem; align-items:center; margin-bottom:0; }
  .room-grid { display:grid; grid-template-columns:1fr 1.15fr; gap:1rem; align-items:start; }
  .room-panel { margin-bottom:0; }
  .room-chat { grid-column:1 / -1; }
  .peer-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(128px,1fr)); gap:.65rem; margin-bottom:.8rem; }
  .peer-card { min-height:118px; display:grid; place-items:center; gap:.28rem; padding:.9rem; }
  .peer-avatar { width:44px; height:44px; border-radius:50%; display:grid; place-items:center; background:#e8f7f3; color:#0f766e; font-weight:900; }
  .btn-primary .peer-avatar { background:rgba(255,255,255,.18); color:#fff; }
  .peer-card small { opacity:.75; font-size:.72rem; }
  .room-drop { min-height:170px; border:1.5px dashed var(--border); border-radius:8px; display:grid; place-items:center; text-align:center; gap:.25rem; padding:1.2rem; cursor:pointer; background:#f8fafc; color:var(--text); }
  .room-drop input { position:absolute; width:1px; height:1px; opacity:0; pointer-events:none; }
  .room-drop span { display:block; color:var(--muted); font-size:.85rem; max-width:320px; }
  .room-drop.is-dragging { background:#e8f7f3; border-color:var(--ok); }
  .room-drop.is-disabled { cursor:not-allowed; color:var(--muted); background:#f3f4f6; }
  .room-transfer-list { display:grid; gap:.45rem; margin-top:.85rem; }
  .room-transfer-row { display:flex; justify-content:space-between; gap:.8rem; padding:.55rem .7rem; border:1px solid var(--border); border-radius:8px; background:#fff; }
  .room-transfer-row span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .room-messages { display:grid; gap:.45rem; margin-top:.85rem; }
  .room-messages p { display:grid; gap:.1rem; padding:.65rem .75rem; border:1px solid var(--border); border-radius:8px; background:#f8fafc; }
  .room-messages span { color:var(--muted); }
  .room-footnote { margin-bottom:0; }
  @media (max-width: 720px) {
    .header-inner { padding:.75rem .9rem; }
    .top-tabs { padding:0 .65rem .6rem; }
    .top-tabs button { min-width:88px; font-size:.8rem; padding:.5rem .65rem; }
    .main { padding:1rem .75rem 3rem; }
    .room-hero, .room-invite-card, .room-grid { grid-template-columns:1fr; }
    .room-actions { justify-content:stretch; }
    .room-actions button { flex:1; }
  }
`;

function AdvancedPanel() {
  return (
    <section>
      <div className="card advanced-intro">
        <div className="card-label">Advanced</div>
        <h1 style={{ fontSize: "1.35rem", lineHeight: 1.2, marginBottom: ".45rem" }}>
          Network, identity, security, and wallet controls
        </h1>
        <p style={{ color: "var(--muted)", fontSize: ".92rem" }}>
          These settings are for power users. The normal Send, Receive, and Rooms flows work without reading this section.
        </p>
      </div>
      <div className="advanced-grid">
        <PrivacyPanel />
        <IdentityPanel />
        <WalletPanel />
      </div>
    </section>
  );
}

export default function App() {
  const { tab, setNet } = useStore();

  // Vérifier si l'URL contient un lien one-time (#parcelEh:aesKey)
  // Si oui, basculer directement sur le panel de réception
  const urlHash  = window.location.hash;
  const isLinkDl = urlHash.startsWith("#") && urlHash.includes(":");

  useEffect(() => {
    let alive = true;
    initClient().then((mode) => {
      if (alive) setNet({ connected: mode === "holo-web" || mode === "websocket", mode, peers: 0 });
    });

    // Écoute les signaux Holochain (nouveau parcel entrant)
    onSignal((raw) => {
      const sig = raw as FilenymousSignal;
      if (sig?.type === "IncomingParcel") {
        // Notification toast / indicateur d'inbox (simple pour l'instant)
        console.info("[Filenymous] Nouveau parcel recu :", sig.file_name);
      }
    });

    return () => { alive = false; };
  }, [setNet]);

  // Si l'URL est un lien de téléchargement, afficher directement ReceivePanel
  if (isLinkDl) {
    return (
      <>
        <style>{CSS}</style>
        <div className="app">
          <Header minimal />
          <main className="main"><ReceivePanel /></main>
          <Footer />
        </div>
      </>
    );
  }

  return (
    <>
      <style>{CSS}</style>
      <div className="app">
        <Header />
        <main className="main">
          {tab === "send"     && <SendPanel />}
          {tab === "receive"  && <ReceivePanel />}
          {tab === "rooms"    && <RoomPanel />}
          {tab === "contacts" && <ContactsPanel />}
          {tab === "identity" && <IdentityPanel />}
          {tab === "history"  && <HistoryPanel />}
          {tab === "advanced" && <AdvancedPanel />}
        </main>
        <Footer />
      </div>
    </>
  );
}
