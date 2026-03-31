/**
 * Global app state — Zustand store.
 */

import { create } from "zustand";
import type { TransferManifest } from "../holochain/types";

export type Tab = "send" | "receive" | "history" | "identity" | "privacy";
export type SendState = "idle" | "uploading" | "done";
export type RxState  = "idle" | "found" | "done";

export interface LocalTransfer {
  transfer_id: string;
  file_name:   string;
  to:          string;
  size:        number;
  date:        string;
  status:      "pending" | "downloaded" | "revoked" | "expired";
  downloads:   number;
  max_dl:      number;
  link:        string;
}

export interface NetInfo {
  connected: boolean;
  peers: number;
}

interface State {
  tab:       Tab;
  net:       NetInfo;
  transfers: LocalTransfer[];
  contacts:  Array<{ contact: string; hash: string }>;
  pubkey:    string;

  setTab(t: Tab): void;
  setNet(n: NetInfo): void;
  addTransfer(t: LocalTransfer): void;
  updateTransferStatus(id: string, status: LocalTransfer["status"]): void;
  addContact(c: { contact: string; hash: string }): void;
  removeContact(hash: string): void;
  setPubkey(k: string): void;
}

export const useStore = create<State>((set) => ({
  tab:  "send",
  net:  { connected: false, peers: 0 },
  transfers: [],
  contacts:  [],
  pubkey:    "",

  setTab:    (tab)  => set({ tab }),
  setNet:    (net)  => set({ net }),
  setPubkey: (pubkey) => set({ pubkey }),

  addTransfer: (t) =>
    set((s) => ({ transfers: [t, ...s.transfers] })),

  updateTransferStatus: (id, status) =>
    set((s) => ({
      transfers: s.transfers.map((t) =>
        t.transfer_id === id ? { ...t, status } : t
      ),
    })),

  addContact: (c) =>
    set((s) => ({ contacts: [...s.contacts, c] })),

  removeContact: (hash) =>
    set((s) => ({
      contacts: s.contacts.filter((c) => c.hash !== hash),
    })),
}));
