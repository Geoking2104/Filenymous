/**
 * Single source of truth for service identity (icon + title) shared by the
 * home cards and every service screen, so a screen always shows the icon of
 * the card that leads to it. CSS gradients key off `data-service-icon`.
 */
import type { Route } from "./routes";

export type ServiceId = "send" | "receive" | "drop" | "wall" | "safe" | "secret" | "report" | "cli" | "pro" | "stream";

type LineIcon = "send" | "download" | "tray" | "key" | "check";
const LINE_PATHS: Record<LineIcon, JSX.Element> = {
  send: <path d="M12 16V4m0 0L7 9m5-5 5 5M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" />,
  download: <path d="M12 4v11m0 0-4-4m4 4 4-4M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />,
  /** Dropzone: an open tray collecting several items (distinct from the single download arrow). */
  tray: <path d="M4 13h4l1.5 2.5h5L16 13h4M4 13l2.2-6.6A2 2 0 0 1 8.1 5h7.8a2 2 0 0 1 1.9 1.4L20 13M4 13v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5M9 9h6" />,
  key: <path d="M14.5 9.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Zm-1 2.5L20 18.5M17 15.5l2-2M15 13.5l2-2" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
};

export function LineIconSvg({ name }: { name: LineIcon }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {LINE_PATHS[name]}
    </svg>
  );
}

/** Service → glyph (line icon or emoji) and i18n title key. */
export const SERVICES: Record<ServiceId, { glyph: { line: LineIcon } | { emoji: string }; titleKey: string }> = {
  send: { glyph: { line: "send" }, titleKey: "home.send.title" },
  receive: { glyph: { line: "download" }, titleKey: "receive.title" },
  drop: { glyph: { line: "tray" }, titleKey: "home.drop.title" },
  wall: { glyph: { emoji: "🧱" }, titleKey: "home.wall.title" },
  safe: { glyph: { emoji: "🔐" }, titleKey: "home.safe.title" },
  secret: { glyph: { line: "key" }, titleKey: "home.secret.title" },
  report: { glyph: { emoji: "🛡️" }, titleKey: "home.whistle.title" },
  cli: { glyph: { emoji: "🤖" }, titleKey: "home.cli.title" },
  pro: { glyph: { emoji: "💼" }, titleKey: "home.pro.title" },
  stream: { glyph: { emoji: "🎥" }, titleKey: "home.stream.title" },
};

export function ServiceIcon({ service }: { service: ServiceId }) {
  const g = SERVICES[service].glyph;
  return (
    <span className="pz-service-icon" data-service-icon={service} aria-hidden="true">
      {"line" in g ? <LineIconSvg name={g.line} /> : g.emoji}
    </span>
  );
}

/**
 * Which service a screen belongs to. `via` is the card the user clicked when
 * two cards open the same screen (the Pro card opens Dropzone).
 */
export function serviceForScreen(route: Route, ctx: { receiving: boolean; stream: boolean; via?: ServiceId | null }): ServiceId {
  switch (route) {
    case "drop-owner":
      return ctx.via === "pro" ? "pro" : "drop";
    case "drop-contrib":
      return "drop";
    case "wall-host":
    case "wall-peer":
      return "wall";
    case "safe":
      return "safe";
    case "secret-new":
    case "secret-reveal":
      return "secret";
    case "report-new":
    case "report-submit":
    case "report-inbox":
    case "report-follow":
      return "report";
    default:
      // The recipient of a direct link gets its own identity ("Recevoir un fichier"),
      // distinct from both the sender card and the Dropzone collection service.
      return ctx.stream ? "stream" : ctx.receiving ? "receive" : "send";
  }
}
