import { HOST_CHANNEL, type ChannelMessage, type HostReply, type HostRequest, type ShareSummary } from "./messages";

/** Request/response to the share host over BroadcastChannel (File objects are structured-cloned). */
export function hostCall(req: HostRequest, timeoutMs = 120_000): Promise<HostReply> {
  const ch = new BroadcastChannel(HOST_CHANNEL);
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ch.close();
      resolve({ ok: false, error: "no-host", message: "L'extension ne répond pas. Réessayez." });
    }, timeoutMs);
    ch.onmessage = (e: MessageEvent<ChannelMessage>) => {
      const m = e.data;
      if (m?.kind === "res" && m.id === id) {
        clearTimeout(timer);
        ch.close();
        resolve(m.res);
      }
    };
    ch.postMessage({ kind: "req", id, req } satisfies ChannelMessage);
  });
}

export function onHostState(cb: (shares: ShareSummary[]) => void): () => void {
  const ch = new BroadcastChannel(HOST_CHANNEL);
  ch.onmessage = (e: MessageEvent<ChannelMessage>) => {
    if (e.data?.kind === "state") cb(e.data.shares);
  };
  return () => ch.close();
}
