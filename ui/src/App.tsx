/**
 * Composant racine — v2
 * Styles: ./styles.css
 */

import { useEffect } from "react";
import { initClient, onSignal } from "./holochain/client";
import { useStore } from "./store/useStore";
import type { FilenymousSignal } from "./holochain/types";
import Header from "./components/Header";
import Footer from "./components/Footer";
import RoomPanel from "./components/RoomPanel";
import SendPanel from "./components/SendPanel";
import ReceivePanel from "./components/ReceivePanel";
import HistoryPanel from "./components/HistoryPanel";
import IdentityPanel from "./components/IdentityPanel";
import ContactsPanel from "./components/ContactsPanel";
import PrivacyPanel from "./components/PrivacyPanel";
import WalletPanel from "./components/WalletPanel";
import "./styles.css";

function AdvancedPanel() {
  return (
    <section className="panel-enter">
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

  const urlHash = window.location.hash;
  const isLinkDl = urlHash.startsWith("#") && urlHash.includes(":");

  useEffect(() => {
    let alive = true;
    initClient().then((mode) => {
      if (alive) setNet({ connected: mode === "holo-web" || mode === "websocket", mode, peers: 0 });
    });

    onSignal((raw) => {
      const sig = raw as FilenymousSignal;
      if (sig?.type === "IncomingParcel") {
        console.info("[Filenymous] Nouveau parcel recu :", sig.file_name);
      }
    });

    return () => {
      alive = false;
    };
  }, [setNet]);

  if (isLinkDl) {
    return (
      <div className="app">
        <Header minimal />
        <main className="main panel-enter">
          <ReceivePanel />
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="app">
      <Header />
      <main className="main panel-enter" key={tab}>
        {tab === "send" && <SendPanel />}
        {tab === "receive" && <ReceivePanel />}
        {tab === "rooms" && <RoomPanel />}
        {tab === "contacts" && <ContactsPanel />}
        {tab === "identity" && <IdentityPanel />}
        {tab === "history" && <HistoryPanel />}
        {tab === "advanced" && <AdvancedPanel />}
      </main>
      <Footer />
    </div>
  );
}
