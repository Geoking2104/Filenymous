export type RuntimeMode =
  | "detecting"
  | "holo-web"
  | "websocket"
  | "web-bridge"
  | "local-only";

export interface RuntimeCapabilities {
  canWrite: boolean;
  canReadDht: boolean;
}

export interface HoloRuntimeClient extends RuntimeCapabilities {
  readonly mode: RuntimeMode;
  callZome<T>(zomeName: string, fnName: string, payload?: unknown): Promise<T>;
  webBridgeGet<T>(path: string): Promise<T>;
  getMyPubKey(): Promise<Uint8Array>;
  onSignal(handler: (signal: unknown) => void): void;
}

export function modeCapabilities(mode: RuntimeMode): RuntimeCapabilities {
  return {
    canWrite: mode === "holo-web" || mode === "websocket",
    canReadDht: mode === "holo-web" || mode === "websocket" || mode === "web-bridge",
  };
}
