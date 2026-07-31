import { useTranslation } from "react-i18next";
import type { DrawerId } from "../types";

interface Props {
  open: DrawerId;
  onClose: () => void;
}

function ContactsBody() {
  const { t } = useTranslation();
  return (
    <>
      <h2>{t("contacts.title")}</h2>
      <p className="v3-muted">{t("ux.contactsSubtitle")}</p>
      <div className="v3-list">
        <div className="v3-list-item">
          <div className="v3-av">A</div>
          <div className="v3-list-tx">
            <strong>alice@proton.me</strong>
            <small>{t("ux.contactsKeyReady")}</small>
          </div>
        </div>
        <div className="v3-list-item">
          <div className="v3-av">B</div>
          <div className="v3-list-tx">
            <strong>+33 6 12 34 56 78</strong>
            <small>{t("ux.contactsNoKey")}</small>
          </div>
        </div>
      </div>
      <button type="button" className="v3-btn-ghost" style={{ marginTop: "1rem" }}>
        {t("ux.contactsAdd")}
      </button>
    </>
  );
}

function IdentityBody() {
  const { t } = useTranslation();
  return (
    <>
      <h2>{t("identity.title")}</h2>
      <p className="v3-muted">{t("ux.identitySubtitle")}</p>
      <div className="v3-list-item">
        <div className="v3-av">🔑</div>
        <div className="v3-list-tx">
          <strong>fn_x25519_7a3c…</strong>
          <small>{t("ux.identityPublic")}</small>
        </div>
      </div>
      <button type="button" className="v3-btn-ghost" style={{ marginTop: "1rem" }}>
        {t("ux.identityExportImport")}
      </button>
    </>
  );
}

function HistoryBody() {
  const { t } = useTranslation();
  return (
    <>
      <h2>{t("history.title")}</h2>
      <p className="v3-muted">{t("ux.historySubtitle")}</p>
      <div className="v3-list">
        <div className="v3-list-item">
          <div className="v3-av">📄</div>
          <div className="v3-list-tx">
            <strong>rapport.pdf</strong>
            <small>{t("ux.historySent")}</small>
          </div>
        </div>
        <div className="v3-list-item">
          <div className="v3-av">🖼</div>
          <div className="v3-list-tx">
            <strong>photo.jpg</strong>
            <small>{t("ux.historyReceived")}</small>
          </div>
        </div>
      </div>
    </>
  );
}

function MoreBody() {
  const { t } = useTranslation();
  return (
    <>
      <h2>{t("ux.dockMore")}</h2>
      <p className="v3-muted">{t("ux.moreSubtitle")}</p>
      <div className="v3-list">
        <div className="v3-list-item">
          <div className="v3-av">🛡</div>
          <div className="v3-list-tx">
            <strong>{t("ux.morePrivacy")}</strong>
            <small>{t("ux.morePrivacyDesc")}</small>
          </div>
        </div>
        <div className="v3-list-item">
          <div className="v3-av">⚙</div>
          <div className="v3-list-tx">
            <strong>{t("ux.moreNetwork")}</strong>
            <small>{t("ux.moreNetworkDesc")}</small>
          </div>
        </div>
        <div className="v3-list-item">
          <div className="v3-av">💳</div>
          <div className="v3-list-tx">
            <strong>{t("ux.moreWallet")}</strong>
            <small>{t("ux.moreWalletDesc")}</small>
          </div>
        </div>
      </div>
    </>
  );
}

export default function SecondaryDrawer({ open, onClose }: Props) {
  const { t } = useTranslation();
  if (!open) return null;

  return (
    <>
      <button
        type="button"
        className="v3-drawer-backdrop"
        aria-label={t("ux.drawerClose")}
        onClick={onClose}
      />
      <div className="v3-drawer-panel" role="dialog" aria-modal="true">
        <div className="v3-drawer-handle" />
        {open === "contacts" && <ContactsBody />}
        {open === "identity" && <IdentityBody />}
        {open === "history" && <HistoryBody />}
        {open === "more" && <MoreBody />}
      </div>
    </>
  );
}
