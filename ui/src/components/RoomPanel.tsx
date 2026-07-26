/**
 * RoomPanel — private room + live open shared library + P2P discovery
 */

import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import {
  createLocalRoomPeer,
  RoomDiscovery,
} from "../rooms/discovery";
import { createInviteCode, roomAvatarInitials, sanitizeRoomText } from "../rooms/roomModel";
import type { RoomPeer, RoomSharedFile, RoomTransferRequest } from "../rooms/types";
import { useStore } from "../store/useStore";

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
    peers,
    roomTransfers,
    roomSharedFiles,
    setRoom,
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
  const [discoveryState, setDiscoveryState] = useState<"off" | "live">("off");
  const [messages, setMessages] = useState<Array<{ id: string; author: string; text: string }>>([
    {
      id: "welcome",
      author: "Filenymous",
      text: "Create a room, share the invite. P2P discovery joins other tabs on this origin automatically — no plugin.",
    },
  ]);

  const localPeer = localPeerRef.current;

  // Start / stop discovery when room credentials change
  useEffect(() => {
    discoveryRef.current?.stop();
    discoveryRef.current = null;
    setDiscoveryState("off");

    if (!roomId || !inviteCode) return;

    const discovery = new RoomDiscovery(roomId, inviteCode, localPeer, {
      onPeerJoin: (peer) => {
        setPeers((prev) => {
          // useStore setPeers expects full array — merge carefully via getState pattern
          const current = useStore.getState().peers;
          const without = current.filter((p) => p.peerId !== peer.peerId && p.peerId !== localPeer.peerId);
          return [localPeer, peer, ...without];
        });
        setMessages((prev) => [
          {
            id: crypto.randomUUID?.() ?? `${Date.now()}`,
            author: "System",
            text: `${peer.displayName} joined via P2P discovery`,
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
        const current = useStore.getState().peers;
        setPeers(current.filter((p) => p.peerId !== peerId));
        // Drop library entries owned by that peer
        const files = useStore.getState().roomSharedFiles.filter((f) => f.ownerId !== peerId);
        setRoomSharedFiles(files);
        setMessages((prev) => [
          {
            id: crypto.randomUUID?.() ?? `${Date.now()}`,
            author: "System",
            text: `Peer ${peerId.slice(0, 12)}… left`,
          },
          ...prev,
        ]);
      },
      onLibrarySync: (peerId, files, mode) => {
        const current = useStore.getState().roomSharedFiles;
        if (mode === "full") {
          const others = current.filter((f) => f.ownerId !== peerId);
          setRoomSharedFiles([...files, ...others]);
        } else if (mode === "delta-add") {
          const ids = new Set(files.map((f) => f.shareId));
          setRoomSharedFiles([...files, ...current.filter((f) => !ids.has(f.shareId))]);
        } else if (mode === "delta-remove") {
          const remove = new Set(files.map((f) => f.shareId));
          setRoomSharedFiles(current.filter((f) => !remove.has(f.shareId)));
        }
      },
      onTransferAsk: (msg) => {
        setMessages((prev) => [
          {
            id: crypto.randomUUID?.() ?? `${Date.now()}`,
            author: "System",
            text: `Transfer request for «${msg.fileName}» from ${msg.fromPeerId.slice(0, 10)}…`,
          },
          ...prev,
        ]);
        const now = Date.now();
        const transfers = useStore.getState().roomTransfers;
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
          ...transfers,
        ]);
      },
    });

    discovery.start(useStore.getState().roomSharedFiles.filter((f) => f.ownerId === localPeer.peerId));
    discoveryRef.current = discovery;
    setDiscoveryState("live");

    // Ensure local peer is in the list
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
    const hasLocal = peers.some((p) => p.peerId === localPeer.peerId);
    return hasLocal ? peers : [localPeer, ...peers];
  }, [peers, localPeer]);

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

  const queueFiles = (files: FileList | File[]) => {
    const selected = selectedPeer ?? remotePeers[0];
    if (!selected) return;
    const room = ensureRoom();
    const requests = Array.from(files).map((file) =>
      requestFromFile(file, room.roomId, localPeer.peerId, selected),
    );
    setRoomTransfers([...requests, ...roomTransfers]);
  };

  const openToLibrary = (files: FileList | File[]) => {
    const room = ensureRoom();
    const entries = Array.from(files).map((file) => shareFromFile(file, room.roomId, localPeer));
    entries.forEach((e) => addRoomSharedFile(e));
    discoveryRef.current?.announceLibraryAdd(entries);
    setMessages((prev) => [
      {
        id: crypto.randomUUID?.() ?? `${Date.now()}`,
        author: "System",
        text: `${entries.length} file(s) announced on P2P discovery`,
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
    discoveryRef.current?.announceLibraryRemove([shareId]);
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
            P2P discovery (BroadcastChannel) finds other tabs on this origin sharing the same invite.
            Open files to the live library — peers see them without any plugin.
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
          <div className="card-label">Invite · discovery</div>
          <p className="room-summary">
            {roomId
              ? discoveryState === "live"
                ? `Discovery live · ${remotePeers.length} remote peer(s)`
                : "Room ready — starting discovery…"
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

      <div className="card">
        <div className="card-label">Open library · live discovery</div>
        <p style={{ color: "var(--muted)", fontSize: ".9rem", marginBottom: "1rem" }}>
          Files you open are announced on the discovery channel. Catalog only — bytes stay local until requested.
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
          <span>Announced to discovered peers · session-scoped</span>
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
          <p className="empty">No files in the live library yet.</p>
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
                    <button type="button" className="btn-ghost btn-sm" onClick={() => requestSharedFile(entry)}>
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
          {roomSharedFiles.length} file{roomSharedFiles.length === 1 ? "" : "s"} · discovery {discoveryState}
        </p>
      </div>

      <div className="room-grid">
        <div className="card room-panel">
          <div className="card-label">Participants · P2P</div>
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
                  <small>{peer.peerId === localPeer.peerId ? "you" : peer.status}</small>
                </button>
              );
            })}
          </div>
          <p style={{ fontSize: ".75rem", color: "var(--muted)", marginTop: ".6rem" }}>
            Open the same invite in another tab to see live join/leave.
          </p>
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
            <strong>{canSend ? `Drop files for ${selectedPeer?.displayName}` : "Select a remote peer first"}</strong>
            <span>Point-to-point (not listed in open library).</span>
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
            {messages.slice(0, 8).map((message) => (
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
          Discovery: {discoveryState === "live" ? "BroadcastChannel active" : "idle"} ·
          Network: {net.connected ? "advanced path available" : "browser-first"}.
          WebRTC DataChannel can plug into the same protocol via <code>sendExternal</code>.
        </span>
      </div>
    </section>
  );
}
