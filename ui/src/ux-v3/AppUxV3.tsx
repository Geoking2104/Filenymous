/**
 * Filenymous UX v3 — unified shell (i18n)
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import TopBar from "./components/TopBar";
import ModeSwitcher from "./components/ModeSwitcher";
import SendWorkspace from "./components/SendWorkspace";
import ReceiveWorkspace from "./components/ReceiveWorkspace";
import RoomEntry from "./components/RoomEntry";
import BottomDock from "./components/BottomDock";
import SecondaryDrawer from "./components/SecondaryDrawer";
import type { DrawerId, PrimaryMode, RoomKind } from "./types";
import "./styles/ux-v3.css";

export default function AppUxV3() {
  const { t } = useTranslation();
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
              {t("ux.heroSendTitle")}
              <br />
              <span>{t("ux.heroSendHighlight")}</span>
            </>
          ),
          subtitle: t("ux.heroSendSubtitle"),
        }
      : mode === "receive"
        ? {
            title: (
              <>
                {t("ux.heroReceiveTitle")}
                <br />
                <span>{t("ux.heroReceiveHighlight")}</span>
              </>
            ),
            subtitle: t("ux.heroReceiveSubtitle"),
          }
        : {
            title: (
              <>
                {t("ux.heroRoomTitle")}
                <br />
                <span>{t("ux.heroRoomHighlight")}</span>
              </>
            ),
            subtitle: t("ux.heroRoomSubtitle"),
          };

  return (
    <div className="v3-app">
      <TopBar
        statusLabel={t("ux.statusReady")}
        online
        onBrandClick={() => setMode("send")}
        onNotifyClick={() => {
          /* wire NotificationCenter */
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
                console.info("[ux-v3] receive", payload);
              }}
            />
          )}
          {mode === "room" && (
            <RoomEntry
              onEnter={(kind: RoomKind) => {
                console.info("[ux-v3] enter room", kind);
              }}
            />
          )}
        </section>
      </main>

      <BottomDock active={drawer} onOpen={setDrawer} />
      <SecondaryDrawer open={drawer} onClose={() => setDrawer(null)} />
    </div>
  );
}
