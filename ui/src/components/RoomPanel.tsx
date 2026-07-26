/**
 * RoomPanel — private room + live open shared library
 * Inspired by eMule shared files: files selected by peers are visible
 * to everyone in the room session (browser-only, no plugin download).
 */

import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { createInviteCode, roomAvatarInitials, sanitizeRoomText } from "../rooms/roomModel";
import type { RoomPeer, RoomSharedFile, RoomTransferRequest } from "../rooms/types";
import { useStore } from "../store/useStore";

const localPeer: RoomPeer = {
  peerId: "local",
  displayName: "You",
  avatarSeed: "local",
  status: "online",
  lastSeenMs: Date.now(),
  expiresAtMs: Date.now() + 60_000,
};

/** Keep File handles only in memory on the owner's tab */
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

function roomInviteLink(roomId: string, inviteCode: string): string {
  const origin = window.location.origin || "https://geoking2104.github.io";
  return `${origin}/Filenymous/#/room/${encodeURIComponent(roomId)}?key=${encodeURIComponent(inviteCode)}`;
}

function requestFromFile(file: File, roomId: string, peer: RoomPeer): RoomTransferRequest {
  const now = Date.now();
  return {
    transferId: `transfer-${now}-${file.name}`,
    roomId,
    senderId: localPeer.peerId,
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

function shareFromFile(file: File, roomId: string): RoomSharedFile {
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
    peers,
    roomTransfers,
    roomSharedFiles,
    setRoom,
    setPeers,
    setRoomTransfers,
    addRoomSharedFile,
    removeRoomSharedFile,
  } = useStore();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const libraryInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedPeerId, setSelectedPeerId] = useState("");
  const [draft, setDraft] = useState("");
  const [dragging, setDragging] = useState(false);
  const [libDragging, setLibDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const [filter, setFilter] = useState("");
  const [messages, setMessages] = useState<Array<{ id: string; author: string; text: string }>>([
    {
      id: "welcome",
      author: "Filenymous",
      text: "Create a room, share the invite, open files into the live library. Peers discover them in-session — no plugin.",
    },
  ]);

  const visiblePeers = useMemo(() => (peers.length ? peers : [localPeer]), [peers]);
  const remotePeers = visiblePeers.filter((peer) => peer.peerId !== localPeer.peerId);
  const selectedPeer = visiblePeers.find((peer) => peer.peerId === selectedPeerId);
  const canSend = Boolean(roomId && selectedPeer && selectedPeer.peerId !== localPeer.peerId);
  const inviteUrl = roomId && inviteCode ? roomInviteLink(roomId, inviteCode) : "";

  const filteredLibrary = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return roomSharedFiles;
    return roomSharedFiles.filter(
      (f) =>
        f.fileName.toLowerCase().includes(q) ||
        f.ownerName.toLowerCase().includes(q) ||
        f.mimeType.toLowerCase().includes(q),
    );
  }, [roomSharedFiles, filter]);

  const ensureRoom = () => {
    const nextRoomId = roomId || createRoomId();
    const nextInviteCode = inviteCode || createInviteCode();
    setRoom({ roomId: nextRoomId, inviteCode: nextInviteCode });
    if (!peers.length) setPeers([localPeer]);
    return { roomId: nextRoomId, inviteCode: nextInviteCode };
  };

  const copyInvite = async () => {
    const room = roomId && inviteCode ? { roomId, inviteCode } : ensureRoom();
    await navigator.clipboard?.writeText(roomInviteLink(room.roomId, room.inviteCode));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const addDemoPeer = () => {
    ensureRoom();
    const demoPeer: RoomPeer = {
      peerId: "peer-demo",
      displayName: "Guest",
      avatarSeed: "demo",
      status: "online",
      lastSeenMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    };
    setPeers([...visiblePeers.filter((peer) => peer.peerId !== demoPeer.peerId), demoPeer]);
    setSelectedPeerId(demoPeer.peerId);
  };

  const queueFiles = (files: FileList | File[]) => {
    const selected = selectedPeer ?? remotePeers[0];
    if (!selected) return;
    const room = ensureRoom();
    const requests = Array.from(files).map((file) => requestFromFile(file, room.roomId, selected));
    setRoomTransfers([...requests, ...roomTransfers]);
  };

  const openToLibrary = (files: FileList | File[]) => {
    const room = ensureRoom();
    Array.from(files).forEach((file) => {
      addRoomSharedFile(shareFromFile(file, room.roomId));
    });
    setMessages((prev) => [
      {
        id: crypto.randomUUID?.() ?? `${Date.now()}`,
        author: "System",
        text: `${Array.from(files).length} file(s) opened to the live library — visible to room peers while this tab stays open.`,
      },
      ...prev,
    ]);
  };

  const requestSharedFile = (entry: RoomSharedFile) => {
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
    // Remote peer: queue a transfer request (live session path)
    const peer = visiblePeers.find((p) => p.peerId === entry.ownerId);
    if (!peer) return;
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
    setMessages((prev) => [
      {
        id: crypto.randomUUID?.() ?? `${Date.now()}`,
        author: "You",
        text: `Requested «${entry.fileName}» from ${entry.ownerName}`,
      },
      ...prev,
    ]);
  };

  const unshare = (shareId: string) => {
    localFileHandles.delete(shareId);
    removeRoomSharedFile(shareId);
  };

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!canSend) return;
    queueFiles(event.dataTransfer.files);
  };

  const handleLibDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setLibDragging(false);
    openToLibrary(event.dataTransfer.files);
  };

  const handleDropKeyDown = (event: KeyboardEvent<HTMLLabelElement>) => {
    if (!canSend || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    fileInputRef.current?.click();
  };

  const sendMessage = () => {
    const text = sanitizeRoomText(draft.trim(), 500);
    if (!text) return;
    setMessages([{ id: crypto.randomUUID?.() ?? `${Date.now()}`, author: "You", text }, ...messages]);
    setDraft("");
  };

  return (
    <section className="room-shell">
      <div className="card room-hero">
        <div>
          <div className="card-label">Rooms</div>
          <h1>Live room & open library</h1>
          <p>
            Session-only shared files — like a lightweight eMule library in the browser.
            Select files to open them to the room; peers discover and request them live. No plugin.
          </p>
        </div>
        <div className="room-actions">
          <button className="btn-primary" type="button" onClick={ensureRoom}>
            Create room
          </button>
          <button className="btn-ghost" type="button" onClick={copyInvite}>
            {copied ? "Copied" : "Copy invite"}
          </button>
        </div>
      </div>

      <div className="card room-invite-card">
        <div>
          <div className="card-label">Invite</div>
          <p className="room-summary">
            {roomId
              ? "Room ready. Share this link — library stays live while tabs stay open."
              : "Create a room to generate an invite link."}
          </p>
        </div>
        <input
          readOnly
          value={inviteUrl || "No room created yet"}
          aria-label="Room invite link"
          onFocus={(event) => event.currentTarget.select()}
        />
      </div>

      {/* Live open library */}
      <div className="card">
        <div className="card-label">Open library · live discovery</div>
        <p style={{ color: "var(--muted)", fontSize: ".9rem", marginBottom: "1rem" }}>
          Files you open here are listed for everyone in this room session.
          Data never leaves the owner's browser until a peer requests a transfer.
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
          onDrop={handleLibDrop}
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
          <strong>Open files to the room library</strong>
          <span>Drop or click — visible to peers in this browser session only</span>
        </label>

        <div className="form-row">
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name, owner, type…"
            aria-label="Filter shared library"
          />
        </div>

        {filteredLibrary.length === 0 ? (
          <p className="empty">No files in the live library yet. Open a few to start discovery.</p>
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
                      {isMine ? " · you" : " · peer"} · {entry.mimeType.split("/")[0] || "file"}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: ".4rem", flexShrink: 0 }}>
                    <button
                      type="button"
                      className="btn-ghost btn-sm"
                      onClick={() => requestSharedFile(entry)}
                    >
                      {isMine ? "Save" : "Request"}
                    </button>
                    {isMine && (
                      <button
                        type="button"
                        className="btn-ghost btn-sm"
                        onClick={() => unshare(entry.shareId)}
                        style={{ color: "var(--err)" }}
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

        <p style={{ fontSize: ".72rem", color: "var(--muted)", marginTop: ".9rem" }}>
          {roomSharedFiles.length} file{roomSharedFiles.length === 1 ? "" : "s"} · session-scoped · no central server
        </p>
      </div>

      <div className="room-grid">
        <div className="card room-panel">
          <div className="card-label">Participants</div>
          <div className="peer-grid" aria-label="Room participants">
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
                  <small>{peer.status}</small>
                </button>
              );
            })}
          </div>
          <button className="btn-ghost btn-full" type="button" onClick={addDemoPeer}>
            Add test guest
          </button>
        </div>

        <div className="card room-panel">
          <div className="card-label">Direct send</div>
          <label
            className={`room-drop ${dragging ? "is-dragging" : ""} ${canSend ? "" : "is-disabled"}`}
            role="button"
            tabIndex={canSend ? 0 : -1}
            onDragOver={(event) => {
              event.preventDefault();
              if (canSend) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onKeyDown={handleDropKeyDown}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              disabled={!canSend}
              onChange={(event) => {
                if (event.currentTarget.files) queueFiles(event.currentTarget.files);
                event.currentTarget.value = "";
              }}
            />
            <strong>{canSend ? `Drop files for ${selectedPeer?.displayName}` : "Invite or add a guest first"}</strong>
            <span>Point-to-point transfer to one peer (not listed in the open library).</span>
          </label>
          <div className="room-transfer-list">
            {roomTransfers.length === 0 ? (
              <p className="empty">No direct transfer yet.</p>
            ) : (
              roomTransfers.slice(0, 5).map((transfer) => (
                <div key={transfer.transferId} className="room-transfer-row">
                  <span>{transfer.fileNameCiphertext}</span>
                  <strong>{formatBytes(transfer.fileSize)}</strong>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="card room-panel room-chat">
          <div className="card-label">Room chat</div>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={500}
            placeholder="Write a short note for people in this room..."
          />
          <button className="btn-primary btn-full" type="button" onClick={sendMessage}>
            Send message
          </button>
          <div className="room-messages">
            {messages.slice(0, 6).map((message) => (
              <p key={message.id}>
                <strong>{message.author}</strong>
                <span>{message.text}</span>
              </p>
            ))}
          </div>
        </div>
      </div>

      <div className="info-box room-footnote">
        <span>
          Transport: {net.connected ? "advanced network available" : "browser-first mode"}.
          Open library is session-only — close the tab and shares disappear. Wire WebRTC signaling next for multi-tab live sync.
        </span>
      </div>
    </section>
  );
}
