import { create } from "zustand";
import type { ClientMode } from "../holochain/client";
import type { LocalParcel } from "../holochain/types";
import type { RoomHistorySnapshot, RoomPeer, RoomTransferRequest } from "../rooms/types";

export type Tab = "send" | "receive" | "rooms" | "history" | "advanced";
export type NetInfo = { connected: boolean; mode: ClientMode; peers: number };

interface State {
  tab: Tab;
  net: NetInfo;
  parcels: LocalParcel[];
  contacts: Array<{ contact: string; hash: string }>;
  pubkey: string;
  roomId: string;
  inviteCode: string;
  peers: RoomPeer[];
  roomTransfers: RoomTransferRequest[];
  roomHistory: RoomHistorySnapshot | null;

  setTab(t: Tab): void;
  setNet(n: NetInfo): void;
  setRoom(room: { roomId: string; inviteCode: string }): void;
  setPeers(peers: RoomPeer[]): void;
  setRoomTransfers(transfers: RoomTransferRequest[]): void;
  setRoomHistory(history: RoomHistorySnapshot | null): void;
  addParcel(p: LocalParcel): void;
  updateParcelStatus(id: string, status: LocalParcel["status"]): void;
  addContact(c: { contact: string; hash: string }): void;
  removeContact(hash: string): void;
  setPubkey(k: string): void;
}

export const useStore = create<State>((set) => ({
  tab: "send",
  net: { connected: false, mode: "detecting", peers: 0 },
  parcels: [],
  contacts: [],
  pubkey: "",
  roomId: "",
  inviteCode: "",
  peers: [],
  roomTransfers: [],
  roomHistory: null,

  setTab: (tab) => set({ tab }),
  setNet: (net) => set({ net }),
  setPubkey: (pubkey) => set({ pubkey }),
  setRoom: ({ roomId, inviteCode }) => set({ roomId, inviteCode }),
  setPeers: (peers) => set({ peers }),
  setRoomTransfers: (roomTransfers) => set({ roomTransfers }),
  setRoomHistory: (roomHistory) => set({ roomHistory }),

  addParcel: (p) => set((s) => ({ parcels: [p, ...s.parcels] })),

  updateParcelStatus: (id, status) =>
    set((s) => ({
      parcels: s.parcels.map((p) => (p.parcel_eh === id ? { ...p, status } : p)),
    })),

  addContact: (c) => set((s) => ({ contacts: [...s.contacts, c] })),

  removeContact: (hash) =>
    set((s) => ({
      contacts: s.contacts.filter((c) => c.hash !== hash),
    })),
}));
