/**
 * QR transfer profiles for the optical (screen-to-camera) mode.
 *
 * Profiles determine QR version, ECC level, lane count, frames per second,
 * repair percentage, and render scale. The active profile is selected by
 * the user in the OpticalSendPanel UI, or auto-recommended by file size.
 *
 * QR capacity math comes from @raptorqr/core (MIT).
 */
import { createQRTransferProfile } from "@raptorqr/core/protocol/profiles";

export const RENDER_SCALE = 5;

export interface OpticalProfile {
  id: string;
  label: string;
  qrVersion: number;
  eccLevel: "L" | "M" | "Q" | "H";
  lanes: number;
  laneFps: number;
  repairPercent: number;
  maxPacketSize: number;
  nominalThroughput: number;
}

function buildProfile(
  id: string,
  label: string,
  qrVersion: number,
  eccLevel: "L" | "M" | "Q" | "H",
  lanes: number,
  laneFps: number,
  repairPercent: number,
): OpticalProfile {
  const profile = createQRTransferProfile(qrVersion, eccLevel);
  const maxPacketSize = profile.maxPacketSize;
  const combinedFps = lanes * laneFps;
  const nominalThroughput = maxPacketSize * combinedFps * (1 - repairPercent / 100);
  return { id, label, qrVersion, eccLevel, lanes, laneFps, repairPercent, maxPacketSize, nominalThroughput };
}

/** Available transfer profiles. */
export const PROFILES: Record<string, OpticalProfile> = {
  robust: buildProfile("robust", "Robust", 15, "M", 1, 7, 35),
  balanced: buildProfile("balanced", "Balanced", 25, "M", 1, 10, 30),
  turbo15: buildProfile("turbo15", "Turbo 15", 30, "L", 1, 15, 25),
  turbo30: buildProfile("turbo30", "Turbo 30", 30, "L", 1, 30, 30),
  turbo60: buildProfile("turbo60", "Turbo 60", 30, "L", 2, 30, 35),
};

export const PROFILE_KEYS = Object.keys(PROFILES) as (keyof typeof PROFILES)[];

/** Default profile key. */
export const DEFAULT_PROFILE = "turbo60" as const;

let activeProfileKey: string = DEFAULT_PROFILE;

/** Get or set the active profile. */
export function setActiveProfile(key: string): void {
  if (!(key in PROFILES)) throw new Error(`Unknown profile: ${key}`);
  activeProfileKey = key;
}

/** Get the currently active profile. */
export function activeProfile(): OpticalProfile {
  return PROFILES[activeProfileKey]!;
}

/**
 * Recommend a profile based on file size.
 * - < 50 KB: Robust (slow but resilient, good for small files over shaky cameras)
 * - 50 KB – 500 KB: Balanced (good compromise)
 * - > 500 KB: Turbo 60 (maximum throughput)
 */
export function recommendProfile(fileSizeBytes: number): string {
  if (fileSizeBytes < 50 * 1024) return "robust";
  if (fileSizeBytes < 500 * 1024) return "balanced";
  return "turbo60";
}

// ── Backward-compatible exports ─────────────────────────────────────────

export const LANES = 2 as const;
export const QR_VERSION = 30;
export const QR_ECC = "L" as const;
