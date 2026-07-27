/**
 * Sync PushSubscription with Filenymous push-server.
 */

const PUSH_API =
  (import.meta as ImportMeta & { env: Record<string, string> }).env?.VITE_PUSH_API_URL || "";

export function pushApiConfigured(): boolean {
  return Boolean(PUSH_API);
}

export async function registerSubscriptionOnServer(
  subscription: PushSubscription,
  opts?: { userId?: string; topics?: string[] },
): Promise<boolean> {
  if (!PUSH_API) return false;
  try {
    const res = await fetch(`${PUSH_API.replace(/\/$/, "")}/api/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subscription: subscription.toJSON(),
        userId: opts?.userId || localStorage.getItem("filenymous:my_contact_hash") || "anonymous",
        topics: opts?.topics || ["transfers", "rooms"],
      }),
    });
    return res.ok;
  } catch (e) {
    console.warn("[Filenymous] push subscribe API failed:", e);
    return false;
  }
}

export async function unregisterSubscriptionOnServer(endpoint: string): Promise<boolean> {
  if (!PUSH_API) return false;
  try {
    const res = await fetch(`${PUSH_API.replace(/\/$/, "")}/api/push/unsubscribe`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Optional: fetch public key from server if not baked into Vite env */
export async function fetchVapidPublicKey(): Promise<string | null> {
  if (!PUSH_API) return null;
  try {
    const res = await fetch(`${PUSH_API.replace(/\/$/, "")}/api/push/vapid-public-key`);
    if (!res.ok) return null;
    const data = (await res.json()) as { publicKey?: string };
    return data.publicKey || null;
  } catch {
    return null;
  }
}
