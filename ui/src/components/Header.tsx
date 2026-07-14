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
          <span className="brand-mark">F</span>
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
