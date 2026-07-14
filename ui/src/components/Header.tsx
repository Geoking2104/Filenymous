import { useStore } from "../store/useStore";
import type { Tab } from "../store/useStore";

interface HeaderProps {
  minimal?: boolean;
}

const tabs: Array<{ id: Tab; label: string; icon: string }> = [
  { id: "send", label: "Send", icon: "up" },
  { id: "receive", label: "Receive", icon: "down" },
  { id: "rooms", label: "Rooms", icon: "room" },
  { id: "contacts", label: "Contacts", icon: "contacts" },
  { id: "identity", label: "Identity", icon: "id" },
  { id: "history", label: "History", icon: "list" },
  { id: "advanced", label: "Advanced", icon: "gear" },
];

function modeLabel(mode: string): string {
  if (mode === "holo-web") return "Web conductor";
  if (mode === "websocket") return "Local conductor";
  if (mode === "web-bridge") return "Bridge";
  if (mode === "local-only") return "Browser";
  return "Checking";
}

export default function Header({ minimal = false }: HeaderProps) {
  const { tab, setTab, net } = useStore();

  return (
    <header className="site-header">
      <div className="header-inner">
        <button className="brand" type="button" onClick={() => setTab("send")} aria-label="Open Send">
          <span className="brand-mark"><svg width="34" height="34" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><ellipse cx="14.5" cy="17" rx="5.2" ry="4.2" transform="rotate(-8 14.5 17)" fill="white"/><circle cx="21" cy="12.8" r="3.4" fill="white"/><path d="M24 12.5 L27.5 13.8 L24 14.8 Z" fill="#f59e0b"/><circle cx="22.3" cy="12.2" r="1.1" fill="#0f172a"/><circle cx="22.6" cy="11.9" r="0.35" fill="white"/><path d="M9 14 Q6 8 11 7.5 Q15 9 14 14" fill="#22d3ee"/><path d="M9.5 14.5 Q7 10 11 9.5" stroke="white" strokeWidth="1.6" strokeLinecap="round"/><rect x="11.5" y="17.5" width="3.2" height="2.8" rx="0.6" fill="#bae6fd"/><path d="M12 17.5 L12 16.8 Q13.1 16.3 14.5 16.8 L14.5 17.5" fill="none" stroke="#22d3ee" strokeWidth="0.8"/><path d="M9 19.5 L5 21.5 L6 23 L9.5 21.8 Z" fill="white"/></svg></span>
          <span>
            <strong>Filenymous</strong>
            <small>Private file sharing</small>
          </span>
        </button>
        <span className={`net-pill ${net.connected ? "is-online" : ""}`}>
          <span aria-hidden="true" />
          {modeLabel(net.mode)}
        </span>
      </div>

      {!minimal && (
        <nav className="top-tabs" aria-label="Main navigation">
          {tabs.map(({ id, label, icon }) => (
            <button
              key={id}
              type="button"
              className={tab === id ? "active" : ""}
              onClick={() => setTab(id)}
              aria-current={tab === id ? "page" : undefined}
            >
              <span className="tab-icon" data-icon={icon} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      )}
    </header>
  );
}
