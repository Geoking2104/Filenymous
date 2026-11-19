import { encode } from "@msgpack/msgpack";
import type { CallZomeRequest, CallZomeRequestSigned } from "@holochain/client";

/**
 * Desktop (Tauri) : les appels de zome sont signés côté Rust avec la clé de
 * l'agent dans le lair local (commande `sign_zome_call`, src-tauri). On
 * branche ce signataire sur le hook standard de @holochain/client
 * (`window.__HC_ZOME_CALL_SIGNER__`). Sans lui, AppWebsocket exigerait des
 * signing credentials autorisées via l'interface admin.
 */

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface DesktopWindow {
  __TAURI__?: { invoke?: TauriInvoke; tauri?: { invoke?: TauriInvoke } };
  __HC_LAUNCHER_ENV__?: unknown;
  __HC_ZOME_CALL_SIGNER__?: { signZomeCall: (request: CallZomeRequest) => Promise<CallZomeRequestSigned> };
}

export interface ZomeCallUnsignedTauri {
  provenance: number[];
  cellIdDna: number[];
  cellIdAgent: number[];
  zomeName: string;
  fnName: string;
  capSecret: number[] | null;
  payload: number[];
}

function currentWindow(): DesktopWindow | undefined {
  return typeof window === "undefined" ? undefined : (window as unknown as DesktopWindow);
}

export function tauriInvoke(w: DesktopWindow | undefined = currentWindow()): TauriInvoke | undefined {
  return w?.__TAURI__?.invoke ?? w?.__TAURI__?.tauri?.invoke;
}

/** Desktop Filenymous : conductor local injecté par src-tauri. */
export function isDesktopLauncher(w: DesktopWindow | undefined = currentWindow()): boolean {
  return !!w && "__HC_LAUNCHER_ENV__" in w;
}

export function toUnsignedTauri(request: CallZomeRequest): ZomeCallUnsignedTauri {
  return {
    provenance: Array.from(request.provenance ?? request.cell_id[1]),
    cellIdDna: Array.from(request.cell_id[0]),
    cellIdAgent: Array.from(request.cell_id[1]),
    zomeName: request.zome_name,
    fnName: request.fn_name,
    capSecret: request.cap_secret ? Array.from(request.cap_secret) : null,
    payload: Array.from(encode(request.payload)),
  };
}

/** Installe le signataire Tauri s'il n'y en a pas déjà un. */
export function installTauriZomeCallSigner(w: DesktopWindow | undefined = currentWindow()): boolean {
  const invoke = tauriInvoke(w);
  if (!w || !invoke || w.__HC_ZOME_CALL_SIGNER__) return false;
  w.__HC_ZOME_CALL_SIGNER__ = {
    async signZomeCall(request: CallZomeRequest): Promise<CallZomeRequestSigned> {
      const signed = (await invoke("sign_zome_call", {
        zomeCallUnsigned: toUnsignedTauri(request),
      })) as { bytes: number[]; signature: number[] };
      return { bytes: Uint8Array.from(signed.bytes), signature: Uint8Array.from(signed.signature) };
    },
  };
  return true;
}
