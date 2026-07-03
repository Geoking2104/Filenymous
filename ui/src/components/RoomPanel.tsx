import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { createInviteCode, roomAvatarInitials, sanitizeRoomText } from "../rooms/roomModel";
import type { RoomPeer, RoomTransferRequest } from "../rooms/types";
import { useStore } from "../store/useStore";

const localPeer: RoomPeer = {
  peerId: "local",
  displayName: "You",
  avatarSeed: "local",
  status: "online",
  lastSeenMs: Date.now(),
  expiresAtMs: Date.now() + 60_000,
};

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

export default function RoomPanel() {
  const {
    net,
    roomId,
    inviteCode,
    peers,
    roomTransfers,
    setRoom,
    setPeers,
    setRoomTransfers,
  } = useStore();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedPeerId, setSelectedPeerId] = useState("");
  const [draft, setDraft] = useState("");
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const [messages, setMessages] = useState<Array<{ id: string; author: string; text: string }>>([
    {
      id: "welcome",
      author: "Filenymous",
      text: "Create a room, share the invite link, then keep this tab open while people exchange files.",
    },
  ]);

  const visiblePeers = useMemo(() => (peers.length ? peers : [localPeer]), [peers]);
  const remotePeers = visiblePeers.filter((peer) => peer.peerId !== localPeer.peerId);
  const selectedPeer = visiblePeers.find((peer) => peer.peerId === selectedPeerId);
  const canSend = Boolean(roomId && selectedPeer && selectedPeer.peerId !== localPeer.peerId);
  const inviteUrl = roomId && inviteCode ? roomInviteLink(roomId, inviteCode) : "";

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

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!canSend) return;
    queueFiles(event.dataTransfer.files);
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
          <h1>Create a private room for a group</h1>
          <p>
            One temporary room, one invite link, many files. The browser keeps the room key local and the advanced
            network modules stay behind the scenes.
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
            {roomId ? "Room ready. Share this link and keep this page open." : "Create a room to generate an invite link."}
          </p>
        </div>
        <input
          readOnly
          value={inviteUrl || "No room created yet"}
          aria-label="Room invite link"
          onFocus={(event) => event.currentTarget.select()}
        />
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
          <div className="card-label">Files</div>
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
            <span>Large files stay in direct-transfer mode when the network path is available.</span>
          </label>
          <div className="room-transfer-list">
            {roomTransfers.length === 0 ? (
              <p className="empty">No room file yet.</p>
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
            {messages.slice(0, 5).map((message) => (
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
          Room transport status: {net.connected ? "advanced network available" : "browser-first mode"}. Network
          details and relay settings are managed in Advanced.
        </span>
      </div>
    </section>
  );
}
