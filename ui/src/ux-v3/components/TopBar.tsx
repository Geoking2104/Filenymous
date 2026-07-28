interface Props {
  statusLabel?: string;
  online?: boolean;
  onBrandClick?: () => void;
  onNotifyClick?: () => void;
}

export default function TopBar({
  statusLabel = "Prêt",
  online = true,
  onBrandClick,
  onNotifyClick,
}: Props) {
  return (
    <header className="v3-topbar">
      <button type="button" className="v3-brand" onClick={onBrandClick}>
        <span className="v3-brand-mark" aria-hidden="true">
          🕊
        </span>
        <span>
          <strong>Filenymous</strong>
          <small>Fichiers privés, sans compte</small>
        </span>
      </button>
      <div className="v3-top-actions">
        <span className="v3-pill">
          {online && <span className="v3-pill-dot" aria-hidden="true" />}
          {statusLabel}
        </span>
        <button
          type="button"
          className="v3-icon-btn"
          aria-label="Notifications"
          onClick={onNotifyClick}
        >
          🔔
        </button>
      </div>
    </header>
  );
}
