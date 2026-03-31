/**
 * Root component — connects to Holochain on mount, renders tab shell.
 */

import { useEffect } from "react";
import { getClient } from "./holochain/client";
import { useStore }  from "./store/useStore";
import Header        from "./components/Header";
import Footer        from "./components/Footer";
import SendPanel     from "./components/SendPanel";
import ReceivePanel  from "./components/ReceivePanel";
import HistoryPanel  from "./components/HistoryPanel";
import IdentityPanel from "./components/IdentityPanel";
import PrivacyPanel  from "./components/PrivacyPanel";

// Global styles (single <style> block keeps things self-contained)
const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --g1:#6366f1; --g2:#8b5cf6; --g3:#a78bfa;
    --grad:linear-gradient(135deg,#6366f1,#8b5cf6);
    --grad-soft:linear-gradient(135deg,#ede9fe,#e0e7ff);
    --text:#1e1b4b; --muted:#6b7280; --border:#e5e7eb;
    --bg:#f9fafb; --white:#ffffff;
    --ok:#059669; --err:#dc2626; --warn:#d97706;
    --radius:12px;
    --font:'Inter',system-ui,-apple-system,sans-serif;
    --shadow:0 1px 3px rgba(0,0,0,.07),0 4px 16px rgba(99,102,241,.07);
  }
  html { font-size:15px; }
  body { font-family:var(--font); background:var(--bg); color:var(--text); min-height:100vh; line-height:1.55; }
  input,select,textarea {
    font-family:inherit; font-size:inherit;
    background:var(--white); color:var(--text);
    border:1.5px solid var(--border); border-radius:var(--radius);
    padding:.6rem .9rem; outline:none; width:100%;
    transition:border-color .15s,box-shadow .15s;
  }
  input:focus,select:focus,textarea:focus {
    border-color:var(--g1); box-shadow:0 0 0 3px rgba(99,102,241,.15);
  }
  textarea { resize:vertical; min-height:76px; line-height:1.55; }
  button {
    font-family:inherit; font-size:inherit; cursor:pointer;
    border:none; border-radius:var(--radius); padding:.6rem 1.2rem;
    transition:all .15s;
  }
  button:active { transform:scale(.98); }
  button:disabled { opacity:.45; cursor:not-allowed; transform:none; }
  .btn-primary { background:var(--grad); color:#fff; font-weight:600; box-shadow:0 2px 8px rgba(99,102,241,.3); }
  .btn-primary:hover:not(:disabled) { filter:brightness(1.06); box-shadow:0 4px 16px rgba(99,102,241,.4); }
  .btn-ghost { background:transparent; color:var(--g1); border:1.5px solid var(--border); font-weight:500; }
  .btn-ghost:hover:not(:disabled) { border-color:var(--g1); background:#ede9fe33; }
  .btn-danger { background:var(--err); color:#fff; font-weight:600; }
  .btn-success { background:var(--ok); color:#fff; font-weight:600; }
  .btn-full { width:100%; }
  .btn-sm { padding:.3rem .75rem; font-size:.82rem; }
  .card { background:var(--white); border:1px solid var(--border); border-radius:16px; padding:1.6rem; margin-bottom:1rem; box-shadow:var(--shadow); }
  .card-label { font-size:.73rem; font-weight:700; color:var(--g2); text-transform:uppercase; letter-spacing:.06em; margin-bottom:.9rem; }
  .form-row { margin-bottom:.9rem; }
  .form-label { display:block; font-size:.8rem; font-weight:600; color:var(--muted); margin-bottom:.35rem; }
  .info-box { background:#ede9fe; border:1px solid #c4b5fd; border-radius:10px; padding:.75rem 1rem; font-size:.82rem; color:#4c1d95; margin-bottom:1rem; display:flex; gap:.6rem; }
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
  .main { flex:1; max-width:680px; margin:0 auto; width:100%; padding:2.5rem 1.5rem 4rem; }
  .app  { display:flex; flex-direction:column; min-height:100vh; }
`;

export default function App() {
  const { tab, setNet } = useStore();

  // Connect to Holochain conductor on mount
  useEffect(() => {
    let alive = true;
    getClient()
      .then(() => { if (alive) setNet({ connected: true, peers: 0 }); })
      .catch((e) => console.error("Holochain connection failed:", e));
    return () => { alive = false; };
  }, [setNet]);

  return (
    <>
      <style>{CSS}</style>
      <div className="app">
        <Header />
        <main className="main">
          {tab === "send"     && <SendPanel />}
          {tab === "receive"  && <ReceivePanel />}
          {tab === "history"  && <HistoryPanel />}
          {tab === "identity" && <IdentityPanel />}
          {tab === "privacy"  && <PrivacyPanel />}
        </main>
        <Footer />
      </div>
    </>
  );
}
