import { isDropHash, isDropOwnerHash } from "../p2p/dropzone/link";
import { isSecretHash } from "../vault/crypto";
import { REPORT_HASH } from "../report/crypto";
import { isWallHash, isWallHostHash } from "../wall/link";
import { isContactInviteHash } from "../safe/invite";

export type Route = "home" | "drop-owner" | "drop-contrib" | "secret-new" | "secret-reveal" | "report-new" | "report-submit" | "report-inbox" | "report-follow" | "wall-host" | "wall-peer" | "safe";

/** Hash routes rendered inside the single-page shell (besides #p2p:). */
export function serviceRoute(hash: string): Route {
  if (isDropHash(hash)) return "drop-contrib";
  if (isDropOwnerHash(hash)) return "drop-owner";
  if (isWallHash(hash)) return "wall-peer";
  if (isWallHostHash(hash)) return "wall-host";
  if (isSecretHash(hash)) return "secret-reveal";
  if (hash === "#secret-new") return "secret-new";
  // Coffre-fort: the persistent personal vault (not the one-time "#secret-new").
  if (hash === "#safe" || hash === "#coffre" || isContactInviteHash(hash)) return "safe";
  if (REPORT_HASH.test(hash)) return "report-submit";
  if (hash === "#report-new") return "report-new";
  if (hash === "#report-inbox") return "report-inbox";
  if (hash === "#report-follow") return "report-follow";
  return "home";
}

export function isServiceHash(hash: string): boolean {
  return serviceRoute(hash) !== "home";
}
