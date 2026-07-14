import { create } from "zustand";
import type { ClientMode } from "../holochain/client";
import type { LocalParcel } from "../holochain/types";
import type { RoomHistorySnapshot, RoomPeer, RoomTransferRequest } from "../rooms/types";

/** Address-book entry: someone you can send encrypted files to (M3 X25519 flow). */
export interface AddressBookEntry {
  contact: string;               // email or E.164 phone as typed by the user
  hash: string;                  // SHA-256 contact hash (what lives on the DHT)
  resolvedAgent: string | null;  // AgentPubKey (b64) if the contact claimed it on the DHT
  x25519Key: string | null;      // recipient's published X25519 public key (b64)
}

export type Tab = "send" | "receive" | "rooms" | "contacts" | "identity" | "history" | "advanced";
export type NetInfo = { connected: boolean; mode: ClientMode; peers: number };

interface State {
  tab: Tab;
  net: NetInfo;
  parcels: LocalParcel[];
  contacts: Array<{ contact: string; hash: string }>;
  addressBook: AddressBookEntry[];
  selectedRecipient: string;
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
  addAddressBookEntry(e: AddressBookEntry): void;
  updateAddressBookEntry(hash: string, patch: Partial<AddressBookEntry>): void;
  removeAddressBookEntry(hash: string): void;
  setSelectedRecipient(contact: string): void;
  removeContact(hash: string): void;
  setPubkey(k: string): void;
}

export const useStore = create<State>((set) => ({
  tab: "send",
  net: { connected: false, mode: "detecting", peers: 0 },
  parcels: [],
  contacts: [],
  addressBook: [],
  selectedRecipient: "",
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

  addAddressBookEntry: (e) =>
    set((s) => ({
      addressBook: s.addressBook.some((x) => x.hash === e.hash)
        ? s.addressBook
        : [...s.addressBook, e],
    })),

  updateAddressBookEntry: (hash, patch) =>
    set((s) => ({
      addressBook: s.addressBook.map((x) => (x.hash === hash ? { ...x, ...patch } : x)),
    })),

  removeAddressBookEntry: (hash) =>
    set((s) => ({
      addressBook: s.addressBook.filter((x) => x.hash !== hash),
    })),

  setSelectedRecipient: (selectedRecipient) => set({ selectedRecipient }),

  removeContact: (hash) =>
    set((s) => ({
      contacts: s.contacts.filter((c) => c.hash !== hash),
    })),
}));
