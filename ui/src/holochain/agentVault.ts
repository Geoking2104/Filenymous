/**
 * Typed bridge to the Agent Vault, a SEPARATE installed app
 * (installed_app_id "filenymous-agent-vault", role "agent_vault") next to the
 * main "filenymous" app — see dnas/agent_vault and docs/agent-vault/.
 *
 * How the page reaches it (independent of the main app's runtime mode):
 *  1. Desktop app: the Tauri shell injects `window.__FNY_AGENT_VAULT_ENV__`
 *     ({APP_INTERFACE_PORT, APP_INTERFACE_TOKEN, INSTALLED_APP_ID}); zome calls
 *     are signed by the host (same as the main app).
 *  2. Own local node (dev / power users): build with VITE_HC_ADMIN_URL; the page
 *     asks the node's admin interface for a short-lived single-use app token and
 *     a delegated signing key for the agent_vault cell only. Never set this for
 *     a hosted build — it gives the page admin access to the node.
 *  Otherwise the Agents tab shows "unavailable".
 *
 * Holochain types cross the websocket as msgpack: hashes are Uint8Array,
 * Timestamps are microseconds (number), CapSecret is a 64-byte Uint8Array.
 */
import { AdminWebsocket, AppWebsocket, type CallZomeRequest, type CellId } from "@holochain/client";
import { b64u, encodeTokenFile, type SealedBundleWire } from "../safe/agentSeal";
import { installTauriZomeCallSigner } from "./tauriSigner";

declare const __HC_URL__: string;
declare const __HC_ADMIN_URL__: string;
declare const __AGENT_VAULT_APP_ID__: string;

export const AGENT_VAULT_ROLE = "agent_vault";
export const DEFAULT_AGENT_VAULT_APP_ID = "filenymous-agent-vault";
const ZOME = "agent_vault";
const TIMEOUT = 30_000;
/** Functions the page may call (owner side). The agent's grant is separate. */
const OWNER_FNS = [
  "create_agent_config",
  "list_agent_configs",
  "issue_agent_token",
  "rotate_bundle",
  "revoke_agent_token",
  "list_agent_tokens",
  "list_access_events",
] as const;

interface DesktopEnv {
  APP_INTERFACE_PORT: number;
  APP_INTERFACE_TOKEN: number[];
  INSTALLED_APP_ID?: string;
}

const defined = <T>(get: () => T, fallback: T): T => {
  try {
    return get() ?? fallback;
  } catch {
    return fallback; // global not defined (tests)
  }
};

export function agentVaultAppId(): string {
  const env = (globalThis as { __FNY_AGENT_VAULT_ENV__?: DesktopEnv }).__FNY_AGENT_VAULT_ENV__;
  return env?.INSTALLED_APP_ID || defined(() => __AGENT_VAULT_APP_ID__, "") || DEFAULT_AGENT_VAULT_APP_ID;
}

interface Conn {
  app: AppWebsocket;
  cellId: CellId;
  appUrl: string;
  appId: string;
}

let conn: Promise<Conn> | null = null;

async function connectOnce(): Promise<Conn> {
  const appId = agentVaultAppId();
  const desktop = (globalThis as { __FNY_AGENT_VAULT_ENV__?: DesktopEnv }).__FNY_AGENT_VAULT_ENV__;
  const adminUrl = defined(() => __HC_ADMIN_URL__, "");
  let appUrl: string;
  let app: AppWebsocket;
  if (desktop?.APP_INTERFACE_PORT && desktop.APP_INTERFACE_TOKEN) {
    installTauriZomeCallSigner(); // signature par src-tauri (lair local)
    appUrl = `ws://127.0.0.1:${desktop.APP_INTERFACE_PORT}`;
    app = await AppWebsocket.connect({ url: new URL(appUrl), token: desktop.APP_INTERFACE_TOKEN, defaultTimeout: TIMEOUT });
  } else if (adminUrl) {
    appUrl = defined(() => __HC_URL__, "ws://localhost:8888");
    const admin = await AdminWebsocket.connect({ url: new URL(adminUrl), defaultTimeout: TIMEOUT });
    try {
      const { token } = await admin.issueAppAuthenticationToken({ installed_app_id: appId, expiry_seconds: 30, single_use: true });
      app = await AppWebsocket.connect({ url: new URL(appUrl), token, defaultTimeout: TIMEOUT });
      const cellId = cellIdOf(await app.appInfo());
      // Delegated signing key, limited to the owner functions of this cell.
      await admin.authorizeSigningCredentials(cellId, { type: "listed", value: OWNER_FNS.map((f) => [ZOME, f] as [string, string]) });
    } finally {
      await admin.client.close().catch(() => undefined);
    }
  } else {
    throw new Error("agent-vault-unavailable");
  }
  return { app, cellId: cellIdOf(await app.appInfo()), appUrl, appId };
}

