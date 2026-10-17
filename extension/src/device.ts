import { parseUserAgent as parseUa } from "../../ui/src/p2p/device";

/** Replaces ui/src/p2p/device.ts in the extension bundle: "Extension Filenymous · Chrome 140 · Windows". */
export function describeDevice(): string {
  if (typeof navigator === "undefined") return "Extension Filenymous";
  return `Extension Filenymous · ${parseUa(navigator.userAgent || "")}`.slice(0, 80);
}
export const parseUserAgent = parseUa;
