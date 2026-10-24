/** Page-side RPC client for the vault worker. The page never holds the vault keys. */
import type { ConflictInfo, Envelope, ItemData, ItemFields, ItemSummary, Outgoing, Peer, ReceiveResult, Role, SecurityReport, VaultSettings, VaultStatus, VersionInfo } from "./types";

type Pending = { ok: (v: unknown) => void; ko: (e: Error) => void };

export class SafeClient {
  private worker: Worker;
  private seq = 0;
  private wait = new Map<number, Pending>();

  constructor() {
    this.worker = new Worker(new URL("./safe.worker.ts", import.meta.url), { type: "module", name: "fny-safe" });
    this.worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
      const w = this.wait.get(e.data.id);
      if (!w) return;
      this.wait.delete(e.data.id);
      if (e.data.ok) w.ok(e.data.result);
      else w.ko(new Error(e.data.error || "error"));
    };
    this.worker.onerror = (e) => {
      for (const w of this.wait.values()) w.ko(new Error(e.message || "worker-crashed"));
      this.wait.clear();
    };
  }

  call<T>(op: string, ...args: unknown[]): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((ok, ko) => {
      this.wait.set(id, { ok: ok as (v: unknown) => void, ko });
      this.worker.postMessage({ id, op, args });
    });
  }

  status = () => this.call<VaultStatus>("status");
  create = (input: { password?: string; passkey?: { credId: string; salt: string; prf: Uint8Array } }) => this.call<{ phrase: string }>("create", input);
  checkPhrase = (answers: { pos: number; word: string }[]) => this.call<boolean>("checkPhrase", answers);
  unlockPassword = (pw: string) => this.call<boolean>("unlockPassword", pw);
  unlockPasskey = (prf: Uint8Array) => this.call<boolean>("unlockPasskey", prf);
  unlockPhrase = (phrase: string) => this.call<boolean>("unlockPhrase", phrase);
  setPassword = (pw: string) => this.call<void>("setPassword", pw);
  addPasskey = (credId: string, salt: string, prf: Uint8Array) => this.call<void>("addPasskey", credId, salt, prf);
  removePasskey = () => this.call<void>("removePasskey");
  hasPassword = () => this.call<boolean>("hasPassword");
  lock = () => this.call<void>("lock");
  identity = () => this.call<{ handle: string; card: string; inboxSecret: string }>("identity");
  list = () => this.call<ItemSummary[]>("list");
  get = (id: string) => this.call<ItemData>("get", id);
  secret = (id: string, field: "password" | "apiKey" | "username" | "url") => this.call<string>("secret", id, field);
  put = (id: string | null, fields: ItemFields, file?: { name: string; type: string; bytes: Uint8Array }) => this.call<string>("put", id, fields, file);
  remove = (id: string) => this.call<void>("remove", id);
  versions = (id: string) => this.call<VersionInfo[]>("versions", id);
  getVersion = (id: string, v: number) => this.call<ItemData>("getVersion", id, v);
  restoreVersion = (id: string, v: number) => this.call<void>("restoreVersion", id, v);
  readFile = (id: string) => this.call<{ name: string; type: string; bytes: Uint8Array }>("readFile", id);
  embeddingTodo = () => this.call<{ id: string; text: string }[]>("embeddingTodo");
  setEmbedding = (id: string, v: Float32Array) => this.call<void>("setEmbedding", id, v);
  search = (q: string, v: Float32Array | null) => this.call<{ id: string; score: number; fts: number; cosine: number | null }[]>("search", q, v);
  peers = () => this.call<Peer[]>("peers");
  addPeer = (card: string, alias: string) => this.call<Peer>("addPeer", card, alias);
  removePeer = (peerId: string) => this.call<void>("removePeer", peerId);
  buildShare = (id: string, peerId: string, role: Role, expiresAt?: number) => this.call<Outgoing>("buildShare", id, peerId, role, expiresAt);
  recordGrant = (id: string, peerId: string, role: Role, expiresAt?: number) => this.call<void>("recordGrant", id, peerId, role, expiresAt);
  buildUpdates = (id: string) => this.call<Outgoing[]>("buildUpdates", id);
  receive = (env: Envelope) => this.call<ReceiveResult>("receive", env);
  pendingShares = () => this.call<{ pendingId: string; from: string; title: string; card: string }[]>("pendingShares");
  acceptPending = (pendingId: string, alias: string) => this.call<string>("acceptPending", pendingId, alias);
  declinePending = (pendingId: string) => this.call<void>("declinePending", pendingId);
  conflicts = (id: string) => this.call<ConflictInfo[]>("conflicts", id);
  resolve = (id: string, choice: { keep: "local" } | { keep: "remote"; conflictId: string } | { keep: "manual"; fields: ItemFields }) => this.call<void>("resolve", id, choice);
  purgeExpired = () => this.call<string[]>("purgeExpired");
  security = () => this.call<SecurityReport>("security");
  passwordSha1 = (id: string) => this.call<string>("passwordSha1", id);
  setSettings = (s: Partial<VaultSettings>) => this.call<VaultSettings>("setSettings", s);
  exportBackup = () => this.call<Uint8Array>("exportBackup");
  importBackup = (bytes: Uint8Array) => this.call<void>("importBackup", bytes);
  destroyVault = () => this.call<void>("destroyVault");

  dispose() {
    this.worker.terminate();
    for (const w of this.wait.values()) w.ko(new Error("disposed"));
    this.wait.clear();
  }
}
