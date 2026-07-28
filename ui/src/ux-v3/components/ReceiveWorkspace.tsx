import { useState } from "react";

interface Props {
  onOpen?: (payload: string) => void;
}

export default function ReceiveWorkspace({ onOpen }: Props) {
  const [value, setValue] = useState("");

  const submit = () => {
    const v = value.trim();
    if (!v) return;
    onOpen?.(v);
  };

  return (
    <div>
      <div className="v3-step">Recevoir un fichier</div>
      <p className="v3-muted">
        Collez un lien, un code, ou scannez un QR. Rien d’autre à configurer.
      </p>
      <div className="v3-drop" style={{ minHeight: 120 }}>
        <div className="v3-drop-bird" style={{ fontSize: "1.8rem" }} aria-hidden="true">
          📥
        </div>
        <strong>Coller un lien ou un code</strong>
      </div>
      <div className="v3-receive-row">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Code ou lien (ex. K7M2PX)"
          aria-label="Code ou lien de réception"
        />
        <button
          type="button"
          className="v3-btn-primary"
          style={{ width: "auto", margin: 0, padding: "0.9rem 1.2rem" }}
          onClick={submit}
          disabled={!value.trim()}
        >
          Ouvrir
        </button>
      </div>
      <div className="v3-status" style={{ marginTop: "1.2rem" }}>
        <span className="v3-pulse" />
        Navigateur prêt · déchiffrement local
      </div>
    </div>
  );
}
