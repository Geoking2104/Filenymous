import { vaultBase } from "../vault/api";
import type { Sealed, SymMsg } from "./crypto";

/** Same VPS service as the Secrets Vault (p2p-signal), under /api/v1/reports. */
export class ReportError extends Error {
  constructor(readonly code: "gone" | "denied" | "rate-limited" | "too-large" | "invalid" | "full" | "network") {
    super(code);
  }
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${vaultBase()}/api/v1/reports${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
  } catch {
    throw new ReportError("network");
  }
  if (r.ok) return r.json() as Promise<T>;
  const code = ({ 404: "gone", 403: "denied", 429: "rate-limited", 413: "too-large", 400: "invalid", 409: "invalid", 507: "full" } as const)[r.status as 404] ?? "network";
  throw new ReportError(code);
}

export type Status = "recu" | "en-cours" | "clos";
export interface ThreadMsg { from: "org" | "reporter"; at: number; msg?: SymMsg; sealed?: Sealed }
export interface ReportSummary { id: string; status: Status; createdAt: number; expiresAt: number; messages: number }

export const createMailbox = (pub: string, admin: string) => call<{ id: string; reportTtlS: number }>("/mailboxes", { v: 1, pub, admin });
export const getMailbox = (id: string) => call<{ pub: string; reportTtlS: number }>(`/mailboxes/${id}`);
export const submitReport = (mailbox: string, id: string, auth: string, sealed: Sealed) =>
  call<{ status: Status; expiresAt: number }>(`/mailboxes/${mailbox}/reports`, { v: 1, id, auth, sealed });
export const listReports = (mailbox: string, token: string) => call<{ reports: ReportSummary[] }>(`/mailboxes/${mailbox}/list`, { token });
export const openReport = (mailbox: string, token: string, id: string) =>
  call<{ sealed: Sealed; status: Status; createdAt: number; expiresAt: number; thread: ThreadMsg[] }>(`/mailboxes/${mailbox}/open`, { token, id });
export const replyReport = (mailbox: string, token: string, id: string, msg: SymMsg) => call<{ status: Status }>(`/mailboxes/${mailbox}/reply`, { token, id, msg });
export const setStatus = (mailbox: string, token: string, id: string, status: Status) => call<{ status: Status }>(`/mailboxes/${mailbox}/status`, { token, id, status });
export const reporterThread = (id: string, token: string) =>
  call<{ status: Status; createdAt: number; expiresAt: number; pub: string | null; thread: ThreadMsg[] }>(`/r/${id}/thread`, { token });
export const reporterFollowup = (id: string, token: string, sealed: Sealed) => call<{ status: Status }>(`/r/${id}/followup`, { token, sealed });
