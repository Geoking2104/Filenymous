/** Messages between the background, the share host (offscreen/background page) and the popup. */

/** BroadcastChannel shared by every extension page (same origin): carries File objects too. */
export const HOST_CHANNEL = "filenymous-host";

export interface FileShareOptions {
  password?: string;
  /** How long the link works (minutes). The expiry is bound into the link. */
  ttlMinutes: number;
  /** Stop after this many completed downloads. */
  maxDownloads: number;
  /** Let web recipients play audio/video while it downloads. */
  stream?: boolean;
}

export interface TextShareOptions {
  password?: string;
  /** "once" = burn after reading (kept 7 days max), "ttl" = readable until expiry. */
  mode: "once" | "ttl";
  hours?: number;
}

export type ShareSource = "menu" | "popup";
export type TargetKind = "image" | "media" | "link";

export type HostRequest =
  | { type: "ping" }
  | { type: "list" }
  | { type: "share-text"; text: string; opts?: TextShareOptions; source: ShareSource }
  | { type: "share-files"; files: File[]; opts: FileShareOptions; source: ShareSource }
  | { type: "share-url"; url: string; kind: TargetKind; source: ShareSource }
  | { type: "stop"; id: string }
  | { type: "clear" };

export type HostReply =
  | { ok: true; link?: string; share?: ShareSummary; copied?: boolean }
  | { ok: false; error: string; message: string; origin?: string };

export type ShareStatus =
  | "starting"
  | "waiting"
  | "connecting"
  | "transferring"
  | "reconnecting"
  | "delivered"
  | "complete"
  | "expired"
  | "locked"
  | "stopped"
  | "error"
  | "streaming"
  | "secret";

export interface ShareSummary {
  id: string;
  kind: "p2p" | "secret";
  link: string;
  names: string[];
  totalBytes: number;
  confirmedBytes: number;
  status: ShareStatus;
  downloads: number;
  maxDownloads: number;
  /** ms epoch */
  expiresAt: number;
  createdAt: number;
  protected: boolean;
  ended: boolean;
  peerDevice?: string;
  error?: string;
  /** secret: burn after reading */
  once?: boolean;
}

export type ChannelMessage =
  | { kind: "req"; id: string; req: HostRequest }
  | { kind: "res"; id: string; res: HostReply }
  | { kind: "state"; shares: ShareSummary[] };

/** Host → background (Chrome: runtime message from the offscreen document). */
export type BgEvent =
  | { type: "notify"; title: string; message: string }
  | { type: "badge"; text: string; color: string }
  | { type: "need-permission"; origin: string; url: string; kind: TargetKind }
  | { type: "idle" };

/** Popup / grant page → background. */
export type BgRequest =
  | { target: "bg"; type: "ensure-host" }
  | { target: "bg"; type: "share-url"; url: string; kind: TargetKind }
  | ({ target: "bg"; type: "event" } & { event: BgEvent });
