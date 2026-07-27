/**
 * Register Filenymous Service Worker and optional Web Push subscription.
 */

function swScriptUrl(): string {
  const base = import.meta.env.BASE_URL || "/";
  const normalized = base.endsWith("/") ? base : `${base}/`;
  return `${normalized}sw.js`;
}

export type SwStatus = "unsupported" | "registering" | "ready" | "error";

let registration: ServiceWorkerRegistration | null = null;

export function getSWRegistration(): ServiceWorkerRegistration | null {
  return registration;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }

  try {
    const reg = await navigator.serviceWorker.register(swScriptUrl(), {
      scope: import.meta.env.BASE_URL || "/",
      updateViaCache: "none",
    });
    registration = reg;

    reg.addEventListener("updatefound", () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) {
          worker.postMessage({ type: "SKIP_WAITING" });
        }
      });
    });

    await navigator.serviceWorker.ready;
    return reg;
  } catch (err) {
    console.warn("[Filenymous] SW registration failed:", err);
    return null;
  }
}

/** Show OS notification via Service Worker (works better when tab is hidden). */
export async function showSWNotification(payload: {
  title: string;
  body?: string;
  tag?: string;
  tab?: string;
  kind?: string;
  requireInteraction?: boolean;
}): Promise<boolean> {
  const reg = registration || (await navigator.serviceWorker?.getRegistration());
  if (!reg) return false;

  try {
    if (reg.active) {
      reg.active.postMessage({
        type: "SHOW_NOTIFICATION",
        payload: {
          title: payload.title,
          body: payload.body ?? "",
          tag: payload.tag,
          tab: payload.tab,
          kind: payload.kind,
          requireInteraction: payload.requireInteraction,
          url: window.location.href.split("#")[0],
        },
      });
      return true;
    }

    if ("showNotification" in reg && Notification.permission === "granted") {
      await reg.showNotification(payload.title, {
        body: payload.body ?? "",
        icon: `${import.meta.env.BASE_URL}icons/icon-192.png`,
        tag: payload.tag,
        data: { tab: payload.tab },
      });
      return true;
    }
  } catch (e) {
    console.warn("[Filenymous] SW notification failed:", e);
  }
  return false;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Subscribe to Web Push if VITE_VAPID_PUBLIC_KEY is set.
 * Stores subscription JSON in localStorage for a future backend.
 */
export async function subscribeWebPush(): Promise<PushSubscription | null> {
  const vapid =
    (import.meta as ImportMeta & { env: Record<string, string> }).env?.VITE_VAPID_PUBLIC_KEY ||
    "";
  if (!vapid) return null;
  if (!("PushManager" in window)) return null;
  if (Notification.permission !== "granted") return null;

  const reg = registration || (await registerServiceWorker());
  if (!reg) return null;

  try {
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid) as BufferSource,
      });
    }
    localStorage.setItem("filenymous:push_subscription", JSON.stringify(sub.toJSON()));
    return sub;
  } catch (e) {
    console.warn("[Filenymous] Push subscribe failed:", e);
    return null;
  }
}

export async function getPushSubscription(): Promise<PushSubscription | null> {
  const reg = registration || (await navigator.serviceWorker?.getRegistration());
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

/** Handle clicks from SW notifications → switch tab */
export function listenSWMessages(onTab?: (tab: string) => void): () => void {
  if (!("serviceWorker" in navigator)) return () => {};

  const handler = (event: MessageEvent) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "NOTIFICATION_CLICK" && data.tab && onTab) {
      onTab(String(data.tab));
    }
    if (data.type === "PUSH_SUBSCRIPTION_CHANGED") {
      void subscribeWebPush();
    }
  };

  navigator.serviceWorker.addEventListener("message", handler);
  return () => navigator.serviceWorker.removeEventListener("message", handler);
}
