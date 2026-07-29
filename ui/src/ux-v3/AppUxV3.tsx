/**
 * Filenymous UX v3 — shell unifié
 *
 * Intégration dans ui/src :
 *   1. Copier ce dossier vers ui/src/ux-v3/
 *   2. Dans App.tsx (ou main) :
 *        import AppUxV3 from "./ux-v3/AppUxV3";
 *        export default function App() { return <AppUxV3 />; }
 *   3. Brancher onShare / onEnterRoom / drawers sur vos panels existants
 */

import { useEffect, useState } from "react";
import TopBar from "./components/TopBar";
import ModeSwitcher from "./components/ModeSwitcher";
import SendWorkspace from "./components/SendWorkspace";
import ReceiveWorkspace from "./components/ReceiveWorkspace";
import RoomEntry from "./components/RoomEntry";
import BottomDock from "./components/BottomDock";
import SecondaryDrawer from "./components/SecondaryDrawer";
import EnterprisePrivacySection from "./components/EnterprisePrivacySection";
import type { DrawerId, PrimaryMode, RoomKind } from "./types";
import "./styles/ux-v3.css";

export default function AppUxV3() {
  const [mode, setMode] = useState<PrimaryMode>("send");
  const [drawer, setDrawer] = useState<DrawerId>(null);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawer(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  const hero =
    mode === "send"
      ? {
          title: (
            <>
              Envoyez un fichier.
              <br />
              <span>Privé. Instantané.</span>
            </>
          ),
          subtitle: "Pas de cloud. Pas de compte. Un lien, un code, ou un salon — le reste est transparent.",
        }
      : mode === "receive"
        ? {
            title: (
              <>
                Recevez un fichier.
                <br />
                <span>Code ou lien.</span>
              </>
            ),
            subtitle: "Collez ce que l’on vous a envoyé. Le déchiffrement reste dans votre navigateur.",
          }
        : {
            title: (
              <>
                Ouvrez un salon.
                <br />
                <span>Partage live.</span>
              </>
            ),
            subtitle: "Bibliothèque visible entre pairs, privée ou publique — sans plugin.",
          };

  return (
    <div className="v3-app">
      <TopBar
        statusLabel="Prêt"
        online
        onBrandClick={() => setMode("send")}
        onNotifyClick={() => {
          /* brancher NotificationCenter */
        }}
      />

      <main className="v3-shell">
        <div className="v3-hero">
          <h1>{hero.title}</h1>
          <p>{hero.subtitle}</p>
        </div>

        <ModeSwitcher mode={mode} onChange={setMode} />

        <section className="v3-workspace" key={mode}>
          {mode === "send" && (
            <SendWorkspace
              onShare={async (files, path) => {
                // TODO: brancher SendPanel / Magic Link / X25519
                console.info("[ux-v3] share", { count: files.length, path });
                return {
                  code: "K7·M2·PX",
                  link: "https://filenymous.eu/#K7M2PX:…",
                  createdAt: Date.now(),
                };
              }}
            />
          )}
          {mode === "receive" && (
            <ReceiveWorkspace
              onOpen={(payload) => {
                // TODO: brancher ReceivePanel
                console.info("[ux-v3] receive", payload);
              }}
            />
          )}
          {mode === "room" && (
            <RoomEntry
              onEnter={(kind: RoomKind) => {
                // TODO: brancher RoomPanel ensureRoom(kind) + phase inside
                console.info("[ux-v3] enter room", kind);
              }}
            />
          )}
        </section>

        <a className="v3-enterprise-link" href="#confidentialite-entreprises">
          <span>Pour les entreprises</span>
          <strong>Confidentialité, RGPD et échange souverain</strong>
          <small>Comprendre l’exposition au CLOUD Act et découvrir les cas d’usage →</small>
        </a>

        <EnterprisePrivacySection />
      </main>

      <BottomDock active={drawer} onOpen={setDrawer} />
      <SecondaryDrawer open={drawer} onClose={() => setDrawer(null)} />
    </div>
  );
}
