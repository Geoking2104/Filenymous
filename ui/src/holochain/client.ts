/**
 * Singleton Holochain client.
 * Wraps AppAgentWebsocket from @holochain/client.
 *
 * Usage:
 *   import { getClient } from './holochain/client'
 *   const client = await getClient()
 *   const result = await client.callZome({ ... })
 */

import {
  AppAgentWebsocket,
  type AppAgentClient,
  type CallZomeRequest,
} from "@holochain/client";

declare const __HC_URL__: string;

const APP_ID   = "filenymous";
const ROLE     = "filenymous";
const TIMEOUT  = 30_000; // 30 s

let _client: AppAgentClient | null = null;
let _connecting: Promise<AppAgentClient> | null = null;

export async function getClient(): Promise<AppAgentClient> {
  if (_client) return _client;
  if (_connecting) return _connecting;

  _connecting = AppAgentWebsocket.connect(
    new URL(__HC_URL__),
    APP_ID,
    TIMEOUT
  ).then((c) => {
    _client = c;
    _connecting = null;
    return c;
  });

  return _connecting;
}

/** Convenience wrapper — avoids repeating role_name everywhere */
export async function callZome<T>(
  zome_name: string,
  fn_name: string,
  payload: unknown = null
): Promise<T> {
  const client = await getClient();
  return client.callZome({
    cap_secret: null,
    role_name: ROLE,
    zome_name,
    fn_name,
    payload,
  } as CallZomeRequest) as Promise<T>;
}
