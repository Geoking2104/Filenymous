/**
 * 💬 button of the shell header, on every app (Document, Sharewall, Coffre-fort,
 * transfers…). Opens the messenger drawer over the current app without
 * unmounting it. The drawer and its crypto are loaded on first open.
 * Also catches "#contact:" invite links and opens the drawer on them.
 */
import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { MESSENGER_CHANGED, isFriendInviteHash } from "./link";
import "./messenger.css";

const MessengerDrawer = lazy(() => import("./MessengerDrawer"));

export type DrawerTab = "friends" | "chats" | "invites" | "profile";

export default function MessengerButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<DrawerTab>("friends");
  const [invite, setInvite] = useState<string | null>(null);
  const [pending, setPending] = useState(0);

  const refresh = useCallback(() => {
    // Only touch IndexedDB if the messenger was used on this device.
    void import("./store")
      .then((s) => s.pendingCount())
      .then(setPending)
      .catch(() => setPending(0));
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener(MESSENGER_CHANGED, refresh);
    return () => window.removeEventListener(MESSENGER_CHANGED, refresh);
  }, [refresh]);

  useEffect(() => {
    // Hash of the app on screen, restored when an invite link is opened over it
    // (so a reply link opened while in Sharewall or Document doesn't close that app).
    let current = isFriendInviteHash(location.hash) ? "" : location.hash;
    const take = () => {
      const h = location.hash;
      if (!isFriendInviteHash(h)) {
        current = h;
        return;
      }
      setInvite(h);
      setTab("invites");
      setOpen(true);
      // The invite stays in memory only; the address bar goes back to the app.
      history.replaceState(null, "", location.pathname + location.search + current);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    };
    take();
    window.addEventListener("hashchange", take);
    return () => window.removeEventListener("hashchange", take);
  }, []);

  return (
    <>
      <button
        type="button"
        className={`fy-msg-btn${open ? " is-open" : ""}`}
        aria-label={pending ? t("msg.buttonPending", { count: pending }) : t("msg.button")}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t("msg.button")}
        data-testid="msg-button"
        onClick={() => {
          setTab(pending ? "invites" : "friends");
          setOpen(true);
        }}
      >
        <span aria-hidden="true">💬</span>
        {pending > 0 && (
          <span className="fy-msg-badge" data-testid="msg-badge">
            {pending > 9 ? "9+" : pending}
          </span>
        )}
      </button>
      {open && (
        <Suspense fallback={<div className="fy-msg-backdrop" data-testid="msg-loading" />}>
          <MessengerDrawer
            initialTab={tab}
            invite={invite}
            onInviteHandled={() => setInvite(null)}
            onClose={() => {
              setOpen(false);
              refresh();
            }}
          />
        </Suspense>
      )}
    </>
  );
}