function cellIdOf(info: Awaited<ReturnType<AppWebsocket["appInfo"]>>): CellId {
  const cells = info?.cell_info?.[AGENT_VAULT_ROLE] ?? [];
  for (const c of cells) {
    const v = c as { type?: string; value?: { cell_id?: CellId } };
    if (v.type === "provisioned" && v.value?.cell_id) return v.value.cell_id;
  }
  throw new Error("agent-vault-cell-missing");
}

function connection(): Promise<Conn> {
  if (!conn) {
    conn = connectOnce();
    conn.catch(() => (conn = null));
  }
  return conn;
}

async function call<T>(fn: string, payload: unknown = null): Promise<T> {
  const c = await connection();
  return c.app.callZome({ cell_id: c.cellId, zome_name: ZOME, fn_name: fn, payload } as CallZomeRequest, TIMEOUT) as Promise<T>;
}

/** True when the Agent Vault app is installed and reachable (desktop app or own node). */
export async function agentVaultAvailable(): Promise<boolean> {
  try {
    await connection();
    return true;
  } catch {
    return false;
  }
}

export interface AgentConfigEntry {
  config_id: string;
  name: string;
  enc_manifest: Uint8Array;
  created_at: number;
}

export interface TokenStatus {
  token_id: string;
  config_id: string;
  label: string;
  agent_key: Uint8Array;
  agent_x25519: Uint8Array;
  issued_at: number;
  expires_at: number;
  max_uses: number;
  uses: number;
  revoked: boolean;
  expired: boolean;
  latest_version: number;
}

export type AccessKind =
  | { type: "Issued" }
  | { type: "Fetch" }
  | { type: "Denied"; reason: string }
  | { type: "Revoked" }
  | { type: "Rotated" };

export interface AuditEntry {
  action_hash: Uint8Array;
  action_seq: number;
  event: { token_id: string; kind: AccessKind; provenance: Uint8Array; bundle_version: number | null; at: number };
}

export interface IssuedToken {
  token_id: string;
  cap_secret: Uint8Array;
  grant_action_hash: Uint8Array;
  expires_at: number;
  cell_id: [Uint8Array, Uint8Array];
}

export interface IssueInput {
  tokenId: string;
  configId: string;
  label: string;
  agentKey: Uint8Array;
  agentX25519: Uint8Array;
  sealed: SealedBundleWire;
  ttlSeconds: number;
  maxUses: number;
}

export const createAgentConfig = (configId: string, name: string, encManifest: Uint8Array) =>
  call<Uint8Array>("create_agent_config", { config_id: configId, name, enc_manifest: encManifest });

export const listAgentConfigs = () => call<AgentConfigEntry[]>("list_agent_configs");

export const issueAgentToken = (i: IssueInput) =>
  call<IssuedToken>("issue_agent_token", {
    token_id: i.tokenId,
    config_id: i.configId,
    label: i.label,
    agent_key: i.agentKey,
    agent_x25519: i.agentX25519,
    sealed: i.sealed,
    ttl_seconds: i.ttlSeconds,
    max_uses: i.maxUses,
  });

export const rotateBundle = (tokenId: string, sealed: SealedBundleWire) => call<number>("rotate_bundle", { token_id: tokenId, sealed });

export const revokeAgentToken = (tokenId: string, reason: string) => call<null>("revoke_agent_token", { token_id: tokenId, reason });

export const listAgentTokens = () => call<TokenStatus[]>("list_agent_tokens");

export const listAccessEvents = (filter: { token_id?: string; since?: number; limit?: number } = {}) =>
  call<AuditEntry[]>("list_access_events", { token_id: filter.token_id ?? null, since: filter.since ?? null, limit: filter.limit ?? null });

/** The secret string handed to `filenymous vault run --token …` (shown once). */
export async function tokenFileFor(issued: IssuedToken, label: string): Promise<string> {
  const { appUrl, appId } = await connection();
  return encodeTokenFile({
    v: 1,
    appUrl,
    installedAppId: appId,
    cellId: [b64u(issued.cell_id[0]), b64u(issued.cell_id[1])],
    tokenId: issued.token_id,
    capSecret: b64u(issued.cap_secret),
    expiresAt: Math.floor(issued.expires_at / 1000),
    label,
  });
}
