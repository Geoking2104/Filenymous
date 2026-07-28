import type { DrawerId } from "../types";

interface Props {
  open: DrawerId;
  onClose: () => void;
}

function ContactsBody() {
  return (
    <>
      <h2>Contacts</h2>
      <p className="v3-muted">Carnet local. Ajoutez un code d’identité pour envoyer chiffré.</p>
      <div className="v3-list">
        <div className="v3-list-item">
          <div className="v3-av">A</div>
          <div className="v3-list-tx">
            <strong>alice@proton.me</strong>
            <small>Clé prête</small>
          </div>
        </div>
        <div className="v3-list-item">
          <div className="v3-av">B</div>
          <div className="v3-list-tx">
            <strong>+33 6 12 34 56 78</strong>
            <small>Pas encore de clé</small>
          </div>
        </div>
      </div>
      <button type="button" className="v3-btn-ghost" style={{ marginTop: "1rem" }}>
        + Ajouter un contact
      </button>
    </>
  );
}

function IdentityBody() {
  return (
    <>
      <h2>Identité</h2>
      <p className="v3-muted">Clé X25519 générée localement. Ne quitte jamais votre appareil.</p>
      <div className="v3-list-item">
        <div className="v3-av">🔑</div>
        <div className="v3-list-tx">
          <strong>fn_x25519_7a3c…</strong>
          <small>Publique · partageable</small>
        </div>
      </div>
      <button type="button" className="v3-btn-ghost" style={{ marginTop: "1rem" }}>
        Exporter / importer
      </button>
    </>
  );
}

function HistoryBody() {
  return (
    <>
      <h2>Historique</h2>
      <p className="v3-muted">Stocké localement dans ce navigateur.</p>
      <div className="v3-list">
        <div className="v3-list-item">
          <div className="v3-av">📄</div>
          <div className="v3-list-tx">
            <strong>rapport.pdf</strong>
            <small>Envoyé · il y a 2 h</small>
          </div>
        </div>
        <div className="v3-list-item">
          <div className="v3-av">🖼</div>
          <div className="v3-list-tx">
            <strong>photo.jpg</strong>
            <small>Reçu · hier</small>
          </div>
        </div>
      </div>
    </>
  );
}

function MoreBody() {
  return (
    <>
      <h2>Plus</h2>
      <p className="v3-muted">Réglages avancés, confidentialité, réseau, wallet.</p>
      <div className="v3-list">
        <div className="v3-list-item">
          <div className="v3-av">🛡</div>
          <div className="v3-list-tx">
            <strong>Confidentialité</strong>
            <small>Rétention, auto-purge</small>
          </div>
        </div>
        <div className="v3-list-item">
          <div className="v3-av">⚙</div>
          <div className="v3-list-tx">
            <strong>Réseau</strong>
            <small>Holochain / bridge</small>
          </div>
        </div>
        <div className="v3-list-item">
          <div className="v3-av">💳</div>
          <div className="v3-list-tx">
            <strong>Wallet</strong>
            <small>Optionnel</small>
          </div>
        </div>
      </div>
    </>
  );
}

export default function SecondaryDrawer({ open, onClose }: Props) {
  if (!open) return null;

  return (
    <>
      <button
        type="button"
        className="v3-drawer-backdrop"
        aria-label="Fermer"
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
