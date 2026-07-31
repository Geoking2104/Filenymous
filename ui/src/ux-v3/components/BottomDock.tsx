import { useTranslation } from "react-i18next";
import type { DrawerId } from "../types";

interface Props {
  active: DrawerId;
  onOpen: (id: NonNullable<DrawerId>) => void;
}

export default function BottomDock({ active, onOpen }: Props) {
  const { t } = useTranslation();

  const items: Array<{ id: NonNullable<DrawerId>; icon: string; label: string }> = [
    { id: "contacts", icon: "👥", label: t("ux.dockContacts") },
    { id: "identity", icon: "🔑", label: t("ux.dockIdentity") },
    { id: "history", icon: "📋", label: t("ux.dockHistory") },
    { id: "more", icon: "⋯", label: t("ux.dockMore") },
  ];

  return (
    <nav className="v3-dock" aria-label={t("ux.dockAria")}>
      <div className="v3-dock-inner">
        {items.map((item) => (
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
