import { useState } from "react";
import type { RoomKind } from "../types";

interface Props {
  onEnter?: (kind: RoomKind) => void;
}

export default function RoomEntry({ onEnter }: Props) {
  const [kind, setKind] = useState<RoomKind>("private");

  return (
    <div>
      <div className="v3-step">Créer un salon</div>
      <p className="v3-muted">
        Bibliothèque live entre navigateurs. Privé (contacts) ou public (durée limitée).
      </p>
      <div className="v3-room-types">
        <button
          type="button"
          className={`v3-room-type${kind === "private" ? " active" : ""}`}
          onClick={() => setKind("private")}
        >
          <span aria-hidden="true">🔒</span>
          <strong>Privé</strong>
          <span>Contacts + code d’invitation</span>
        </button>
        <button
          type="button"
          className={`v3-room-type${kind === "public" ? " active" : ""}`}
          onClick={() => setKind("public")}
        >
          <span aria-hidden="true">🌐</span>
          <strong>Public</strong>
          <span>Ouvert pour une durée choisie</span>
        </button>
      </div>
      <button type="button" className="v3-btn-primary" onClick={() => onEnter?.(kind)}>
        Entrer dans le salon
      </button>
      <div className="v3-status">
        <span className="v3-pulse" />
        Discovery navigateur · session seule
      </div>
    </div>
  );
}
