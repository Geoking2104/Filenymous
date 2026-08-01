/**
 * Filenymous UX v3 — unified shell (i18n + real panel hooks)
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
import RoomPanel from "../components/RoomPanel";
import type { DrawerId, PrimaryMode, RoomKind } from "./types";
import "./styles/ux-v3.css";

export default function AppUxV3() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<PrimaryMode>("send");
  const [drawer, setDrawer] = useState<DrawerId>(null);
  const [roomActive, setRoomActive] = useState(false);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawer(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  useEffect(() => {
    if (mode !== "room") setRoomActive(false);
  }, [mode]);

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

  const openMagicLink = (payload: string) => {
    let value = payload.trim();
    if (!value) return;
    if (value.includes("#")) value = value.split("#").pop() || value;
    if (value.startsWith("#")) value = value.slice(1);
    window.location.hash = value;
  };

  return (
    <div className="v3-app">
      <TopBar
        statusLabel={t("ux.statusReady")}
        online
        onBrandClick={() => {
          setMode("send");
          setRoomActive(false);
        }}
      />

      <main className="v3-shell">
        {!(mode === "room" && roomActive) && (
          <div className="v3-hero">
            <h1>{hero.title}</h1>
            <p>{hero.subtitle}</p>
          </div>
        )}

        <ModeSwitcher mode={mode} onChange={setMode} />

        <section className="v3-workspace" key={mode + String(roomActive)}>
          {mode === "send" && <SendWorkspace />}
          {mode === "receive" && <ReceiveWorkspace onOpen={openMagicLink} />}
          {mode === "room" && !roomActive && (
            <RoomEntry onEnter={(_kind: RoomKind) => setRoomActive(true)} />
          )}
          {mode === "room" && roomActive && (
            <div className="v3-legacy-panel">
              <RoomPanel />
            </div>
          )}
        </section>
      </main>

      <BottomDock active={drawer} onOpen={setDrawer} />
      <SecondaryDrawer open={drawer} onClose={() => setDrawer(null)} />
    </div>
  );
}
