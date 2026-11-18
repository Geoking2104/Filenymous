import { describe, expect, it, vi } from "vitest";
import { decode } from "@msgpack/msgpack";
import type { CallZomeRequest } from "@holochain/client";
import { installTauriZomeCallSigner, isDesktopLauncher, toUnsignedTauri, type DesktopWindow } from "./tauriSigner";

const request = {
  cell_id: [new Uint8Array([1, 2]), new Uint8Array([3, 4])],
  zome_name: "identity",
  fn_name: "get_agent_for_contact",
  provenance: new Uint8Array([3, 4]),
  payload: { contact_hash: "abc" },
} as unknown as CallZomeRequest;

describe("tauriSigner", () => {
  it("maps a CallZomeRequest to the Rust command payload (msgpack payload)", () => {
    const u = toUnsignedTauri(request);
    expect(u).toMatchObject({ provenance: [3, 4], cellIdDna: [1, 2], cellIdAgent: [3, 4], zomeName: "identity", fnName: "get_agent_for_contact", capSecret: null });
    expect(decode(Uint8Array.from(u.payload))).toEqual({ contact_hash: "abc" });
  });

  it("installs a host signer that delegates to the sign_zome_call command", async () => {
    const invoke = vi.fn().mockResolvedValue({ bytes: [9, 9], signature: [7] });
    const w: DesktopWindow = { __TAURI__: { invoke }, __HC_LAUNCHER_ENV__: {} };
    expect(isDesktopLauncher(w)).toBe(true);
    expect(installTauriZomeCallSigner(w)).toBe(true);
    const signed = await w.__HC_ZOME_CALL_SIGNER__!.signZomeCall(request);
    expect(invoke).toHaveBeenCalledWith("sign_zome_call", { zomeCallUnsigned: toUnsignedTauri(request) });
    expect(signed.bytes).toEqual(new Uint8Array([9, 9]));
    expect(signed.signature).toEqual(new Uint8Array([7]));
    expect(installTauriZomeCallSigner(w)).toBe(false);
  });

  it("does nothing outside Tauri", () => {
    expect(installTauriZomeCallSigner({})).toBe(false);
    expect(isDesktopLauncher({})).toBe(false);
  });
});
