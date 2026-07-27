/**
 * Composant racine — v2
 * Styles: ./styles.css + ./styles-notify.css
 */

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { initClient, onSignal } from "./holochain/client";
import { useStore } from "./store/useStore";
import type { Tab } from "./store/useStore";
import { notify } from "./store/notifications";
import { listenSWMessages } from "./pwa/registerSW";
import type { FilenymousSignal } from "./holochain/types";
import Header from "./components/Header";
import Footer from "./components/Footer";
import ToastStack from "./components/ToastStack";
import RoomPanel from "./components/RoomPanel";
import SendPanel from "./components/SendPanel";
import ReceivePanel from "./components/ReceivePanel";
import HistoryPanel from "./components/HistoryPanel";
import IdentityPanel from "./components/IdentityPanel";
import ContactsPanel from "./components/ContactsPanel";
import PrivacyPanel from "./components/PrivacyPanel";
import WalletPanel from "./components/WalletPanel";
import "./styles.css";
import "./styles-notify.css";

const TABS: Tab[] = ["send", "receive", "rooms", "contacts", "identity", "history", "advanced"];

function AdvancedPanel() {
  const { t } = useTranslation();
  return (
    <section className="panel-enter">
      <div className="card advanced-intro">
        <div className="card-label">{t("advanced.label")}</div>
        <h1 style={{ fontSize: "1.35rem", lineHeight: 1.2, marginBottom: ".45rem" }}>
          {t("advanced.title")}
        </h1>
        <p style={{ color: "var(--muted)", fontSize: ".92rem" }}>
          {t("advanced.subtitle")}
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
  const { tab, setTab, setNet } = useStore();

  const urlHash = window.location.hash;
  const isLinkDl = urlHash.startsWith("#") && urlHash.includes(":");

  useEffect(() => {
    let alive = true;
    initClient().then((mode) => {
      if (!alive) return;
      const connected = mode === "holo-web" || mode === "websocket";
      setNet({ connected, mode, peers: 0 });
      if (connected) {
        notify.success("Réseau connecté", `Mode ${mode}`);
      }
    });

    onSignal((raw) => {
      const sig = raw as FilenymousSignal;
      if (sig?.type === "IncomingParcel") {
        notify.transfer("Nouveau fichier reçu", sig.file_name || "Parcel entrant");
      }
    });

    const unlisten = listenSWMessages((nextTab) => {
      if (TABS.includes(nextTab as Tab)) setTab(nextTab as Tab);
    });

    // Deep-link from notification: #tab=receive
    const hash = window.location.hash;
    const tabMatch = hash.match(/tab=([a-z]+)/i);
    if (tabMatch && TABS.includes(tabMatch[1] as Tab)) {
      setTab(tabMatch[1] as Tab);
    }

    return () => {
      alive = false;
      unlisten();
    };
  }, [setNet, setTab]);

  if (isLinkDl) {
    return (
      <div className="app">
        <Header minimal />
        <main className="main panel-enter">
          <ReceivePanel />
        </main>
        <Footer />
        <ToastStack />
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
      <ToastStack />
    </div>
  );
}
