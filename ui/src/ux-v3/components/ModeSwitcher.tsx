import type { PrimaryMode } from "../types";

const MODES: Array<{ id: PrimaryMode; icon: string; label: string }> = [
  { id: "send", icon: "↑", label: "Envoyer" },
  { id: "receive", icon: "↓", label: "Recevoir" },
  { id: "room", icon: "◎", label: "Salon" },
];

interface Props {
  mode: PrimaryMode;
  onChange: (mode: PrimaryMode) => void;
}

export default function ModeSwitcher({ mode, onChange }: Props) {
  return (
    <nav className="v3-modes" role="tablist" aria-label="Actions principales">
      {MODES.map((m) => (
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
