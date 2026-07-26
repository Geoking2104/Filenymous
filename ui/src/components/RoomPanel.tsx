/**
 * RoomPanel — private (padlock) vs public rooms + open library + P2P discovery
 */

import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { createLocalRoomPeer, RoomDiscovery } from "../rooms/discovery";
import { createInviteCode, roomAvatarInitials, sanitizeRoomText } from "../rooms/roomModel";
import type {
  RoomDurationKey,
  RoomKind,
  RoomPeer,
  RoomSharedFile,
  RoomTransferRequest,
} from "../rooms/types";
import { computeRoomExpiry } from "../rooms/types";
import { useStore } from "../store/useStore";

const localFileHandles = new Map<string, File>();

function createRoomId(): string {
  const fallback = createInviteCode().replace(/-/g, "").toLowerCase();
  return `room-${crypto.randomUUID?.().slice(0, 8) ?? fallback}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function isValidContact(v: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || /^\+[1-9]\d{7,14}$/.test(v);
}

function roomInviteLink(roomId: string, inviteCode: string, kind: RoomKind): string {
  const origin = window.location.origin || "https://geoking2104.github.io";
  return `${origin}/Filenymous/#/room/${encodeURIComponent(roomId)}?key=${encodeURIComponent(inviteCode)}&kind=${kind}`;
}

function formatExpiry(expiresAtMs: number): string {
  if (!expiresAtMs) return "Until tab closes";
  const left = expiresAtMs - Date.now();
  if (left <= 0) return "Expired";
  const h = Math.floor(left / 3_600_000);
  const m = Math.floor((left % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

function PadlockIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="16" r="1.4" fill="currentColor" />
    </svg>
  );
}

function GlobeIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3 12h18M12 3c2.5 2.8 4 6 4 9s-1.5 6.2-4 9c-2.5-2.8-4-6-4-9s1.5-6.2 4-9z" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function requestFromFile(file: File, roomId: string, localId: string, peer: RoomPeer): RoomTransferRequest {
  const now = Date.now();
  return {
    transferId: `transfer-${now}-${file.name}`,
    roomId,
    senderId: localId,
    receiverId: peer.peerId,
    fileNameCiphertext: sanitizeRoomText(file.name, 180),
    fileSize: file.size,
    manifestHash: "",
    integrityHash: "",
    status: "pending",
    createdAtMs: now,
    expiresAtMs: now + 10 * 60_000,
  };
}

