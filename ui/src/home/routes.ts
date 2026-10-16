import { isDropHash, isDropOwnerHash } from "../p2p/dropzone/link";
import { isSecretHash } from "../vault/crypto";
import { REPORT_HASH } from "../report/crypto";

export type Route = "home" | "drop-owner" | "drop-contrib" | "secret-new" | "secret-reveal" | "report-new" | "report-submit" | "report-inbox" | "report-follow";

/** Hash routes rendered inside the single-page shell (besides #p2p:). */
export function serviceRoute(hash: string): Route {
  if (isDropHash(hash)) return "drop-contrib";
  if (isDropOwnerHash(hash)) return "drop-owner";
  if (isSecretHash(hash)) return "secret-reveal";
  if (hash === "#secret-new") return "secret-new";
  if (REPORT_HASH.test(hash)) return "report-submit";
  if (hash === "#report-new") return "report-new";
  if (hash === "#report-inbox") return "report-inbox";
  if (hash === "#report-follow") return "report-follow";
  return "home";
}

export function isServiceHash(hash: string): boolean {
  return serviceRoute(hash) !== "home";
}
