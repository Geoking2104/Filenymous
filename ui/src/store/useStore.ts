import { create } from "zustand";
import type { ClientMode } from "../holochain/client";
import type { LocalParcel } from "../holochain/types";
import type {
  RoomAllowedContact,
  RoomConfig,
  RoomDurationKey,
  RoomHistorySnapshot,
  RoomKind,
  RoomPeer,
  RoomSharedFile,
  RoomTransferRequest,
} from "../rooms/types";
import { computeRoomExpiry } from "../rooms/types";

/** Address-book entry: someone you can send encrypted files to (M3 X25519 flow). */
export interface AddressBookEntry {
  contact: string;
  hash: string;
  resolvedAgent: string | null;
  x25519Key: string | null;
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
  roomKind: RoomKind;
  roomAllowedContacts: RoomAllowedContact[];
  roomDurationKey: RoomDurationKey;
  roomExpiresAtMs: number;
  peers: RoomPeer[];
  roomTransfers: RoomTransferRequest[];
  roomSharedFiles: RoomSharedFile[];
  roomHistory: RoomHistorySnapshot | null;

  setTab(t: Tab): void;
  setNet(n: NetInfo): void;
  setRoom(room: {
    roomId: string;
    inviteCode: string;
    kind?: RoomKind;
    allowedContacts?: RoomAllowedContact[];
    durationKey?: RoomDurationKey;
    expiresAtMs?: number;
  }): void;
  setRoomKind(kind: RoomKind): void;
  setRoomAllowedContacts(contacts: RoomAllowedContact[]): void;
  setRoomDurationKey(key: RoomDurationKey): void;
  setPeers(peers: RoomPeer[]): void;
  setRoomTransfers(transfers: RoomTransferRequest[]): void;
  setRoomSharedFiles(files: RoomSharedFile[]): void;
  addRoomSharedFile(file: RoomSharedFile): void;
  removeRoomSharedFile(shareId: string): void;
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
  getRoomConfig(): RoomConfig | null;
}

export const useStore = create<State>((set, get) => ({
  tab: "send",
  net: { connected: false, mode: "detecting", peers: 0 },
  parcels: [],
  contacts: [],
  addressBook: [],
  selectedRecipient: "",
  pubkey: "",
  roomId: "",
  inviteCode: "",
  roomKind: "private",
  roomAllowedContacts: [],
  roomDurationKey: "24h",
  roomExpiresAtMs: 0,
  peers: [],
  roomTransfers: [],
  roomSharedFiles: [],
  roomHistory: null,

  setTab: (tab) => set({ tab }),
  setNet: (net) => set({ net }),
  setPubkey: (pubkey) => set({ pubkey }),
  setRoom: ({
    roomId,
    inviteCode,
    kind,
    allowedContacts,
    durationKey,
    expiresAtMs,
  }) =>
    set((s) => {
      const nextKind = kind ?? s.roomKind;
      const nextDuration = durationKey ?? s.roomDurationKey;
      return {
        roomId,
        inviteCode,
        roomKind: nextKind,
        roomAllowedContacts: allowedContacts ?? s.roomAllowedContacts,
        roomDurationKey: nextDuration,
        roomExpiresAtMs:
          expiresAtMs !== undefined
            ? expiresAtMs
            : nextKind === "public"
              ? computeRoomExpiry(nextDuration)
              : 0,
      };
    }),
  setRoomKind: (roomKind) =>
    set((s) => ({
      roomKind,
      roomExpiresAtMs: roomKind === "public" ? computeRoomExpiry(s.roomDurationKey) : 0,
    })),
  setRoomAllowedContacts: (roomAllowedContacts) => set({ roomAllowedContacts }),
  setRoomDurationKey: (roomDurationKey) =>
    set((s) => ({
      roomDurationKey,
      roomExpiresAtMs: s.roomKind === "public" ? computeRoomExpiry(roomDurationKey) : s.roomExpiresAtMs,
    })),
  setPeers: (peers) => set({ peers }),
  setRoomTransfers: (roomTransfers) => set({ roomTransfers }),
  setRoomSharedFiles: (roomSharedFiles) => set({ roomSharedFiles }),
  addRoomSharedFile: (file) =>
    set((s) => ({
      roomSharedFiles: s.roomSharedFiles.some((f) => f.shareId === file.shareId)
        ? s.roomSharedFiles
        : [file, ...s.roomSharedFiles],
    })),
  removeRoomSharedFile: (shareId) =>
    set((s) => ({
      roomSharedFiles: s.roomSharedFiles.filter((f) => f.shareId !== shareId),
    })),
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

  getRoomConfig: () => {
    const s = get();
    if (!s.roomId || !s.inviteCode) return null;
    return {
      roomId: s.roomId,
      inviteCode: s.inviteCode,
      kind: s.roomKind,
      allowedContacts: s.roomAllowedContacts,
      durationKey: s.roomDurationKey,
      expiresAtMs: s.roomExpiresAtMs,
      createdAtMs: Date.now(),
    };
  },
}));
