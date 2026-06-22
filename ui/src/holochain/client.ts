import { AppWebsocket, type AppClient, type RoleNameCallZomeRequest } from "@holochain/client";
import type { RuntimeMode } from "./runtime";

declare const __HC_URL__: string;
declare const __WEB_BRIDGE_URL__: string;

const ROLE = "filenymous";
const WS_TIMEOUT_MS = 3_000;
const ZOME_TIMEOUT = 30_000;

export type ClientMode = RuntimeMode;

let _client: AppClient | null = null;
let _mode: ClientMode = "detecting";
let _connecting: Promise<void> | null = null;

export function getClientMode(): ClientMode {
  return _mode;
}

export async function initClient(): Promise<ClientMode> {
  if (_mode !== "detecting") return _mode;
  if (_connecting) {
    await _connecting;
    return _mode;
  }

  _connecting = (async () => {
    try {
      _client = await withTimeout(
        AppWebsocket.connect({
          url: new URL(__HC_URL__),
          defaultTimeout: ZOME_TIMEOUT,
        }),
        WS_TIMEOUT_MS,
      );
      _mode = "websocket";
    } catch {
      _client = null;
      _mode = "web-bridge";
    }
  })();

  await _connecting;
  _connecting = null;
  return _mode;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("Holochain connection timeout")), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        window.clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function callZome<T>(
  zome_name: string,
  fn_name: string,
  payload: unknown = null,
): Promise<T> {
  if (_mode === "detecting") await initClient();

  if (_mode === "web-bridge") {
    throw new Error(
      `callZome("${zome_name}", "${fn_name}") requiert un conducteur Holochain. ` +
        "Installez Holochain Launcher pour cette fonctionnalite.",
    );
  }

  return _client!.callZome(
    {
      role_name: ROLE,
      zome_name,
      fn_name,
      payload,
    } as RoleNameCallZomeRequest,
    ZOME_TIMEOUT,
  ) as Promise<T>;
}

export async function webBridgeGet<T>(path: string): Promise<T> {
  if (_mode === "detecting") await initClient();
  const url = `${__WEB_BRIDGE_URL__}/${path}`;
  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error(`Web Bridge ${resp.status}: ${await resp.text()}`);
  return resp.json() as Promise<T>;
}

export function hasConductor(): boolean {
  return _mode === "websocket";
}

export async function getMyPubKey(): Promise<Uint8Array> {
  if (_mode === "detecting") await initClient();
  if (!_client || _mode !== "websocket") {
    throw new Error("AgentPubKey non disponible en mode Web Bridge.");
  }
  return _client.myPubKey;
}

export function onSignal(handler: (signal: unknown) => void): void {
  _client?.on("signal", (signal) => {
    if (signal.type === "app") {
      handler(signal.value.payload);
      return;
    }
    handler(signal);
  });
}
