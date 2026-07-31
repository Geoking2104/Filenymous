import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { RoomKind } from "../types";

interface Props {
  onEnter?: (kind: RoomKind) => void;
}

export default function RoomEntry({ onEnter }: Props) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<RoomKind>("private");

  return (
    <div>
      <div className="v3-step">{t("ux.roomStep")}</div>
      <p className="v3-muted">{t("ux.roomHint")}</p>
      <div className="v3-room-types">
        <button
          type="button"
          className={`v3-room-type${kind === "private" ? " active" : ""}`}
          onClick={() => setKind("private")}
        >
          <span aria-hidden="true">🔒</span>
          <strong>{t("ux.roomPrivateTitle")}</strong>
          <span>{t("ux.roomPrivateDesc")}</span>
        </button>
        <button
          type="button"
          className={`v3-room-type${kind === "public" ? " active" : ""}`}
          onClick={() => setKind("public")}
        >
          <span aria-hidden="true">🌐</span>
          <strong>{t("ux.roomPublicTitle")}</strong>
          <span>{t("ux.roomPublicDesc")}</span>
        </button>
      </div>
      <button type="button" className="v3-btn-primary" onClick={() => onEnter?.(kind)}>
        {t("ux.roomEnter")}
      </button>
      <div className="v3-status">
        <span className="v3-pulse" />
        {t("ux.roomStatus")}
      </div>
    </div>
  );
}
