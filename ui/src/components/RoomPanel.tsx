/**
 * RoomPanel — redesigned navigation
 * Lobby (create/join/configure) → Inside hub with sub-tabs:
 * Library | People | Send | Chat | Invite
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

type RoomPhase = "lobby" | "inside";
type RoomHubTab = "library" | "people" | "send" | "chat" | "invite";

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
      <path
        d="M3 12h18M12 3c2.5 2.8 4 6 4 9s-1.5 6.2-4 9c-2.5-2.8-4-6-4-9s1.5-6.2 4-9z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
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

const HUB_TABS: Array<{ id: RoomHubTab; label: string; short: string }> = [
  { id: "library", label: "Bibliothèque", short: "Lib" },
  { id: "people", label: "Participants", short: "Pairs" },
  { id: "send", label: "Envoi direct", short: "Envoi" },
  { id: "chat", label: "Chat", short: "Chat" },
  { id: "invite", label: "Invitation", short: "Lien" },
];

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

  const [phase, setPhase] = useState<RoomPhase>(roomId && inviteCode ? "inside" : "lobby");
  const [hubTab, setHubTab] = useState<RoomHubTab>("library");
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
      text: "Bienvenue dans le salon. Partagez la bibliothèque ou envoyez en direct à un pair.",
    },
  ]);

  const localPeer = localPeerRef.current;
  const publicExpired = roomKind === "public" && roomExpiresAtMs > 0 && Date.now() > roomExpiresAtMs;

  useEffect(() => {
    if (roomId && inviteCode) setPhase("inside");
  }, [roomId, inviteCode]);

  useEffect(() => {
    if (roomKind !== "public" || !roomExpiresAtMs) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [roomKind, roomExpiresAtMs]);

  useEffect(() => {
    discoveryRef.current?.stop();
    discoveryRef.current = null;
    setDiscoveryState("off");
    if (!roomId || !inviteCode || phase !== "inside") return;

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
                text: `Bloqué ${peer.displayName} — contact hors liste privée`,
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
            text: `${peer.displayName} a rejoint`,
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
  }, [roomId, inviteCode, phase]);

  const visiblePeers = useMemo(() => {
    if (!peers.length) return [localPeer];
    return peers.some((p) => p.peerId === localPeer.peerId) ? peers : [localPeer, ...peers];
  }, [peers, localPeer]);

  const remotePeers = visiblePeers.filter((p) => p.peerId !== localPeer.peerId);
  const selectedPeer = visiblePeers.find((p) => p.peerId === selectedPeerId);
  const canSend = Boolean(roomId && selectedPeer && selectedPeer.peerId !== localPeer.peerId && !publicExpired);
  const inviteUrl = roomId && inviteCode ? roomInviteLink(roomId, inviteCode, roomKind) : "";

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

  const enterRoom = () => {
    if (roomKind === "private" && roomAllowedContacts.length === 0) {
      setMessages((prev) => [
        {
          id: crypto.randomUUID?.() ?? `${Date.now()}`,
          author: "System",
          text: "Salon privé : ajoutez au moins un contact avant d’entrer.",
        },
        ...prev,
      ]);
      return;
    }
    ensureRoom(roomKind);
    setPhase("inside");
    setHubTab("library");
  };

  const leaveRoom = () => {
    discoveryRef.current?.stop();
    discoveryRef.current = null;
    setDiscoveryState("off");
    setPhase("lobby");
    setHubTab("library");
  };

  const copyInvite = async () => {
    if (roomKind === "private" && roomAllowedContacts.length === 0) {
      setMessages((prev) => [
        {
          id: crypto.randomUUID?.() ?? `${Date.now()}`,
          author: "System",
          text: "Salon privé : ajoutez un contact avant de partager l’invitation.",
        },
        ...prev,
      ]);
    }
    const room = roomId && inviteCode ? { roomId, inviteCode } : ensureRoom();
    const link = roomInviteLink(room.roomId, room.inviteCode, roomKind);
    try {
      await navigator.clipboard?.writeText(link);
    } catch {
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

  /* ── LOBBY ─────────────────────────────────────────────── */
  if (phase === "lobby") {
    return (
      <section className="room-shell panel-enter">
        <div className="card room-hero">
          <div>
            <div className="card-label">Salons</div>
            <h1>Créer ou rejoindre un salon</h1>
            <p>
              Configurez un salon <strong>privé</strong> (cadenas + contacts) ou <strong>public</strong>{" "}
              (bibliothèque ouverte pour une durée), puis entrez dans le hub.
            </p>
          </div>
        </div>

        <div className="card">
          <div className="card-label">Type de salon</div>
          <div className="room-type-grid">
            <button
              type="button"
              className={`room-type-card ${roomKind === "private" ? "is-active" : ""}`}
              onClick={() => setRoomKind("private")}
            >
              <PadlockIcon size={28} />
              <strong>Privé</strong>
              <span>Contacts sélectionnés + code d’invitation</span>
            </button>
            <button
              type="button"
              className={`room-type-card ${roomKind === "public" ? "is-active" : ""}`}
              onClick={() => setRoomKind("public")}
            >
              <GlobeIcon size={28} />
              <strong>Public</strong>
              <span>Bibliothèque ouverte pour une durée choisie</span>
            </button>
          </div>

          {roomKind === "private" ? (
            <div style={{ marginTop: "1.1rem" }}>
              <div className="info-box">
                <span>
                  <PadlockIcon size={16} /> Accès limité aux contacts ci-dessous + code d’invitation.
                </span>
              </div>
              <div className="form-row">
                <label className="form-label">Ajouter un contact (email ou +tél)</label>
                <div style={{ display: "flex", gap: ".5rem" }}>
                  <input
                    type="text"
                    value={contactDraft}
                    onChange={(e) => setContactDraft(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addAllowedContact(contactDraft)}
                    placeholder="alice@example.com ou +33612345678"
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
                    Ajouter
                  </button>
                </div>
              </div>

              {addressBook.length > 0 && (
                <div className="form-row">
                  <label className="form-label">Depuis le carnet</label>
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
                  Aucun contact — ajoutez email / téléphone pour verrouiller le salon.
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
                        Retirer
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
                  <GlobeIcon size={16} /> Toute personne avec le lien voit la bibliothèque jusqu’à expiration.
                </span>
              </div>
              <div className="form-row">
                <label className="form-label">Durée de visibilité</label>
                <select
                  value={roomDurationKey}
                  onChange={(e) => setRoomDurationKey(e.target.value as RoomDurationKey)}
                >
                  <option value="1h">1 heure</option>
                  <option value="6h">6 heures</option>
                  <option value="24h">24 heures</option>
                  <option value="7d">7 jours</option>
                  <option value="30d">30 jours</option>
                  <option value="session">Session navigateur uniquement</option>
                </select>
              </div>
            </div>
          )}

          <button className="btn-primary btn-full" type="button" style={{ marginTop: "1.2rem" }} onClick={enterRoom}>
            Entrer dans le salon
          </button>

          {roomId && inviteCode && (
            <button
              className="btn-ghost btn-full"
              type="button"
              style={{ marginTop: ".6rem" }}
              onClick={() => setPhase("inside")}
            >
              Reprendre le salon en cours
            </button>
          )}
        </div>
      </section>
    );
  }

  /* ── INSIDE HUB ────────────────────────────────────────── */
  return (
    <section className="room-shell panel-enter">
      <div className="room-toolbar card">
        <div className="room-toolbar-main">
          <span className="room-kind-badge">
            {roomKind === "private" ? <PadlockIcon size={16} /> : <GlobeIcon size={16} />}
            {roomKind === "private" ? "Privé" : "Public"}
          </span>
          <div className="room-toolbar-meta">
            <strong>{roomId || "Salon"}</strong>
            <small>
              Discovery {discoveryState}
              {" · "}
              {remotePeers.length} pair(s)
              {roomKind === "public" ? ` · ${formatExpiry(roomExpiresAtMs)}` : ""}
              {nowTick ? "" : ""}
              {" · "}
              {net.connected ? "réseau avancé" : "navigateur"}
            </small>
          </div>
        </div>
        <div className="room-toolbar-actions">
          <button type="button" className="btn-ghost btn-sm" onClick={copyInvite}>
            {copied ? "✓ Copié" : "Copier le lien"}
          </button>
          <button type="button" className="btn-ghost btn-sm" onClick={leaveRoom}>
            Quitter
          </button>
        </div>
      </div>

      <nav className="room-hub-tabs" aria-label="Navigation du salon">
        {HUB_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={hubTab === tab.id ? "active" : ""}
            onClick={() => setHubTab(tab.id)}
            aria-current={hubTab === tab.id ? "page" : undefined}
          >
            <span className="room-hub-label">{tab.label}</span>
            <span className="room-hub-short">{tab.short}</span>
            {tab.id === "library" && roomSharedFiles.length > 0 && (
              <span className="room-hub-count">{roomSharedFiles.length}</span>
            )}
            {tab.id === "people" && remotePeers.length > 0 && (
              <span className="room-hub-count">{remotePeers.length}</span>
            )}
            {tab.id === "send" && roomTransfers.length > 0 && (
              <span className="room-hub-count">{Math.min(roomTransfers.length, 9)}</span>
            )}
          </button>
        ))}
      </nav>

      {hubTab === "library" && (
        <div className="card room-panel">
          <div className="card-label">
            {roomKind === "public" ? "Bibliothèque publique" : "Bibliothèque partagée"}
          </div>
          {publicExpired ? (
            <div className="warn-box">Ce salon public a expiré. Bibliothèque masquée.</div>
          ) : (
            <>
              <p style={{ color: "var(--muted)", fontSize: ".9rem", marginBottom: "1rem" }}>
                Catalogue live — les octets restent locaux jusqu’à une demande de transfert.
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
                <strong>Ouvrir des fichiers dans la bibliothèque</strong>
                <span>
                  {roomKind === "public"
                    ? "Visibles avec le lien pendant la durée choisie"
                    : "Visibles uniquement par les contacts autorisés"}
                </span>
              </label>
              <div className="form-row">
                <input
                  type="search"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filtrer par nom, propriétaire, type…"
                />
              </div>
              {filteredLibrary.length === 0 ? (
                <p className="empty">Aucun fichier dans la bibliothèque.</p>
              ) : (
                <div className="room-transfer-list">
                  {filteredLibrary.map((entry) => {
                    const isMine = entry.ownerId === localPeer.peerId;
                    return (
                      <div key={entry.shareId} className="room-transfer-row" style={{ alignItems: "center" }}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div
                            style={{
                              fontWeight: 600,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {entry.fileName}
                          </div>
                          <div style={{ fontSize: ".72rem", color: "var(--muted)" }}>
                            {formatBytes(entry.fileSize)} · {entry.ownerName}
                            {isMine ? " · vous" : " · pair"}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: ".4rem" }}>
                          <button type="button" className="btn-ghost btn-sm" onClick={() => requestSharedFile(entry)}>
                            {isMine ? "Sauver" : "Demander"}
                          </button>
                          {isMine && (
                            <button
                              type="button"
                              className="btn-ghost btn-sm"
                              style={{ color: "var(--err)" }}
                              onClick={() => unshare(entry.shareId)}
                            >
                              Retirer
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
      )}

      {hubTab === "people" && (
        <div className="card room-panel">
          <div className="card-label">Participants</div>
          <div className="peer-grid">
            {visiblePeers.map((peer) => {
              const selected = selectedPeerId === peer.peerId;
              return (
                <button
                  key={peer.peerId}
                  type="button"
                  onClick={() => {
                    setSelectedPeerId(peer.peerId);
                    if (peer.peerId !== localPeer.peerId) setHubTab("send");
                  }}
                  className={selected ? "btn-primary peer-card" : "btn-ghost peer-card"}
                >
                  <span className="peer-avatar">{roomAvatarInitials(peer.displayName, peer.peerId)}</span>
                  <strong>{peer.displayName}</strong>
                  <small>{peer.peerId === localPeer.peerId ? "vous" : peer.status}</small>
                </button>
              );
            })}
          </div>
          {remotePeers.length === 0 && (
            <p className="empty">En attente de pairs… partagez le lien d’invitation.</p>
          )}
        </div>
      )}

      {hubTab === "send" && (
        <div className="card room-panel">
          <div className="card-label">Envoi direct</div>
          {remotePeers.length > 0 && (
            <div className="form-row">
              <label className="form-label">Destinataire</label>
              <select
                value={selectedPeerId}
                onChange={(e) => setSelectedPeerId(e.target.value)}
              >
                <option value="">Choisir un pair…</option>
                {remotePeers.map((p) => (
                  <option key={p.peerId} value={p.peerId}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </div>
          )}
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
            <strong>
              {canSend ? `Déposer pour ${selectedPeer?.displayName}` : "Sélectionnez un pair distant"}
            </strong>
            <span>Transfert point à point</span>
          </label>
          <div className="room-transfer-list" style={{ marginTop: "1rem" }}>
            {roomTransfers.slice(0, 8).map((t) => (
              <div key={t.transferId} className="room-transfer-row">
                <span>{t.fileNameCiphertext}</span>
                <strong>{formatBytes(t.fileSize)}</strong>
              </div>
            ))}
            {roomTransfers.length === 0 && <p className="empty">Aucun transfert en file.</p>}
          </div>
        </div>
      )}

      {hubTab === "chat" && (
        <div className="card room-panel">
          <div className="card-label">Chat du salon</div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={500}
            placeholder="Note pour le salon…"
          />
          <button
            className="btn-primary btn-full"
            type="button"
            style={{ marginTop: ".6rem" }}
            onClick={() => {
              const text = sanitizeRoomText(draft.trim(), 500);
              if (!text) return;
              setMessages([{ id: `${Date.now()}`, author: "Vous", text }, ...messages]);
              setDraft("");
            }}
          >
            Envoyer
          </button>
          <div className="room-messages">
            {messages.slice(0, 12).map((m) => (
              <p key={m.id}>
                <strong>{m.author}</strong>
                <span>{m.text}</span>
              </p>
            ))}
          </div>
        </div>
      )}

      {hubTab === "invite" && (
        <div className="card room-panel">
          <div className="card-label" style={{ display: "flex", alignItems: "center", gap: ".4rem" }}>
            {roomKind === "private" ? <PadlockIcon size={14} /> : <GlobeIcon size={14} />}
            Invitation · {roomKind === "private" ? "privé" : "public"}
          </div>
          <p className="room-summary" style={{ marginBottom: "1rem" }}>
            Partagez ce lien pour faire rejoindre le salon.
            {roomKind === "private" && ` ${roomAllowedContacts.length} contact(s) autorisé(s).`}
          </p>
          <div style={{ display: "flex", gap: ".5rem", alignItems: "center", width: "100%" }}>
            <input
              readOnly
              value={inviteUrl || "Salon non créé"}
              aria-label="Lien d’invitation"
              onFocus={(e) => e.currentTarget.select()}
              style={{ flex: 1, minWidth: 0, fontFamily: "monospace", fontSize: ".82rem" }}
            />
            <button
              type="button"
              className={copied ? "btn-success" : "btn-primary"}
              onClick={copyInvite}
              style={{ flexShrink: 0, whiteSpace: "nowrap", minWidth: 110 }}
            >
              {copied ? "✓ Copié" : "Copier"}
            </button>
          </div>

          {roomKind === "private" && roomAllowedContacts.length > 0 && (
            <div className="room-transfer-list" style={{ marginTop: "1rem" }}>
              {roomAllowedContacts.map((c) => (
                <div key={c.contact} className="room-transfer-row">
                  <span style={{ display: "inline-flex", alignItems: "center", gap: ".4rem" }}>
                    <PadlockIcon size={14} /> {c.contact}
                  </span>
                </div>
              ))}
            </div>
          )}

          <button className="btn-ghost btn-full" type="button" style={{ marginTop: "1rem" }} onClick={leaveRoom}>
            Retour au lobby / modifier la config
          </button>
        </div>
      )}
    </section>
  );
}
