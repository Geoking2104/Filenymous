import { AppWebsocket, type RoleNameCallZomeRequest } from "@holochain/client";
import { modeCapabilities, type HoloRuntimeClient, type RuntimeMode } from "./runtime";

declare const __HC_URL__: string;
declare const __WEB_BRIDGE_URL__: string;
declare const __HWC_LINKER_URL__: string;

const ROLE = "filenymous";
const WS_TIMEOUT_MS = 3_000;
const ZOME_TIMEOUT = 30_000;

export type ClientMode = RuntimeMode;

type MinimalRuntime = Pick<HoloRuntimeClient, "mode">;

export interface RuntimeFactories<
  THoloWeb extends MinimalRuntime = HoloRuntimeClient,
  TWebsocket extends MinimalRuntime = HoloRuntimeClient,
  TWebBridge extends MinimalRuntime = HoloRuntimeClient,
  TLocalOnly extends MinimalRuntime = HoloRuntimeClient,
> {
  createHoloWebClient(): Promise<THoloWeb>;
  createWebsocketClient(): Promise<TWebsocket>;
  createWebBridgeClient(): Promise<TWebBridge>;
  createLocalOnlyClient(): TLocalOnly;
}

export function createRuntimeDetector<
  THoloWeb extends MinimalRuntime,
  TWebsocket extends MinimalRuntime,
  TWebBridge extends MinimalRuntime,
  TLocalOnly extends MinimalRuntime,
>(
  factories: RuntimeFactories<THoloWeb, TWebsocket, TWebBridge, TLocalOnly>,
): () => Promise<THoloWeb | TWebsocket | TWebBridge | TLocalOnly> {
  return async () => {
    try {
      return await factories.createHoloWebClient();
    } catch {
      try {
        return await factories.createWebsocketClient();
      } catch {
        try {
          return await factories.createWebBridgeClient();
        } catch {
          return factories.createLocalOnlyClient();
        }
      }
    }
  };
}

type SignalHandler = (signal: unknown) => void;

interface HwcCompatibleClient {
  myPubKey?: Uint8Array;
  callZome(request: unknown, timeoutMs?: number): Promise<unknown>;
  on?(eventName: "signal", handler: SignalHandler): void;
}

export async function createHoloWebRuntime(
  loadClient: () => Promise<HwcCompatibleClient> = loadDefaultHoloWebClient,
): Promise<HoloRuntimeClient> {
  const hwc = await loadClient();
  const caps = modeCapabilities("holo-web");
  return {
    mode: "holo-web",
    ...caps,
    callZome<T>(zomeName: string, fnName: string, payload: unknown = null) {
      return hwc.callZome(
        {
          role_name: ROLE,
          zome_name: zomeName,
          fn_name: fnName,
          payload,
        },
        ZOME_TIMEOUT,
      ) as Promise<T>;
    },
    webBridgeGet<T>(path: string) {
      return fetchWebBridge<T>(path);
    },
    async getMyPubKey() {
      if (!hwc.myPubKey) throw new Error("AgentPubKey non disponible via Holo Web Conductor.");
      return hwc.myPubKey;
    },
    onSignal(handler) {
      hwc.on?.("signal", (signal) => emitSignal(handler, signal));
    },
  };
}

async function loadDefaultHoloWebClient(): Promise<HwcCompatibleClient> {
  const mod = await import("@holo-host/web-conductor-client");
  if (!mod.isWebConductorAvailable()) {
    throw new Error("Holo Web Conductor extension non disponible.");
  }
  await withTimeout(mod.waitForHolochain(), WS_TIMEOUT_MS);
  return mod.WebConductorAppClient.connect({
    linkerUrl: __HWC_LINKER_URL__,
    autoReconnect: true,
    roleName: ROLE,
  });
}

let _client: HoloRuntimeClient | null = null;
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
    const detectRuntime = createRuntimeDetector({
      createHoloWebClient: createHoloWebRuntime,
      createWebsocketClient: createWebsocketRuntime,
      createWebBridgeClient: async () => createWebBridgeRuntime(),
      createLocalOnlyClient: createLocalOnlyRuntime,
    });
    _client = await detectRuntime();
    _mode = _client.mode;
  })();

  await _connecting;
  _connecting = null;
  return _mode;
}

