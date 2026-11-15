/**
 * Typed bridge to the `agent_vault` DNA (role "agent_vault"), see
 * dnas/agent_vault and docs/agent-vault/ARCHITECTURE.md.
 *
 * Holochain types cross the websocket as msgpack: hashes are Uint8Array,
 * Timestamps are microseconds (number), CapSecret is a 64-byte Uint8Array.
 */
import { callRoleZome, conductorEndpoint, getClientMode, initClient } from "./client";
import { b64u, encodeTokenFile, type SealedBundleWire } from "../safe/agentSeal";

export const AGENT_VAULT_ROLE = "agent_vault";
const ZOME = "agent_vault";

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

const call = <T>(fn: string, payload: unknown = null) => callRoleZome<T>(AGENT_VAULT_ROLE, ZOME, fn, payload);

/** True only with a local conductor (the feature needs a node reachable by the runner). */
export async function agentVaultAvailable(): Promise<boolean> {
  const mode = getClientMode() === "detecting" ? await initClient() : getClientMode();
  return mode === "websocket";
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
export function tokenFileFor(issued: IssuedToken, label: string): string {
  const { appUrl, installedAppId } = conductorEndpoint();
  return encodeTokenFile({
    v: 1,
    appUrl,
    installedAppId,
    cellId: [b64u(issued.cell_id[0]), b64u(issued.cell_id[1])],
    tokenId: issued.token_id,
    capSecret: b64u(issued.cap_secret),
    expiresAt: Math.floor(issued.expires_at / 1000),
    label,
  });
}
