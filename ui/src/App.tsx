/**
 * Root — UX v3 shell + Magic Link deep receive
 */

import { useEffect, useState } from "react";
import { initClient, onSignal } from "./holochain/client";
import { useStore } from "./store/useStore";
import type { Tab } from "./store/useStore";
import { notify } from "./store/notifications";
import { listenSWMessages } from "./pwa/registerSW";
import type { FilenymousSignal } from "./holochain/types";
import Header from "./components/Header";
import Footer from "./components/Footer";
import ToastStack from "./components/ToastStack";
import ReceivePanel from "./components/ReceivePanel";
import AppUxV3 from "./ux-v3/AppUxV3";
import "./styles.css";
import "./styles-notify.css";

const TABS: Tab[] = ["send", "receive", "rooms", "contacts", "identity", "history", "advanced"];

function isMagicHash(hash: string): boolean {
  return hash.startsWith("#") && hash.includes(":");
}

export default function App() {
  const { setTab, setNet } = useStore();
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

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

    const tabMatch = window.location.hash.match(/tab=([a-z]+)/i);
    if (tabMatch && TABS.includes(tabMatch[1] as Tab)) {
      setTab(tabMatch[1] as Tab);
    }

    return () => {
      alive = false;
      unlisten();
    };
  }, [setNet, setTab]);

  if (isMagicHash(hash)) {
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
    <>
      <AppUxV3 />
      <ToastStack />
    </>
  );
}
