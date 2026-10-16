/* Filenymous Service Worker — push + local showNotification bridge */
/* eslint-disable no-restricted-globals */

const SW_VERSION = "filenymous-sw-v2";
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

  if (msg.type === "FY_STREAM_REGISTER" && msg.id && event.ports && event.ports[0]) {
    registerStream(msg, event.ports[0]);
    return;
  }
  if (msg.type === "FY_STREAM_CLOSE") {
    const s = streams.get(msg.id);
    if (s) {
      for (const p of s.pending.values()) p.reject(new Error("closed"));
      streams.delete(msg.id);
    }
    return;
  }
  if (msg.type === "FY_STREAM_PING") return; // keep-alive only

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

/* ── Partage streamé ─────────────────────────────────────────────────────────
 * The page registers a P2P file (id, size, mime) with a MessagePort. Media
 * elements then load /…/__fy_stream/<id>/<name> with normal HTTP Range
 * requests; each window is fetched from the page, which pulls the encrypted
 * chunks from the sender over WebRTC and decrypts them. Nothing is cached. */
const streams = new Map();
const STREAM_WINDOW = 256 * 1024;

function registerStream(msg, port) {
  const s = { size: Number(msg.size) || 0, mime: String(msg.mime || "application/octet-stream"), port, pending: new Map(), seq: 0 };
  port.onmessage = (ev) => {
    const d = ev.data || {};
    const p = s.pending.get(d.req);
    if (!p) return;
    s.pending.delete(d.req);
    if (d.error) p.reject(new Error(d.error));
    else p.resolve(new Uint8Array(d.bytes));
  };
  streams.set(String(msg.id), s);
}

function askRange(s, start, end) {
  return new Promise((resolve, reject) => {
    const req = ++s.seq;
    s.pending.set(req, { resolve, reject });
    s.port.postMessage({ req, start, end });
  });
}

function parseRangeHeader(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2])) return null;
  let start;
  let end;
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start > end || start >= size) return null;
  return { start, end, partial: true };
}

function streamResponse(request, id) {
  const s = streams.get(id);
  if (!s) return new Response("stream not found", { status: 404 });
  const r = parseRangeHeader(request.headers.get("range"), s.size);
  if (!r) return new Response(null, { status: 416, headers: { "content-range": `bytes */${s.size}` } });
  let pos = r.start;
  const body = new ReadableStream(
    {
      async pull(ctrl) {
        if (pos > r.end) return ctrl.close();
        const to = Math.min(r.end, pos + STREAM_WINDOW - 1);
        try {
          const bytes = await askRange(s, pos, to);
          ctrl.enqueue(bytes);
          pos = to + 1;
          if (pos > r.end) ctrl.close();
        } catch (e) {
          ctrl.error(e);
        }
      },
    },
    { highWaterMark: 0 },
  );
  const headers = {
    "content-type": s.mime,
    "content-length": String(r.end - r.start + 1),
    "accept-ranges": "bytes",
    "cache-control": "no-store",
  };
  if (r.partial) headers["content-range"] = `bytes ${r.start}-${r.end}/${s.size}`;
  return new Response(body, { status: r.partial ? 206 : 200, headers });
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const at = url.pathname.indexOf("/__fy_stream/");
  if (url.origin !== self.location.origin || at < 0) return; // everything else: network as usual
  const id = url.pathname.slice(at + "/__fy_stream/".length).split("/")[0];
  event.respondWith(streamResponse(event.request, id));
});
