import { signalHttpBase } from "../p2p/config";
import type { SealedSecret } from "./crypto";

/**
 * The Vault API is served by p2p-signal on the VPS (OVH static hosting can't
 * run code). Override with VITE_VAULT_URL or window.__FILENYMOUS_VAULT_URL__.
 */
export function vaultBase(): string {
  const override = (globalThis as { __FILENYMOUS_VAULT_URL__?: string }).__FILENYMOUS_VAULT_URL__;
  if (override) return override.replace(/\/+$/, "");
  const fromEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_VAULT_URL;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim().replace(/\/+$/, "");
  return signalHttpBase();
}

export class VaultError extends Error {
  constructor(readonly code: "gone" | "denied" | "rate-limited" | "too-large" | "invalid" | "network") {
    super(code);
  }
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  let r: Response;
  try {
    r = await fetch(`${vaultBase()}${path}`, { ...init, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
  } catch {
    throw new VaultError("network");
  }
  if (r.ok) return r;
  if (r.status === 404) throw new VaultError("gone");
  if (r.status === 403) throw new VaultError("denied");
  if (r.status === 429) throw new VaultError("rate-limited");
  if (r.status === 413) throw new VaultError("too-large");
  if (r.status === 400) throw new VaultError("invalid");
  throw new VaultError("network");
}

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export async function createSecret(sealed: SealedSecret, opts: { ttlSeconds: number; reads: 0 | 1 }): Promise<{ id: string; expiresAt: number }> {
  return (await call("/api/v1/secrets", json({ ...sealed.body, ttl: opts.ttlSeconds, reads: opts.reads }))).json();
}

export interface SecretMeta {
  pw: boolean;
  salt?: string;
  reads: 0 | 1;
  expiresAt: number;
}

export async function getSecretMeta(id: string): Promise<SecretMeta> {
  return (await call(`/api/v1/secrets/${id}/meta`)).json();
}

export async function revealSecret(id: string, token: string): Promise<{ ct: string; iv: string; burned: boolean }> {
  return (await call(`/api/v1/secrets/${id}/reveal`, json({ token }))).json();
}
