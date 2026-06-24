import { useMemo, useState } from "react";
import { createInviteCode, roomAvatarInitials, sanitizeRoomText } from "../rooms/roomModel";
import type { RoomPeer, RoomTransferRequest } from "../rooms/types";
import { useStore } from "../store/useStore";

const localPeer: RoomPeer = {
  peerId: "local",
  displayName: "Vous",
  avatarSeed: "local",
  status: "online",
  lastSeenMs: Date.now(),
  expiresAtMs: Date.now() + 60_000,
};

function createRoomId(): string {
  return `room-${crypto.randomUUID?.() ?? createInviteCode().replace(/-/g, "").toLowerCase()}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

function requestFromFile(file: File, roomId: string, peer: RoomPeer): RoomTransferRequest {
  const now = Date.now();
  return {
    transferId: `transfer-${now}`,
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
  const [selectedPeerId, setSelectedPeerId] = useState("");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<Array<{ id: string; author: string; text: string }>>([]);

  const activeRoomId = roomId || "room-preview";
  const visiblePeers = useMemo(() => (peers.length ? peers : [localPeer]), [peers]);
  const remotePeers = visiblePeers.filter((peer) => peer.peerId !== localPeer.peerId);
  const selectedPeer = visiblePeers.find((peer) => peer.peerId === selectedPeerId);
  const canSend = Boolean(selectedPeer && selectedPeer.peerId !== localPeer.peerId);

  const ensureRoom = () => {
    const nextRoomId = roomId || createRoomId();
    setRoom({ roomId: nextRoomId, inviteCode: inviteCode || createInviteCode() });
    if (!peers.length) setPeers([localPeer]);
  };

  const addDemoPeer = () => {
    ensureRoom();
    const demoPeer: RoomPeer = {
      peerId: "peer-demo",
      displayName: "Pair invite",
      avatarSeed: "demo",
      status: "online",
      lastSeenMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    };
    setPeers([...visiblePeers.filter((peer) => peer.peerId !== demoPeer.peerId), demoPeer]);
    setSelectedPeerId(demoPeer.peerId);
  };

  const queueFile = (file: File | null) => {
    if (!file || !selectedPeer) return;
    ensureRoom();
    setRoomTransfers([requestFromFile(file, activeRoomId, selectedPeer), ...roomTransfers]);
  };

  const sendMessage = () => {
    const text = sanitizeRoomText(draft.trim(), 500);
    if (!text) return;
    setMessages([{ id: crypto.randomUUID?.() ?? `${Date.now()}`, author: "Vous", text }, ...messages]);
    setDraft("");
  };

  return (
    <section style={{ display: "grid", gap: "1rem" }}>
      <div className="card" style={{ borderRadius: 8, marginBottom: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "center" }}>
          <div>
            <div className="card-label">Room Filenymous</div>
            <h1 style={{ fontSize: "1.35rem", lineHeight: 1.2, marginBottom: ".35rem" }}>Transfert direct anonyme</h1>
            <p style={{ color: "var(--muted)", fontSize: ".9rem" }}>
              {net.connected ? "Holochain actif" : "Mode web local"}
            </p>
          </div>
          <button className="btn-primary" onClick={ensureRoom}>Créer</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: ".75rem", marginTop: "1rem" }}>
          <input readOnly value={inviteCode || "Aucun code"} aria-label="Code invitation room" />
          <button className="btn-ghost" onClick={addDemoPeer}>Pair test</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.2fr) minmax(280px, .8fr)", gap: "1rem" }}>
        <div className="card" style={{ borderRadius: 8, marginBottom: 0 }}>
          <div className="card-label">Pairs</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(128px,1fr))", gap: ".75rem" }}>
            {visiblePeers.map((peer) => {
              const selected = selectedPeerId === peer.peerId;
              return (
                <button
                  key={peer.peerId}
                  onClick={() => setSelectedPeerId(peer.peerId)}
                  className={selected ? "btn-primary" : "btn-ghost"}
                  style={{ minHeight: 112, borderRadius: 8, display: "grid", placeItems: "center", gap: ".35rem" }}
                >
                  <span
                    style={{
                      width: 48,
                      height: 48,
                      borderRadius: "50%",
                      display: "grid",
                      placeItems: "center",
                      background: selected ? "rgba(255,255,255,.24)" : "#e0f2fe",
                      color: selected ? "#fff" : "#075985",
                      fontWeight: 800,
                    }}
                  >
                    {roomAvatarInitials(peer.displayName, peer.peerId)}
                  </span>
                  <span>{peer.displayName}</span>
                  <span style={{ fontSize: ".72rem", opacity: .75 }}>{peer.status}</span>
                </button>
              );
            })}
          </div>

          <label
            style={{
              marginTop: "1rem",
              minHeight: 136,
              border: "1.5px dashed var(--border)",
              borderRadius: 8,
              display: "grid",
              placeItems: "center",
              textAlign: "center",
              color: canSend ? "var(--text)" : "var(--muted)",
              background: canSend ? "#f0fdf4" : "#f8fafc",
            }}
          >
            <input
              type="file"
              disabled={!canSend}
              onChange={(event) => queueFile(event.currentTarget.files?.[0] ?? null)}
              style={{ display: "none" }}
            />
            <span style={{ fontWeight: 700 }}>
              {canSend ? `Envoyer vers ${selectedPeer?.displayName}` : "Sélectionnez un pair distant"}
            </span>
          </label>
        </div>

        <div style={{ display: "grid", gap: "1rem" }}>
          <div className="card" style={{ borderRadius: 8, marginBottom: 0 }}>
            <div className="card-label">Mini-chat</div>
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={500} />
            <button className="btn-primary btn-full" style={{ marginTop: ".65rem" }} onClick={sendMessage}>
              Envoyer
            </button>
            <div style={{ display: "grid", gap: ".45rem", marginTop: ".85rem" }}>
              {messages.slice(0, 4).map((message) => (
                <div key={message.id} style={{ borderTop: "1px solid var(--border)", paddingTop: ".45rem" }}>
                  <strong>{message.author}</strong> <span dangerouslySetInnerHTML={{ __html: message.text }} />
                </div>
              ))}
            </div>
          </div>

          <div className="card" style={{ borderRadius: 8, marginBottom: 0 }}>
            <div className="card-label">Demandes</div>
            {roomTransfers.length === 0 ? (
              <div className="empty" style={{ padding: "1rem" }}>Aucune demande</div>
            ) : (
              roomTransfers.slice(0, 4).map((transfer) => (
                <div key={transfer.transferId} style={{ display: "flex", justifyContent: "space-between", gap: ".75rem", padding: ".45rem 0", borderTop: "1px solid var(--border)" }}>
                  <span>{transfer.fileNameCiphertext}</span>
                  <span className="badge badge-pending">{formatBytes(transfer.fileSize)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {remotePeers.length === 0 && (
        <div className="warn-box" style={{ marginBottom: 0 }}>
          <span>!</span>
          <span>En ligne, les pairs réels apparaîtront via Holochain/HWC ou signal direct. Le pair test simule le flux local.</span>
        </div>
      )}
    </section>
  );
}