async function createWebsocketRuntime(): Promise<HoloRuntimeClient> {
  const client = await withTimeout(
    AppWebsocket.connect({
      url: new URL(__HC_URL__),
      defaultTimeout: ZOME_TIMEOUT,
    }),
    WS_TIMEOUT_MS,
  );
  const caps = modeCapabilities("websocket");
  return {
    mode: "websocket",
    ...caps,
    callZome<T>(zomeName: string, fnName: string, payload: unknown = null) {
      return client.callZome(
        {
          role_name: ROLE,
          zome_name: zomeName,
          fn_name: fnName,
          payload,
        } as RoleNameCallZomeRequest,
        ZOME_TIMEOUT,
      ) as Promise<T>;
    },
    webBridgeGet<T>(path: string) {
      return fetchWebBridge<T>(path);
    },
    async getMyPubKey() {
      return client.myPubKey;
    },
    onSignal(handler) {
      client.on("signal", (signal) => emitSignal(handler, signal));
    },
  };
}

function createWebBridgeRuntime(): HoloRuntimeClient {
  const caps = modeCapabilities("web-bridge");
  return {
    mode: "web-bridge",
    ...caps,
    async callZome() {
      throw new Error("callZome requiert Holo Web Conductor ou un conducteur Holochain local.");
    },
    webBridgeGet<T>(path: string) {
      return fetchWebBridge<T>(path);
    },
    async getMyPubKey() {
      throw new Error("AgentPubKey non disponible en mode Web Bridge.");
    },
    onSignal() {
      // No-op: the HTTP bridge does not expose app signals.
    },
  };
}

function createLocalOnlyRuntime(): HoloRuntimeClient {
  const caps = modeCapabilities("local-only");
  return {
    mode: "local-only",
    ...caps,
    async callZome() {
      throw new Error("callZome indisponible sans runtime Holochain.");
    },
    async webBridgeGet() {
      throw new Error("DHT inaccessible sans Holo Web Bridge.");
    },
    async getMyPubKey() {
      throw new Error("AgentPubKey non disponible sans runtime Holochain.");
    },
    onSignal() {
      // No-op: local-only mode has no Holochain signal source.
    },
  };
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

function emitSignal(handler: (signal: unknown) => void, signal: unknown): void {
  if (
    typeof signal === "object" &&
    signal !== null &&
    "type" in signal &&
    (signal as { type?: unknown }).type === "app" &&
    "value" in signal
  ) {
    handler((signal as { value?: { payload?: unknown } }).value?.payload);
    return;
  }
  handler(signal);
}

async function fetchWebBridge<T>(path: string): Promise<T> {
  const url = `${__WEB_BRIDGE_URL__}/${path}`;
  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error(`Web Bridge ${resp.status}: ${await resp.text()}`);
  return resp.json() as Promise<T>;
}

export function canWrite(): boolean {
  return _client?.canWrite ?? false;
}

export function canReadDht(): boolean {
  return _client?.canReadDht ?? false;
}

export function setClientForTests(client: HoloRuntimeClient): void {
  _client = client;
  _mode = client.mode;
}

export function resetClientForTests(): void {
  _client = null;
  _mode = "detecting";
  _connecting = null;
}

export async function callZome<T>(
  zome_name: string,
  fn_name: string,
  payload: unknown = null,
): Promise<T> {
  if (_mode === "detecting") await initClient();

  if (!_client || !_client.canWrite) {
    throw new Error(
      `callZome("${zome_name}", "${fn_name}") requiert un conducteur Holochain. ` +
        "Activez Holo Web Conductor ou un conducteur Holochain local.",
    );
  }

  return _client.callZome<T>(zome_name, fn_name, payload);
}

export async function webBridgeGet<T>(path: string): Promise<T> {
  if (_mode === "detecting") await initClient();
  return _client!.webBridgeGet<T>(path);
}

export function hasConductor(): boolean {
  return canWrite();
}

export async function getMyPubKey(): Promise<Uint8Array> {
  if (_mode === "detecting") await initClient();
  if (!_client) throw new Error("AgentPubKey non disponible sans runtime Holochain.");
  return _client.getMyPubKey();
}

export function onSignal(handler: (signal: unknown) => void): void {
  _client?.onSignal(handler);
}
