import type { DrawerId } from "../types";

const ITEMS: Array<{ id: NonNullable<DrawerId>; icon: string; label: string }> = [
  { id: "contacts", icon: "👥", label: "Contacts" },
  { id: "identity", icon: "🔑", label: "Identité" },
  { id: "history", icon: "📋", label: "Historique" },
  { id: "more", icon: "⋯", label: "Plus" },
];

interface Props {
  active: DrawerId;
  onOpen: (id: NonNullable<DrawerId>) => void;
}

export default function BottomDock({ active, onOpen }: Props) {
  return (
    <nav className="v3-dock" aria-label="Navigation secondaire">
      <div className="v3-dock-inner">
        {ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`v3-dock-btn${active === item.id ? " active" : ""}`}
            onClick={() => onOpen(item.id)}
          >
            <span className="v3-dock-ico" aria-hidden="true">
              {item.icon}
            </span>
            {item.label}
          </button>
        ))}
      </div>
    </nav>
  );
}
