import { platform } from "node:os";

/** Replaces ui/src/p2p/device.ts in the CLI bundle: shown to the peer as "Filenymous CLI · Linux". */
export function describeDevice(): string {
  const os = ({ linux: "Linux", darwin: "macOS", win32: "Windows" } as Record<string, string>)[platform()] ?? platform();
  return `Filenymous CLI · ${os}`;
}
export function parseUserAgent(): string {
  return describeDevice();
}
