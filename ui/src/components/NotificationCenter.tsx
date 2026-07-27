import { useEffect, useState } from "react";
import {
  useNotifications,
  type AppNotification,
  type NotifyKind,
} from "../store/notifications";
import { useStore } from "../store/useStore";
import { subscribeWebPush, getPushSubscription } from "../pwa/registerSW";

const KIND_ICON: Record<NotifyKind, string> = {
  info: "ℹ",
  success: "✓",
  warn: "⚠",
  error: "✕",
  room: "◎",
  transfer: "⬇",
};

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "à l’instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return new Date(ts).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Row({ n }: { n: AppNotification }) {
  const markRead = useNotifications((s) => s.markRead);
  const setPanelOpen = useNotifications((s) => s.setPanelOpen);
  const setTab = useStore((s) => s.setTab);

  return (
    <button
      type="button"
      className={`notify-row ${n.read ? "is-read" : ""}`}
      onClick={() => {
        markRead(n.id);
        if (n.tab) setTab(n.tab);
        setPanelOpen(false);
      }}
    >
      <span className={`notify-dot kind-${n.kind}`}>{KIND_ICON[n.kind]}</span>
      <span className="notify-row-text">
        <strong>{n.title}</strong>
        {n.body && <small>{n.body}</small>}
        <em>{timeAgo(n.createdAt)}</em>
      </span>
    </button>
  );
}

export default function NotificationCenter() {
  const items = useNotifications((s) => s.items);
  const panelOpen = useNotifications((s) => s.panelOpen);
  const setPanelOpen = useNotifications((s) => s.setPanelOpen);
  const markAllRead = useNotifications((s) => s.markAllRead);
  const clearAll = useNotifications((s) => s.clearAll);
  const unread = useNotifications((s) => s.items.filter((n) => !n.read).length);
  const browserPermission = useNotifications((s) => s.browserPermission);
  const setBrowserPermission = useNotifications((s) => s.setBrowserPermission);
  const setPushEnabled = useNotifications((s) => s.setPushEnabled);
  const pushEnabled = useNotifications((s) => s.pushEnabled);
  const [pushBusy, setPushBusy] = useState(false);
  const hasVapid = Boolean(
    (import.meta as ImportMeta & { env: Record<string, string> }).env?.VITE_VAPID_PUBLIC_KEY,
  );

  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanelOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen, setPanelOpen]);

  useEffect(() => {
    void getPushSubscription().then((sub) => {
      if (sub) setPushEnabled(true);
    });
  }, [setPushEnabled]);

  const requestBrowser = async () => {
    if (typeof Notification === "undefined") return;
    setPushBusy(true);
    try {
      const p = await Notification.requestPermission();
      setBrowserPermission(p);
      if (p === "granted") {
        const sub = await subscribeWebPush();
        setPushEnabled(Boolean(sub) || true);
      }
    } catch {
      setBrowserPermission("denied");
    } finally {
      setPushBusy(false);
    }
  };

  return (
    <div className="notify-wrap">
      <button
        type="button"
        className={`notify-bell ${panelOpen ? "is-open" : ""}`}
        aria-label="Notifications"
        aria-expanded={panelOpen}
        onClick={() => setPanelOpen(!panelOpen)}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 3a5 5 0 0 0-5 5v2.2c0 .7-.3 1.4-.8 1.9L5 13.5c-.6.6-.2 1.5.6 1.5h12.8c.8 0 1.2-.9.6-1.5l-1.2-1.4c-.5-.5-.8-1.2-.8-1.9V8a5 5 0 0 0-5-5z"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
          <path d="M10 18a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
        {unread > 0 && <span className="notify-badge">{unread > 9 ? "9+" : unread}</span>}
      </button>

      {panelOpen && (
        <>
          <button
            type="button"
            className="notify-backdrop"
            aria-label="Fermer"
            onClick={() => setPanelOpen(false)}
          />
          <div className="notify-panel" role="dialog" aria-label="Centre de notifications">
            <div className="notify-panel-head">
              <strong>Notifications</strong>
              <div className="notify-panel-actions">
                <button type="button" className="btn-ghost btn-sm" onClick={markAllRead} disabled={!unread}>
                  Tout lu
                </button>
                <button type="button" className="btn-ghost btn-sm" onClick={clearAll} disabled={!items.length}>
                  Vider
                </button>
              </div>
            </div>

            {browserPermission !== "granted" && browserPermission !== "unsupported" && (
              <div className="notify-enable">
                <span>
                  Activer les notifications système (Service Worker)
                  {hasVapid ? " + push distant" : ""}.
                </span>
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  onClick={requestBrowser}
                  disabled={pushBusy}
                >
                  {pushBusy ? "…" : "Autoriser"}
                </button>
              </div>
            )}

            {browserPermission === "granted" && (
              <div className="notify-enable" style={{ opacity: 0.9 }}>
                <span>
                  {pushEnabled && hasVapid
                    ? "Push Web activé — abonnement enregistré localement."
                    : "Notifications SW actives (onglet en arrière-plan inclus)."}
                </span>
                {hasVapid && !pushEnabled && (
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    onClick={async () => {
                      setPushBusy(true);
                      const sub = await subscribeWebPush();
                      setPushEnabled(Boolean(sub));
                      setPushBusy(false);
                    }}
                    disabled={pushBusy}
                  >
                    Push
                  </button>
                )}
              </div>
            )}

            {items.length === 0 ? (
              <p className="notify-empty">Aucune notification pour le moment.</p>
            ) : (
              <div className="notify-list">
                {items.map((n) => (
                  <Row key={n.id} n={n} />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
