import { hostCall } from "./rpc";

/** Waits until the host answers on the channel (its module script may still be loading). */
export async function ping(tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const r = await hostCall({ type: "ping" }, 250);
    if (r.ok) return;
  }
  throw new Error("host-unavailable");
}