function shareFromFile(file: File, roomId: string, localPeer: RoomPeer): RoomSharedFile {
  const shareId = `share-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  localFileHandles.set(shareId, file);
  return {
    shareId,
    roomId,
    ownerId: localPeer.peerId,
    ownerName: localPeer.displayName,
    fileName: sanitizeRoomText(file.name, 180),
    fileSize: file.size,
    mimeType: file.type || "application/octet-stream",
    localOnly: true,
    addedAtMs: Date.now(),
  };
}

export default function RoomPanel() {
  const {
    net,
    roomId,
    inviteCode,
    roomKind,
    roomAllowedContacts,
    roomDurationKey,
    roomExpiresAtMs,
    peers,
    roomTransfers,
    roomSharedFiles,
    addressBook,
    setRoom,
    setRoomKind,
    setRoomAllowedContacts,
    setRoomDurationKey,
    setPeers,
    setRoomTransfers,
    setRoomSharedFiles,
    addRoomSharedFile,
    removeRoomSharedFile,
  } = useStore();

  const localPeerRef = useRef(createLocalRoomPeer("You"));
  const discoveryRef = useRef<RoomDiscovery | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const libraryInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedPeerId, setSelectedPeerId] = useState("");
  const [draft, setDraft] = useState("");
  const [dragging, setDragging] = useState(false);
  const [libDragging, setLibDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const [filter, setFilter] = useState("");
  const [contactDraft, setContactDraft] = useState("");
  const [discoveryState, setDiscoveryState] = useState<"off" | "live">("off");
  const [nowTick, setNowTick] = useState(Date.now());
  const [messages, setMessages] = useState<Array<{ id: string; author: string; text: string }>>([
    {
      id: "welcome",
      author: "Filenymous",
      text: "Choose Private (lock + contacts + code) or Public (open library for a set duration).",
    },
  ]);

  const localPeer = localPeerRef.current;
  const publicExpired = roomKind === "public" && roomExpiresAtMs > 0 && Date.now() > roomExpiresAtMs;

  useEffect(() => {
    if (roomKind !== "public" || !roomExpiresAtMs) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [roomKind, roomExpiresAtMs]);

  useEffect(() => {
    discoveryRef.current?.stop();
    discoveryRef.current = null;
    setDiscoveryState("off");
    if (!roomId || !inviteCode) return;

    const discovery = new RoomDiscovery(roomId, inviteCode, localPeer, {
      onPeerJoin: (peer) => {
        const st = useStore.getState();
        if (st.roomKind === "private" && peer.contact) {
          const ok = st.roomAllowedContacts.some(
            (c) => c.contact.toLowerCase() === peer.contact!.toLowerCase(),
          );
          if (!ok && st.roomAllowedContacts.length > 0) {
            setMessages((prev) => [
              {
                id: crypto.randomUUID?.() ?? `${Date.now()}`,
                author: "System",
                text: `Blocked ${peer.displayName} — contact not on private allow-list`,
              },
              ...prev,
            ]);
            return;
          }
        }
        const current = useStore.getState().peers;
        const without = current.filter((p) => p.peerId !== peer.peerId && p.peerId !== localPeer.peerId);
        setPeers([localPeer, peer, ...without]);
        setMessages((prev) => [
          {
            id: crypto.randomUUID?.() ?? `${Date.now()}`,
            author: "System",
            text: `${peer.displayName} joined`,
          },
          ...prev,
        ]);
      },
      onPeerUpdate: (peer) => {
        const current = useStore.getState().peers;
        const without = current.filter((p) => p.peerId !== peer.peerId && p.peerId !== localPeer.peerId);
        setPeers([localPeer, peer, ...without]);
      },
      onPeerLeave: (peerId) => {
        setPeers(useStore.getState().peers.filter((p) => p.peerId !== peerId));
        setRoomSharedFiles(useStore.getState().roomSharedFiles.filter((f) => f.ownerId !== peerId));
      },
      onLibrarySync: (peerId, files, mode) => {
        if (useStore.getState().roomKind === "public") {
          const exp = useStore.getState().roomExpiresAtMs;
          if (exp > 0 && Date.now() > exp) return;
        }
        const current = useStore.getState().roomSharedFiles;
        if (mode === "full") {
          setRoomSharedFiles([...files, ...current.filter((f) => f.ownerId !== peerId)]);
        } else if (mode === "delta-add") {
          const ids = new Set(files.map((f) => f.shareId));
          setRoomSharedFiles([...files, ...current.filter((f) => !ids.has(f.shareId))]);
        } else {
          const remove = new Set(files.map((f) => f.shareId));
          setRoomSharedFiles(current.filter((f) => !remove.has(f.shareId)));
        }
      },
      onTransferAsk: (msg) => {
        const now = Date.now();
        setRoomTransfers([
          {
            transferId: `transfer-${now}-${msg.shareId}`,
            roomId: msg.roomId,
            senderId: localPeer.peerId,
            receiverId: msg.fromPeerId,
            fileNameCiphertext: msg.fileName,
            fileSize: localFileHandles.get(msg.shareId)?.size ?? 0,
            manifestHash: "",
            integrityHash: "",
            status: "pending",
            createdAtMs: now,
            expiresAtMs: now + 10 * 60_000,
          },
          ...useStore.getState().roomTransfers,
        ]);
      },
    });

    discovery.start(useStore.getState().roomSharedFiles.filter((f) => f.ownerId === localPeer.peerId));
    discoveryRef.current = discovery;
    setDiscoveryState("live");
    setPeers([localPeer, ...useStore.getState().peers.filter((p) => p.peerId !== localPeer.peerId)]);

    return () => {
      discovery.stop();
      discoveryRef.current = null;
      setDiscoveryState("off");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, inviteCode]);

  const visiblePeers = useMemo(() => {
    if (!peers.length) return [localPeer];
    return peers.some((p) => p.peerId === localPeer.peerId) ? peers : [localPeer, ...peers];
  }, [peers, localPeer]);

  const remotePeers = visiblePeers.filter((p) => p.peerId !== localPeer.peerId);
  const selectedPeer = visiblePeers.find((p) => p.peerId === selectedPeerId);
  const canSend = Boolean(roomId && selectedPeer && selectedPeer.peerId !== localPeer.peerId && !publicExpired);
  const inviteUrl =
    roomId && inviteCode ? roomInviteLink(roomId, inviteCode, roomKind) : "";

  const filteredLibrary = useMemo(() => {
    if (publicExpired) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return roomSharedFiles;
    return roomSharedFiles.filter(
      (f) =>
        f.fileName.toLowerCase().includes(q) ||
        f.ownerName.toLowerCase().includes(q) ||
        f.mimeType.toLowerCase().includes(q),
    );
  }, [roomSharedFiles, filter, publicExpired]);

  const ensureRoom = (kind: RoomKind = roomKind) => {
    const nextRoomId = roomId || createRoomId();
    const nextInviteCode = inviteCode || createInviteCode();
    const durationKey = roomDurationKey;
    setRoom({
      roomId: nextRoomId,
      inviteCode: nextInviteCode,
      kind,
      allowedContacts: roomAllowedContacts,
      durationKey,
      expiresAtMs: kind === "public" ? computeRoomExpiry(durationKey) : 0,
    });
    if (!peers.length) setPeers([localPeer]);
    return { roomId: nextRoomId, inviteCode: nextInviteCode };
  };

  const copyInvite = async () => {
    if (roomKind === "private" && roomAllowedContacts.length === 0) {
      setMessages((prev) => [
        {
          id: crypto.randomUUID?.() ?? `${Date.now()}`,
          author: "System",
          text: "Private room: add at least one contact (email or +phone) before sharing the invite.",
        },
        ...prev,
      ]);
    }
    const room = roomId && inviteCode ? { roomId, inviteCode } : ensureRoom();
    const link = roomInviteLink(room.roomId, room.inviteCode, roomKind);
    try {
      await navigator.clipboard?.writeText(link);
    } catch {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = link;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  const addAllowedContact = (raw: string) => {
    const contact = raw.trim();
    if (!isValidContact(contact)) return;
    if (roomAllowedContacts.some((c) => c.contact.toLowerCase() === contact.toLowerCase())) return;
    setRoomAllowedContacts([...roomAllowedContacts, { contact }]);
    setContactDraft("");
  };

  const removeAllowedContact = (contact: string) => {
    setRoomAllowedContacts(roomAllowedContacts.filter((c) => c.contact !== contact));
  };

  const toggleAddressBookContact = (contact: string) => {
    if (roomAllowedContacts.some((c) => c.contact === contact)) {
      removeAllowedContact(contact);
    } else {
      addAllowedContact(contact);
    }
  };

  const queueFiles = (files: FileList | File[]) => {
    const selected = selectedPeer ?? remotePeers[0];
    if (!selected || publicExpired) return;
    const room = ensureRoom();
    setRoomTransfers([
      ...Array.from(files).map((file) => requestFromFile(file, room.roomId, localPeer.peerId, selected)),
      ...roomTransfers,
    ]);
  };

  const openToLibrary = (files: FileList | File[]) => {
    if (publicExpired) return;
    const room = ensureRoom();
    const entries = Array.from(files).map((file) => shareFromFile(file, room.roomId, localPeer));
    entries.forEach((e) => addRoomSharedFile(e));
    discoveryRef.current?.announceLibraryAdd(entries);
  };

  const requestSharedFile = (entry: RoomSharedFile) => {
    if (publicExpired) return;
    if (entry.ownerId === localPeer.peerId) {
      const file = localFileHandles.get(entry.shareId);
      if (file) {
        const url = URL.createObjectURL(file);
        const a = document.createElement("a");
        a.href = url;
        a.download = entry.fileName;
        a.click();
        URL.revokeObjectURL(url);
      }
      return;
    }
    discoveryRef.current?.askTransfer(entry.ownerId, entry.shareId, entry.fileName);
    const room = ensureRoom();
    const now = Date.now();
    setRoomTransfers([
      {
        transferId: `transfer-${now}-${entry.shareId}`,
        roomId: room.roomId,
        senderId: entry.ownerId,
        receiverId: localPeer.peerId,
        fileNameCiphertext: entry.fileName,
        fileSize: entry.fileSize,
        manifestHash: "",
        integrityHash: "",
        status: "pending",
        createdAtMs: now,
        expiresAtMs: now + 10 * 60_000,
      },
      ...roomTransfers,
    ]);
  };

  const unshare = (shareId: string) => {
    localFileHandles.delete(shareId);
    removeRoomSharedFile(shareId);
    discoveryRef.current?.announceLibraryRemove([shareId]);
  };

  return (
    <section className="room-shell">
      <div className="card room-hero">
        <div>
          <div className="card-label">Rooms</div>
          <h1>Private or public rooms</h1>
          <p>
            <strong>Private</strong> (padlock): only selected contacts + invite code.
            <strong> Public</strong>: open library visible to anyone with the link, for a chosen duration.
          </p>
        </div>
        <div className="room-actions">
          <button className="btn-primary" type="button" onClick={() => ensureRoom(roomKind)}>
            Create room
          </button>
          <button className="btn-ghost" type="button" onClick={copyInvite}>
            {copied ? "✓ Copied" : "Copy invite"}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-label">Room type</div>
        <div style={{ display: "flex", gap: ".6rem", flexWrap: "wrap" }}>
          <button
            type="button"
            className={roomKind === "private" ? "btn-primary" : "btn-ghost"}
            onClick={() => setRoomKind("private")}
            style={{ display: "inline-flex", alignItems: "center", gap: ".5rem", minWidth: 140 }}
          >
            <PadlockIcon /> Private
          </button>
          <button
            type="button"
            className={roomKind === "public" ? "btn-primary" : "btn-ghost"}
            onClick={() => setRoomKind("public")}
            style={{ display: "inline-flex", alignItems: "center", gap: ".5rem", minWidth: 140 }}
          >
            <GlobeIcon /> Public
          </button>
        </div>

        {roomKind === "private" ? (
          <div style={{ marginTop: "1.1rem" }}>
            <div className="info-box">
              <span>
                <PadlockIcon size={16} /> Access limited to the contacts below + the invite code.
                Others with the link cannot join the allow-list session.
              </span>
            </div>
            <div className="form-row">
              <label className="form-label">Add contact (email or +phone)</label>
              <div style={{ display: "flex", gap: ".5rem" }}>
                <input
                  type="text"
                  value={contactDraft}
                  onChange={(e) => setContactDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addAllowedContact(contactDraft)}
                  placeholder="alice@example.com or +33612345678"
                  style={{
                    borderColor:
                      contactDraft && !isValidContact(contactDraft) ? "var(--err)" : undefined,
                  }}
                />
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={!isValidContact(contactDraft)}
                  onClick={() => addAllowedContact(contactDraft)}
                >
                  Add
                </button>
              </div>
            </div>

            {addressBook.length > 0 && (
              <div className="form-row">
                <label className="form-label">From address book</label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: ".4rem" }}>
                  {addressBook.map((c) => {
                    const on = roomAllowedContacts.some((x) => x.contact === c.contact);
                    return (
                      <button
                        key={c.hash}
                        type="button"
                        className={on ? "btn-primary btn-sm" : "btn-ghost btn-sm"}
                        onClick={() => toggleAddressBookContact(c.contact)}
                      >
                        {c.contact}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {roomAllowedContacts.length === 0 ? (
              <p className="empty" style={{ padding: "1rem 0" }}>
                No contacts yet — add email / phone to lock the room.
              </p>
            ) : (
              <div className="room-transfer-list">
                {roomAllowedContacts.map((c) => (
                  <div key={c.contact} className="room-transfer-row" style={{ alignItems: "center" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: ".4rem" }}>
                      <PadlockIcon size={14} /> {c.contact}
                    </span>
                    <button
                      type="button"
                      className="btn-ghost btn-sm"
                      style={{ color: "var(--err)" }}
                      onClick={() => removeAllowedContact(c.contact)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div style={{ marginTop: "1.1rem" }}>
            <div className="info-box">
              <span>
                <GlobeIcon size={16} /> Anyone with the invite can see the open library until the duration ends.
              </span>
            </div>
            <div className="form-row">
              <label className="form-label">Visibility duration</label>
              <select
                value={roomDurationKey}
                onChange={(e) => setRoomDurationKey(e.target.value as RoomDurationKey)}
              >
                <option value="1h">1 hour</option>
                <option value="6h">6 hours</option>
                <option value="24h">24 hours</option>
                <option value="7d">7 days</option>
                <option value="30d">30 days</option>
                <option value="session">This browser session only</option>
              </select>
            </div>
            {roomId && (
              <p style={{ fontSize: ".82rem", color: publicExpired ? "var(--err)" : "var(--muted)" }}>
                {publicExpired
                  ? "Public library expired — create a new room or extend duration."
                  : `Expires: ${formatExpiry(roomExpiresAtMs)}`}
                {nowTick > 0 ? "" : ""}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="card room-invite-card">
        <div>
          <div className="card-label" style={{ display: "flex", alignItems: "center", gap: ".4rem" }}>
            {roomKind === "private" ? <PadlockIcon size={14} /> : <GlobeIcon size={14} />}
            Invite · {roomKind}
          </div>
          <p className="room-summary">
            {roomId
              ? discoveryState === "live"
                ? `Discovery live · ${remotePeers.length} remote peer(s)`
                : "Room ready — starting discovery…"
              : "Configure type, then create a room."}
          </p>
        </div>
        <div style={{ display: "flex", gap: ".5rem", alignItems: "center", width: "100%" }}>
          <input
            readOnly
            value={inviteUrl || "No room created yet"}
            aria-label="Room invite link"
            onFocus={(e) => e.currentTarget.select()}
            style={{ flex: 1, minWidth: 0, fontFamily: "monospace", fontSize: ".82rem" }}
          />
          <button
            type="button"
            className={copied ? "btn-success" : "btn-primary"}
            onClick={copyInvite}
            disabled={!inviteUrl && !roomId}
            style={{ flexShrink: 0, whiteSpace: "nowrap", minWidth: 110 }}
            aria-label="Copy invite link"
          >
            {copied ? "✓ Copied" : "Copy link"}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-label">
          {roomKind === "public" ? "Public open library" : "Shared library (private room)"}
        </div>
        {publicExpired ? (
          <div className="warn-box">This public room has expired. Library is hidden.</div>
        ) : (
          <>
            <p style={{ color: "var(--muted)", fontSize: ".9rem", marginBottom: "1rem" }}>
              Select files or folders to list for peers. Catalog only — bytes stay local until requested.
            </p>
            <label
              className={`room-drop ${libDragging ? "is-dragging" : ""}`}
              role="button"
              tabIndex={0}
              onDragOver={(e) => {
                e.preventDefault();
                setLibDragging(true);
              }}
              onDragLeave={() => setLibDragging(false)}
              onDrop={(e: DragEvent<HTMLLabelElement>) => {
                e.preventDefault();
                setLibDragging(false);
                openToLibrary(e.dataTransfer.files);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  libraryInputRef.current?.click();
                }
              }}
              style={{ marginBottom: "1rem" }}
            >
              <input
                ref={libraryInputRef}
                type="file"
                multiple
                onChange={(e) => {
                  if (e.currentTarget.files) openToLibrary(e.currentTarget.files);
                  e.currentTarget.value = "";
                }}
              />
              <strong>Open files to the library</strong>
              <span>
                {roomKind === "public"
                  ? "Visible to anyone with the link for the chosen duration"
                  : "Visible only to allow-listed contacts in this private room"}
              </span>
            </label>
            <div className="form-row">
              <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter by name, owner, type…"
              />
            </div>
            {filteredLibrary.length === 0 ? (
              <p className="empty">No files in the library yet.</p>
            ) : (
              <div className="room-transfer-list">
                {filteredLibrary.map((entry) => {
                  const isMine = entry.ownerId === localPeer.peerId;
                  return (
                    <div key={entry.shareId} className="room-transfer-row" style={{ alignItems: "center" }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {entry.fileName}
                        </div>
                        <div style={{ fontSize: ".72rem", color: "var(--muted)" }}>
                          {formatBytes(entry.fileSize)} · {entry.ownerName}
                          {isMine ? " · you" : " · peer"}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: ".4rem" }}>
                        <button type="button" className="btn-ghost btn-sm" onClick={() => requestSharedFile(entry)}>
                          {isMine ? "Save" : "Request"}
                        </button>
                        {isMine && (
                          <button
                            type="button"
                            className="btn-ghost btn-sm"
                            style={{ color: "var(--err)" }}
                            onClick={() => unshare(entry.shareId)}
                          >
                            Unshare
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      <div className="room-grid">
        <div className="card room-panel">
          <div className="card-label">Participants</div>
          <div className="peer-grid">
            {visiblePeers.map((peer) => {
              const selected = selectedPeerId === peer.peerId;
              return (
                <button
                  key={peer.peerId}
                  type="button"
                  onClick={() => setSelectedPeerId(peer.peerId)}
                  className={selected ? "btn-primary peer-card" : "btn-ghost peer-card"}
                >
                  <span className="peer-avatar">{roomAvatarInitials(peer.displayName, peer.peerId)}</span>
                  <strong>{peer.displayName}</strong>
                  <small>{peer.peerId === localPeer.peerId ? "you" : peer.status}</small>
                </button>
              );
            })}
          </div>
        </div>

        <div className="card room-panel">
          <div className="card-label">Direct send</div>
          <label
            className={`room-drop ${dragging ? "is-dragging" : ""} ${canSend ? "" : "is-disabled"}`}
            role="button"
            tabIndex={canSend ? 0 : -1}
            onDragOver={(e) => {
              e.preventDefault();
              if (canSend) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (canSend) queueFiles(e.dataTransfer.files);
            }}
            onKeyDown={(e: KeyboardEvent<HTMLLabelElement>) => {
              if (!canSend || (e.key !== "Enter" && e.key !== " ")) return;
              e.preventDefault();
              fileInputRef.current?.click();
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              disabled={!canSend}
              onChange={(e) => {
                if (e.currentTarget.files) queueFiles(e.currentTarget.files);
                e.currentTarget.value = "";
              }}
            />
            <strong>{canSend ? `Drop files for ${selectedPeer?.displayName}` : "Select a remote peer"}</strong>
            <span>Point-to-point transfer</span>
          </label>
          <div className="room-transfer-list">
            {roomTransfers.slice(0, 5).map((t) => (
              <div key={t.transferId} className="room-transfer-row">
                <span>{t.fileNameCiphertext}</span>
                <strong>{formatBytes(t.fileSize)}</strong>
              </div>
            ))}
          </div>
        </div>

        <div className="card room-panel room-chat">
          <div className="card-label">Room chat</div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={500}
            placeholder="Note for the room…"
          />
          <button
            className="btn-primary btn-full"
            type="button"
            onClick={() => {
              const text = sanitizeRoomText(draft.trim(), 500);
              if (!text) return;
              setMessages([{ id: `${Date.now()}`, author: "You", text }, ...messages]);
              setDraft("");
            }}
          >
            Send message
          </button>
          <div className="room-messages">
            {messages.slice(0, 8).map((m) => (
              <p key={m.id}>
                <strong>{m.author}</strong>
                <span>{m.text}</span>
              </p>
            ))}
          </div>
        </div>
      </div>

      <div className="info-box room-footnote">
        <span>
          {roomKind === "private" ? (
            <>
              <PadlockIcon size={14} /> Private · {roomAllowedContacts.length} contact(s) · code required
            </>
          ) : (
            <>
              <GlobeIcon size={14} /> Public · {formatExpiry(roomExpiresAtMs)}
            </>
          )}{" "}
          · Discovery {discoveryState} · {net.connected ? "advanced network" : "browser-first"}
        </span>
      </div>
    </section>
  );
}
