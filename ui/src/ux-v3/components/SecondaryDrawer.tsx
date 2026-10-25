import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { useModal } from "../../home/useModal";
import type { DrawerId } from "../types";
import ContactsPanel from "../../components/ContactsPanel";
import IdentityPanel from "../../components/IdentityPanel";
import HistoryPanel from "../../components/HistoryPanel";
import PrivacyPanel from "../../components/PrivacyPanel";
import WalletPanel from "../../components/WalletPanel";

interface Props {
  open: DrawerId;
  onClose: () => void;
}

export default function SecondaryDrawer({ open, onClose }: Props) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  useModal(box, onClose, { open: !!open });
  if (!open) return null;

  return (
    <>
      <button
        type="button"
        className="v3-drawer-backdrop"
        aria-label={t("ux.drawerClose")}
        onClick={onClose}
      />
      <div ref={box} className="v3-drawer-panel" role="dialog" aria-modal="true" aria-label={t("ux.drawerClose")}>
        <div className="v3-drawer-handle" />
        <div className="v3-legacy-panel">
          {open === "contacts" && <ContactsPanel />}
          {open === "identity" && <IdentityPanel />}
          {open === "history" && <HistoryPanel />}
          {open === "more" && (
            <>
              <PrivacyPanel />
              <div style={{ height: "1rem" }} />
              <WalletPanel />
            </>
          )}
        </div>
      </div>
    </>
  );
}
