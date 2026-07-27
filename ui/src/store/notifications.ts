import { create } from "zustand";

export type NotifyKind = "info" | "success" | "warn" | "error" | "room" | "transfer";

export interface AppNotification {
  id: string;
  kind: NotifyKind;
  title: string;
  body?: string;
  createdAt: number;
  read: boolean;
  /** Auto-dismiss toast after ms (0 = sticky toast until manual close) */
  ttlMs: number;
  /** Optional deep-link tab */
  tab?: "send" | "receive" | "rooms" | "contacts" | "identity" | "history" | "advanced";
}

interface NotifyState {
  items: AppNotification[];
  toasts: AppNotification[];
  panelOpen: boolean;
  browserPermission: NotificationPermission | "unsupported";

  push(input: {
    kind?: NotifyKind;
    title: string;
    body?: string;
    ttlMs?: number;
    tab?: AppNotification["tab"];
    /** Also fire OS/browser notification if allowed */
    system?: boolean;
  }): string;
  markRead(id: string): void;
  markAllRead(): void;
  dismissToast(id: string): void;
  clearAll(): void;
  setPanelOpen(open: boolean): void;
  setBrowserPermission(p: NotifyState["browserPermission"]): void;
  unreadCount(): number;
}

function nid() {
  return `n-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useNotifications = create<NotifyState>((set, get) => ({
  items: [],
  toasts: [],
  panelOpen: false,
  browserPermission:
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,

  push: ({ kind = "info", title, body, ttlMs = 5200, tab, system = false }) => {
    const id = nid();
    const item: AppNotification = {
      id,
      kind,
      title,
      body,
      createdAt: Date.now(),
      read: false,
      ttlMs,
      tab,
    };

    set((s) => ({
      items: [item, ...s.items].slice(0, 80),
      toasts: [item, ...s.toasts].slice(0, 5),
    }));

    if (ttlMs > 0) {
      window.setTimeout(() => {
        get().dismissToast(id);
      }, ttlMs);
    }

    if (system && typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        const n = new Notification(title, {
          body: body ?? "",
          icon: "/Filenymous/icons/icon-192.png",
          tag: id,
          silent: false,
        });
        n.onclick = () => {
          window.focus();
          n.close();
        };
      } catch {
        /* ignore */
      }
    }

    return id;
  },

  markRead: (id) =>
    set((s) => ({
      items: s.items.map((n) => (n.id === id ? { ...n, read: true } : n)),
    })),

  markAllRead: () =>
    set((s) => ({
      items: s.items.map((n) => ({ ...n, read: true })),
    })),

  dismissToast: (id) =>
    set((s) => ({
      toasts: s.toasts.filter((n) => n.id !== id),
    })),

  clearAll: () => set({ items: [], toasts: [] }),

  setPanelOpen: (panelOpen) => set({ panelOpen }),

  setBrowserPermission: (browserPermission) => set({ browserPermission }),

  unreadCount: () => get().items.filter((n) => !n.read).length,
}));

/** Convenience helpers used across the app */
export const notify = {
  info: (title: string, body?: string, tab?: AppNotification["tab"]) =>
    useNotifications.getState().push({ kind: "info", title, body, tab }),
  success: (title: string, body?: string, tab?: AppNotification["tab"]) =>
    useNotifications.getState().push({ kind: "success", title, body, tab }),
  warn: (title: string, body?: string, tab?: AppNotification["tab"]) =>
    useNotifications.getState().push({ kind: "warn", title, body, tab }),
  error: (title: string, body?: string, tab?: AppNotification["tab"]) =>
    useNotifications.getState().push({ kind: "error", title, body, tab, ttlMs: 8000 }),
  room: (title: string, body?: string) =>
    useNotifications.getState().push({ kind: "room", title, body, tab: "rooms", system: true }),
  transfer: (title: string, body?: string) =>
    useNotifications
      .getState()
      .push({ kind: "transfer", title, body, tab: "receive", system: true, ttlMs: 8000 }),
};
