import { useNotifications, type AppNotification, type NotifyKind } from "../store/notifications";
import { useStore } from "../store/useStore";

const KIND_ICON: Record<NotifyKind, string> = {
  info: "ℹ",
  success: "✓",
  warn: "⚠",
  error: "✕",
  room: "◎",
  transfer: "⬇",
};

function ToastCard({ n }: { n: AppNotification }) {
  const dismissToast = useNotifications((s) => s.dismissToast);
  const markRead = useNotifications((s) => s.markRead);
  const setTab = useStore((s) => s.setTab);

  return (
    <div
      className={`toast toast-${n.kind}`}
      role="status"
      onClick={() => {
        markRead(n.id);
        if (n.tab) setTab(n.tab);
        dismissToast(n.id);
      }}
    >
      <span className="toast-icon" aria-hidden="true">
        {KIND_ICON[n.kind]}
      </span>
      <div className="toast-body">
        <strong>{n.title}</strong>
        {n.body && <span>{n.body}</span>}
      </div>
      <button
        type="button"
        className="toast-close"
        aria-label="Fermer"
        onClick={(e) => {
          e.stopPropagation();
          dismissToast(n.id);
        }}
      >
        ×
      </button>
    </div>
  );
}

export default function ToastStack() {
  const toasts = useNotifications((s) => s.toasts);

  if (!toasts.length) return null;

  return (
    <div className="toast-stack" aria-live="polite" aria-relevant="additions">
      {toasts.map((n) => (
        <ToastCard key={n.id} n={n} />
      ))}
    </div>
  );
}
