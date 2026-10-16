import { isDropHash, isDropOwnerHash } from "../p2p/dropzone/link";
import { isSecretHash } from "../vault/crypto";

export type Route = "home" | "drop-owner" | "drop-contrib" | "secret-new" | "secret-reveal";

/** Hash routes rendered inside the single-page shell (besides #p2p:). */
export function serviceRoute(hash: string): Route {
  if (isDropHash(hash)) return "drop-contrib";
  if (isDropOwnerHash(hash)) return "drop-owner";
  if (isSecretHash(hash)) return "secret-reveal";
  if (hash === "#secret-new") return "secret-new";
  return "home";
}

export function isServiceHash(hash: string): boolean {
  return serviceRoute(hash) !== "home";
}
