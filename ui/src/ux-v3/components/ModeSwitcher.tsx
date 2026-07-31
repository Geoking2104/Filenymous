import { useTranslation } from "react-i18next";
import type { PrimaryMode } from "../types";

interface Props {
  mode: PrimaryMode;
  onChange: (mode: PrimaryMode) => void;
}

export default function ModeSwitcher({ mode, onChange }: Props) {
  const { t } = useTranslation();

  const modes: Array<{ id: PrimaryMode; icon: string; label: string }> = [
    { id: "send", icon: "↑", label: t("ux.modeSend") },
    { id: "receive", icon: "↓", label: t("ux.modeReceive") },
    { id: "room", icon: "◎", label: t("ux.modeRoom") },
  ];

  return (
    <nav className="v3-modes" role="tablist" aria-label={t("ux.modesAria")}>
      {modes.map((m) => (
        <button
          key={m.id}
          type="button"
          role="tab"
          aria-selected={mode === m.id}
          className={`v3-mode${mode === m.id ? " active" : ""}`}
          onClick={() => onChange(m.id)}
        >
          <span className="v3-mode-ico" aria-hidden="true">
            {m.icon}
          </span>
          <span>{m.label}</span>
        </button>
      ))}
    </nav>
  );
}
