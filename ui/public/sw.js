/* Filenymous Service Worker — push + local showNotification bridge */
/* eslint-disable no-restricted-globals */

const SW_VERSION = "filenymous-sw-v1";
const ICON = "./icons/icon-192.png";
const BADGE = "./icons/icon-96.png";

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(Promise.resolve());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/** Normalize payload from PushEvent or client postMessage */
function normalizePayload(raw) {
  let data = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { title: "Filenymous", body: raw };
    }
  }
  if (!data || typeof data !== "object") {
    data = { title: "Filenymous", body: "Nouvelle notification" };
  }
  return {
    title: data.title || "Filenymous",
    body: data.body || "",
    tag: data.tag || `fn-${Date.now()}`,
    tab: data.tab || "",
    kind: data.kind || "info",
    url: data.url || "./",
    renotify: Boolean(data.renotify),
    requireInteraction: Boolean(data.requireInteraction),
  };
}

async function showFromPayload(payload) {
  const p = normalizePayload(payload);
  const options = {
    body: p.body,
    icon: ICON,
    badge: BADGE,
    tag: p.tag,
    renotify: p.renotify,
    requireInteraction: p.requireInteraction,
    data: { url: p.url, tab: p.tab, kind: p.kind },
    vibrate: p.kind === "transfer" || p.kind === "room" ? [120, 60, 120] : undefined,
  };
  await self.registration.showNotification(p.title, options);
}

/** Web Push from a future push server */
self.addEventListener("push", (event) => {
  let payload = { title: "Filenymous", body: "Mise à jour" };
  try {
    if (event.data) {
      payload = event.data.json();
    }
  } catch {
    try {
      payload = { title: "Filenymous", body: event.data?.text() || "" };
    } catch {
      /* keep default */
    }
  }
  event.waitUntil(showFromPayload(payload));
});

/** Local bridge: page → SW when tab is backgrounded or system flag */
self.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "SHOW_NOTIFICATION") {
    event.waitUntil(showFromPayload(msg.payload || {}));
  }

  if (msg.type === "SKIP_WAITING") {
    self.skipWaiting();
  }

  if (msg.type === "PING") {
    event.source?.postMessage({ type: "PONG", version: SW_VERSION });
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const targetUrl = data.url || "./";
  const tab = data.tab || "";

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) {
        if ("focus" in client) {
          await client.focus();
          client.postMessage({ type: "NOTIFICATION_CLICK", tab, url: targetUrl });
          return;
        }
      }
      if (self.clients.openWindow) {
        const url = tab ? `${targetUrl}#tab=${encodeURIComponent(tab)}` : targetUrl;
        await self.clients.openWindow(url);
      }
    })(),
  );
});

self.addEventListener("pushsubscriptionchange", (event) => {
  // Client will re-subscribe on next visit if VAPID is configured
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window" });
      for (const c of clients) {
        c.postMessage({ type: "PUSH_SUBSCRIPTION_CHANGED" });
      }
    })(),
  );
});
