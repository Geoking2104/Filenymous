/**
 * Store global Zustand — v2.
 * Aligné sur la nouvelle architecture (parcel_zome, pas de bridge).
 */

import { create } from "zustand";
import type { LocalParcel } from "../holochain/types";
import type { ClientMode } from "../holochain/client";

export type Tab        = "send" | "inbox" | "history" | "identity" | "privacy";
export type NetInfo    = { connected: boolean; mode: ClientMode; peers: number };

interface State {
  tab:      Tab;
  net:      NetInfo;
  parcels:  LocalParcel[];   // historique local des envois
  contacts: Array<{ contact: string; hash: string }>;
  pubkey:   string;          // AgentPubKey affichée (base64)

  setTab(t: Tab): void;
  setNet(n: NetInfo): void;
  addParcel(p: LocalParcel): void;
  updateParcelStatus(id: string, status: LocalParcel["status"]): void;
  addContact(c: { contact: string; hash: string }): void;
  removeContact(hash: string): void;
  setPubkey(k: string): void;
}

export const useStore = create<State>((set) => ({
  tab:      "send",
  net:      { connected: false, mode: "detecting", peers: 0 },
  parcels:  [],
  contacts: [],
  pubkey:   "",

  setTab:    (tab)    => set({ tab }),
  setNet:    (net)    => set({ net }),
  setPubkey: (pubkey) => set({ pubkey }),

  addParcel: (p) =>
    set((s) => ({ parcels: [p, ...s.parcels] })),

  updateParcelStatus: (id, status) =>
    set((s) => ({
      parcels: s.parcels.map((p) =>
        p.parcel_eh === id ? { ...p, status } : p,
      ),
    })),

  addContact: (c) =>
    set((s) => ({ contacts: [...s.contacts, c] })),

  removeContact: (hash) =>
    set((s) => ({
      contacts: s.contacts.filter((c) => c.hash !== hash),
    })),
}));
