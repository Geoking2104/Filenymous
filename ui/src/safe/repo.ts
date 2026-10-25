/**
 * Coffre-fort storage + key lifecycle, on a SQLite database (sqlite-wasm,
 * opfs-sahpool VFS in the vault worker; an in-memory DB in unit tests).
 *
 * At rest, the database holds only: the KDF parameters, wrapped copies of
 * the vault DEK, and AES-256-GCM ciphertext (items, versions, file chunks,
 * conflicts, contacts, embeddings), plus ids, categories, version numbers
 * and timestamps. The FTS5 index of decrypted titles/tags lives in a
 * separate in-memory database, built at unlock and dropped at lock.
 */
import {
  B, SecureBuffer, aesOpen, aesSeal, b64u, chunkLeaf, concat, dec, decodeCard, decryptChunks, deriveKekBytes, enc, encodeCard, encryptChunks,
  entropyToPhrase, fromB64u, handleFor, hex, importAesKey, inboxIdFor, inboxSecret, keyFromBytes, merkleRoot, newIdentity, newKdfParams,
  newRecoveryEntropy, openJson, phraseToEntropy, prfKey, publicKeys, randomBytes, recoveryKey, sealJson, shareIv, shareKeyFromSender,
  shareKeyToRecipient, sign, unwrapDek, verify, wrapDek, type Identity, type KdfParams, type Sealed,
} from "./crypto";
import { compareClocks, mergeClocks, tick } from "./clock";
import { normaliseBm25, rankResults } from "./rank";
import { WEAK_BITS, estimateBits } from "./strength";
import {
  DEFAULT_SETTINGS, type ConflictInfo, type Envelope, type ItemData, type ItemFields, type ItemSummary, type Outgoing, type Peer,
  type ReceiveResult, type Role, type SecurityReport, type VaultSettings, type VaultStatus, type VersionInfo,
} from "./types";

export interface Db {
  exec(sql: string | { sql: string; bind?: unknown[] }): unknown;
  selectObjects(sql: string, bind?: unknown[]): Record<string, unknown>[];
  selectValue(sql: string, bind?: unknown[]): unknown;
  transaction<T>(cb: (db: Db) => T): T;
  close(): void;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY NOT NULL, v BLOB);
CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY NOT NULL,
  category TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  iv BLOB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  has_conflict INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS secret_versions (
  secret_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  ciphertext BLOB NOT NULL,
  iv BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (secret_id, version),
  FOREIGN KEY(secret_id) REFERENCES secrets(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS file_chunks (
  secret_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  iv BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  PRIMARY KEY (secret_id, idx),
  FOREIGN KEY(secret_id) REFERENCES secrets(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS secret_conflicts (
  conflict_id TEXT PRIMARY KEY NOT NULL,
  secret_id TEXT NOT NULL,
  author_key TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  iv BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(secret_id) REFERENCES secrets(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS p2p_peers (
  peer_id TEXT PRIMARY KEY NOT NULL,
  ciphertext BLOB NOT NULL,
  iv BLOB NOT NULL,
  trust_level INTEGER NOT NULL DEFAULT 1,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS embeddings (
  secret_id TEXT PRIMARY KEY NOT NULL,
  ciphertext BLOB NOT NULL,
  iv BLOB NOT NULL,
  FOREIGN KEY(secret_id) REFERENCES secrets(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_secrets_updated ON secrets(updated_at);
CREATE INDEX IF NOT EXISTS idx_conflicts_secret ON secret_conflicts(secret_id);
`;

const FTS_SCHEMA = `CREATE VIRTUAL TABLE IF NOT EXISTS secrets_fts USING fts5(secret_id UNINDEXED, title, tags, notes_summary, domain, tokenize = 'unicode61 remove_diacritics 2');`;

const FORMAT = "filenymous-safe/1";
const MAX_SHARE_AGE_MS = 30 * 86_400_000;
const MAX_VERSIONS = 50;

export interface VaultOptions {
  /** Override the Argon2id cost (unit tests only). */
  kdf?: Partial<Pick<KdfParams, "t" | "m" | "p">>;
  now?: () => number;
}

interface Unlocked {
  dek: CryptoKey;
  id: Identity;
  handle: string;
  card: string;
  inboxSecret: string;
  items: Map<string, ItemData>;
  vectors: Map<string, Float32Array>;
  usage: Record<string, number>;
  mem: Db;
}

interface PendingShare {
  from: string;
  card: string;
  itemId: string;
  data: ItemData;
  chunks: { iv: Uint8Array; ct: Uint8Array }[] | null;
  title: string;
}

const uuid = () => (typeof crypto.randomUUID === "function" ? crypto.randomUUID() : b64u(randomBytes(16)));
const u8 = (v: unknown) => (v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer));

export class VaultRepo {
  private u: Unlocked | null = null;
  private pendingPhrase: Uint8Array | null = null;
  private pending = new Map<string, PendingShare>();
  private needsNewPassword = false;
  private readonly now: () => number;

  constructor(private readonly db: Db, private readonly openMemory: () => Db, private readonly opts: VaultOptions = {}) {
    this.now = opts.now ?? Date.now;
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
  }

  /* ── meta helpers ── */
  private meta(k: string): Uint8Array | null {
    const v = this.db.selectValue("SELECT v FROM meta WHERE k = ?", [k]);
    if (v == null) return null;
    return typeof v === "string" ? enc.encode(v) : u8(v);
  }
  private metaText(k: string): string | null {
    const v = this.meta(k);
    return v ? dec.decode(v) : null;
  }
  private setMeta(k: string, v: Uint8Array | string | null) {
    if (v == null) this.db.exec({ sql: "DELETE FROM meta WHERE k = ?", bind: [k] });
    else this.db.exec({ sql: "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", bind: [k, typeof v === "string" ? enc.encode(v) : v] });
  }

  exists(): boolean {
    return this.metaText("format") === FORMAT;
  }

  settings(): VaultSettings {
    try {
      return { ...DEFAULT_SETTINGS, ...(JSON.parse(this.metaText("settings") || "{}") as Partial<VaultSettings>) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  setSettings(s: Partial<VaultSettings>): VaultSettings {
    const next = { ...this.settings(), ...s };
    next.autoLockMin = Math.min(120, Math.max(1, Math.round(Number(next.autoLockMin) || DEFAULT_SETTINGS.autoLockMin)));
    if (next.lastBackupAt !== undefined) {
      const at = Math.round(Number(next.lastBackupAt));
      if (Number.isFinite(at) && at > 0) next.lastBackupAt = at;
      else delete next.lastBackupAt;
    }
    this.setMeta("settings", JSON.stringify(next));
    return next;
  }

  status(): VaultStatus {
    const pk = this.metaText("passkey");
    return {
      exists: this.exists(),
      unlocked: !!this.u,
      passkey: pk ? (JSON.parse(pk) as { credId: string; salt: string }) : null,
      handle: this.u?.handle,
      card: this.u?.card,
      needsNewPassword: this.u ? this.needsNewPassword : undefined,
      settings: this.settings(),
    };
  }

  private need(): Unlocked {
    if (!this.u) throw new Error("locked");
    return this.u;
  }

  /* ── create / unlock / lock ── */

  /**
   * Creates the vault. Returns the 24-word recovery phrase (shown once); the
   * worker keeps its entropy only until `checkPhrase` succeeds.
   */
  async create(input: { password?: string; passkey?: { credId: string; salt: string; prf: Uint8Array } }): Promise<{ phrase: string }> {
    if (this.exists()) throw new Error("exists");
    if (!input.password && !input.passkey) throw new Error("no-method");
    const dekRaw = randomBytes(32);
    const entropy = newRecoveryEntropy();
    try {
      const rec = await recoveryKey(entropy);
      const id = newIdentity();
      const dek = await importAesKey(dekRaw);
      const rows: [string, Uint8Array | string][] = [
        ["format", FORMAT],
        ["created_at", String(this.now())],
        ["dek_rec", await wrapDek(rec, dekRaw, "recovery")],
        ["identity", packJson(await sealJson(dek, { ed: b64u(id.edSecret), x: b64u(id.xSecret) }, "identity"))],
        ["settings", JSON.stringify(DEFAULT_SETTINGS)],
      ];
      if (input.password) {
        const kdf = newKdfParams(this.opts.kdf);
        const kek = await keyFromBytes(await deriveKekBytes(input.password, kdf));
        rows.push(["kdf", JSON.stringify(kdf)], ["dek_pw", await wrapDek(kek, dekRaw, "password")]);
      }
      if (input.passkey) {
        const pkKey = await prfKey(input.passkey.prf);
        rows.push(["passkey", JSON.stringify({ credId: input.passkey.credId, salt: input.passkey.salt })], ["dek_pk", await wrapDek(pkKey, dekRaw, "passkey")]);
      }
      this.db.transaction(() => {
        for (const [k, v] of rows) this.setMeta(k, v);
      });
      await this.open(dekRaw);
      this.pendingPhrase = entropy.slice();
      return { phrase: entropyToPhrase(entropy) };
    } finally {
      SecureBuffer.wipe(dekRaw);
      SecureBuffer.wipe(entropy);
    }
  }

  /** Backup check: the 3 requested words (positions 0-based). Wipes the held entropy on success. */
  checkPhrase(answers: { pos: number; word: string }[]): boolean {
    if (!this.pendingPhrase) return true;
    const words = entropyToPhrase(this.pendingPhrase).split(" ");
    const ok = answers.length >= 3 && answers.every((a) => words[a.pos] === a.word.trim().toLowerCase());
    if (ok) {
      SecureBuffer.wipe(this.pendingPhrase);
      this.pendingPhrase = null;
    }
    return ok;
  }

  async unlockPassword(password: string): Promise<boolean> {
    const kdfText = this.metaText("kdf");
    const blob = this.meta("dek_pw");
    if (!kdfText || !blob) throw new Error("no-password");
    const kek = await keyFromBytes(await deriveKekBytes(password, JSON.parse(kdfText) as KdfParams));
    return this.tryUnwrap(kek, blob, "password");
  }

  async unlockPasskey(prf: Uint8Array): Promise<boolean> {
    const blob = this.meta("dek_pk");
    if (!blob) throw new Error("no-passkey");
    return this.tryUnwrap(await prfKey(prf), blob, "passkey");
  }

  /** Recovery: the phrase unwraps the DEK; the user must then set a new master password. */
  async unlockPhrase(phrase: string): Promise<boolean> {
    const blob = this.meta("dek_rec");
    if (!blob) throw new Error("no-recovery");
    let entropy: Uint8Array;
    try {
      entropy = phraseToEntropy(phrase);
    } catch {
      return false;
    }
    const ok = await this.tryUnwrap(await recoveryKey(entropy), blob, "recovery");
    if (ok) this.needsNewPassword = true;
    return ok;
  }

  private async tryUnwrap(key: CryptoKey, blob: Uint8Array, slot: string): Promise<boolean> {
    let raw: Uint8Array;
    try {
      raw = await unwrapDek(key, blob, slot);
    } catch {
      return false;
    }
    try {
      await this.open(raw);
    } finally {
      SecureBuffer.wipe(raw);
    }
    return true;
  }

  async setPassword(password: string): Promise<void> {
    const dekRaw = await this.exportDek();
    try {
      const kdf = newKdfParams(this.opts.kdf);
      const kek = await keyFromBytes(await deriveKekBytes(password, kdf));
      const wrapped = await wrapDek(kek, dekRaw, "password");
      this.db.transaction(() => {
        this.setMeta("kdf", JSON.stringify(kdf));
        this.setMeta("dek_pw", wrapped);
      });
      this.needsNewPassword = false;
    } finally {
      SecureBuffer.wipe(dekRaw);
    }
  }

  async addPasskey(credId: string, salt: string, prf: Uint8Array): Promise<void> {
    const dekRaw = await this.exportDek();
    try {
      const wrapped = await wrapDek(await prfKey(prf), dekRaw, "passkey");
      this.db.transaction(() => {
        this.setMeta("passkey", JSON.stringify({ credId, salt }));
        this.setMeta("dek_pk", wrapped);
      });
    } finally {
      SecureBuffer.wipe(dekRaw);
    }
  }

  removePasskey(): void {
    if (!this.meta("dek_pw")) throw new Error("last-method");
    this.setMeta("passkey", null);
    this.setMeta("dek_pk", null);
  }

  hasPassword(): boolean {
    return !!this.meta("dek_pw");
  }

  /** The DEK is non-extractable in RAM; re-wrapping goes through the recovery-independent check value. */
  private dekRawCache: Uint8Array | null = null;
  private async exportDek(): Promise<Uint8Array> {
    this.need();
    if (!this.dekRawCache) throw new Error("locked");
    return this.dekRawCache.slice();
  }

  private async open(dekRaw: Uint8Array): Promise<void> {
    this.lock();
    const dek = await importAesKey(dekRaw);
    // Kept (as a copy) only while unlocked, to re-wrap the DEK for a new password/passkey; wiped at lock.
    this.dekRawCache = dekRaw.slice();
    const sealedId = unpackJson(this.meta("identity")!);
    const raw = await openJson<{ ed: string; x: string }>(dek, sealedId, "identity");
    const id: Identity = { edSecret: fromB64u(raw.ed), xSecret: fromB64u(raw.x) };
    const pub = publicKeys(id);
    const secret = await inboxSecret(id);
    const handle = await handleFor(pub.ed, pub.x);
    const card = encodeCard({ ...pub, inbox: await inboxIdFor(secret) });
    const mem = this.openMemory();
    mem.exec(FTS_SCHEMA);
    const u: Unlocked = { dek, id, handle, card, inboxSecret: secret, items: new Map(), vectors: new Map(), usage: {}, mem };
    for (const row of this.db.selectObjects("SELECT id, ciphertext, iv FROM secrets")) {
      const data = await openJson<ItemData>(dek, { iv: u8(row.iv), ct: u8(row.ciphertext) }, `item:${row.id}`);
      u.items.set(String(row.id), data);
      indexFts(mem, String(row.id), data);
    }
    for (const row of this.db.selectObjects("SELECT secret_id, ciphertext, iv FROM embeddings")) {
      const bytes = await aesOpen(dek, { iv: u8(row.iv), ct: u8(row.ciphertext) }, enc.encode(`emb:${row.secret_id}`));
      u.vectors.set(String(row.secret_id), new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
    }
    const usage = this.meta("usage");
    if (usage) u.usage = await openJson<Record<string, number>>(dek, unpackJson(usage), "usage").catch(() => ({}));
    this.u = u;
    this.purgeExpired();
  }

  /** Drops every key and decrypted value held by this worker (best effort, see SecureBuffer). */
  lock(): void {
    const u = this.u;
    this.u = null;
    this.needsNewPassword = false;
    SecureBuffer.wipe(this.dekRawCache);
    this.dekRawCache = null;
    this.pending.clear();
    if (!u) return;
    SecureBuffer.wipe(u.id.edSecret);
    SecureBuffer.wipe(u.id.xSecret);
    for (const v of u.vectors.values()) v.fill(0);
    u.items.clear();
    u.vectors.clear();
    try {
      u.mem.close();
    } catch {
      /* ignore */
    }
  }

  identity(): { handle: string; card: string; inboxSecret: string } {
    const u = this.need();
    return { handle: u.handle, card: u.card, inboxSecret: u.inboxSecret };
  }

  /* ── items ── */

  private summary(id: string, d: ItemData): ItemSummary {
    const row = this.db.selectObjects("SELECT version, has_conflict, created_at, updated_at FROM secrets WHERE id = ?", [id])[0] ?? {};
    const conflicts = Number(this.db.selectValue("SELECT COUNT(*) FROM secret_conflicts WHERE secret_id = ?", [id]) ?? 0);
    return {
      id,
      category: d.category,
      title: d.title,
      tags: d.tags ?? [],
      subtitle: d.category === "login" ? d.username || hostOf(d.url) || "" : d.category === "api_key" ? d.service || "" : d.category === "file" ? d.file?.name || "" : (d.notes || "").slice(0, 80),
      url: d.url,
      version: Number(row.version ?? 1),
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
      hasConflict: Number(row.has_conflict ?? 0) === 1 || conflicts > 0,
      conflicts,
      received: d.received,
      grants: d.grants?.length ?? 0,
      file: d.file,
      hasSecret: !!(d.password || d.apiKey),
    };
  }

  list(): ItemSummary[] {
    const u = this.need();
    this.purgeExpired();
    return [...u.items.entries()].map(([id, d]) => this.summary(id, d)).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): ItemData {
    const d = this.need().items.get(id);
    if (!d) throw new Error("not-found");
    return structuredClone(d);
  }

  /** One secret field, for copy/reveal (and records usage for ranking). */
  async secret(id: string, field: "password" | "apiKey" | "username" | "url"): Promise<string> {
    const u = this.need();
    const d = u.items.get(id);
    if (!d) throw new Error("not-found");
    u.usage[id] = this.now();
    this.setMeta("usage", packJson(await sealJson(u.dek, u.usage, "usage")));
    return String(d[field] ?? "");
  }

  private async writeItem(id: string, data: ItemData, opts: { createdAt?: number; chunks?: { idx: number; iv: Uint8Array; ct: Uint8Array }[] | null; keepConflicts?: boolean } = {}): Promise<number> {
    const u = this.need();
    const sealed = await sealJson(u.dek, data, `item:${id}`);
    const now = this.now();
    const prev = this.db.selectObjects("SELECT version, ciphertext, iv, updated_at FROM secrets WHERE id = ?", [id])[0];
    let version = 1;
    this.db.transaction(() => {
      if (prev) {
        version = Number(prev.version) + 1;
        this.db.exec({ sql: "INSERT OR REPLACE INTO secret_versions (secret_id, version, ciphertext, iv, created_at) VALUES (?, ?, ?, ?, ?)", bind: [id, Number(prev.version), prev.ciphertext, prev.iv, Number(prev.updated_at)] });
        this.db.exec({ sql: "DELETE FROM secret_versions WHERE secret_id = ? AND version <= ?", bind: [id, version - 1 - MAX_VERSIONS] });
        this.db.exec({ sql: "UPDATE secrets SET category = ?, ciphertext = ?, iv = ?, version = ?, updated_at = ? WHERE id = ?", bind: [data.category, sealed.ct, sealed.iv, version, now, id] });
      } else {
        this.db.exec({ sql: "INSERT INTO secrets (id, category, ciphertext, iv, version, has_conflict, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?)", bind: [id, data.category, sealed.ct, sealed.iv, opts.createdAt ?? now, now] });
      }
      if (opts.chunks) {
        this.db.exec({ sql: "DELETE FROM file_chunks WHERE secret_id = ?", bind: [id] });
        for (const c of opts.chunks) this.db.exec({ sql: "INSERT INTO file_chunks (secret_id, idx, iv, ciphertext) VALUES (?, ?, ?, ?)", bind: [id, c.idx, c.iv, c.ct] });
      }
    });
    u.items.set(id, structuredClone(data));
    indexFts(u.mem, id, data);
    u.vectors.delete(id);
    this.db.exec({ sql: "DELETE FROM embeddings WHERE secret_id = ?", bind: [id] });
    return version;
  }

  /** Create (id null) or edit an item. Files: pass the bytes once at creation. */
  async put(id: string | null, fields: ItemFields & { category: ItemData["category"] }, file?: { name: string; type: string; bytes: Uint8Array }): Promise<string> {
    const u = this.need();
    const prev = id ? u.items.get(id) : undefined;
    if (id && !prev) throw new Error("not-found");
    if (prev?.received && prev.received.role === "reader") throw new Error("read-only");
    const itemId = id ?? uuid();
    const data: ItemData = {
      ...cleanFields(fields),
      category: prev?.category ?? fields.category,
      clock: tick(prev?.clock ?? {}, u.handle),
      ...(prev?.grants ? { grants: prev.grants } : {}),
      ...(prev?.received ? { received: prev.received } : {}),
      ...(prev?.file ? { file: prev.file } : {}),
    };
    let chunks: { idx: number; iv: Uint8Array; ct: Uint8Array }[] | null = null;
    if (!prev && data.category === "file") {
      if (!file) throw new Error("no-file");
      chunks = await encryptChunks(u.dek, file.bytes, `file:${itemId}`);
      const leaves = await Promise.all(chunks.map(chunkLeaf));
      data.file = { name: file.name, size: file.bytes.length, type: file.type || "application/octet-stream", chunks: chunks.length, root: hex(await merkleRoot(leaves)) };
    }
    await this.writeItem(itemId, data, { chunks });
    return itemId;
  }

  async remove(id: string): Promise<void> {
    const u = this.need();
    this.db.transaction(() => {
      this.db.exec({ sql: "DELETE FROM secrets WHERE id = ?", bind: [id] });
      // Explicit, in case foreign keys are off on an imported file.
      for (const t of ["secret_versions", "file_chunks", "secret_conflicts", "embeddings"]) this.db.exec({ sql: `DELETE FROM ${t} WHERE secret_id = ?`, bind: [id] });
    });
    u.items.delete(id);
    u.vectors.delete(id);
    u.mem.exec({ sql: "DELETE FROM secrets_fts WHERE secret_id = ?", bind: [id] });
    delete u.usage[id];
  }

  versions(id: string): VersionInfo[] {
    this.need();
    const cur = this.db.selectObjects("SELECT version, updated_at FROM secrets WHERE id = ?", [id])[0];
    if (!cur) throw new Error("not-found");
    const old = this.db.selectObjects("SELECT version, created_at FROM secret_versions WHERE secret_id = ? ORDER BY version DESC", [id]);
    return [{ version: Number(cur.version), at: Number(cur.updated_at), current: true }, ...old.map((r) => ({ version: Number(r.version), at: Number(r.created_at), current: false }))];
  }

  async getVersion(id: string, version: number): Promise<ItemData> {
    const u = this.need();
    const row = this.db.selectObjects("SELECT ciphertext, iv FROM secret_versions WHERE secret_id = ? AND version = ?", [id, version])[0];
    if (!row) return this.get(id);
    return openJson<ItemData>(u.dek, { iv: u8(row.iv), ct: u8(row.ciphertext) }, `item:${id}`);
  }

  async restoreVersion(id: string, version: number): Promise<void> {
    const old = await this.getVersion(id, version);
    const cur = this.get(id);
    const fields: ItemFields & { category: ItemData["category"] } = { ...stripLocal(old), category: cur.category };
    await this.put(id, fields);
  }

  /** Decrypts a file item, checking every chunk against its stored Merkle root. */
  async readFile(id: string): Promise<{ name: string; type: string; bytes: Uint8Array }> {
    const u = this.need();
    const d = u.items.get(id);
    if (!d?.file) throw new Error("not-a-file");
    const rows = this.db.selectObjects("SELECT idx, iv, ciphertext FROM file_chunks WHERE secret_id = ? ORDER BY idx", [id]);
    const chunks = rows.map((r) => ({ idx: Number(r.idx), iv: u8(r.iv), ct: u8(r.ciphertext) }));
    const root = hex(await merkleRoot(await Promise.all(chunks.map(chunkLeaf))));
    if (root !== d.file.root || chunks.length !== d.file.chunks) throw new Error("integrity");
    return { name: d.file.name, type: d.file.type, bytes: await decryptChunks(u.dek, chunks, `file:${id}`) };
  }

  /* ── search ── */

  /** Texts that still need an embedding (computed on-device by the page's MiniLM worker). */
  embeddingTodo(): { id: string; text: string }[] {
    const u = this.need();
    return [...u.items.entries()].filter(([id]) => !u.vectors.has(id)).map(([id, d]) => ({ id, text: embedText(d) }));
  }

  async setEmbedding(id: string, vec: Float32Array): Promise<void> {
    const u = this.need();
    if (!u.items.has(id)) return;
    const bytes = new Uint8Array(vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength));
    const s = await aesSeal(u.dek, bytes, enc.encode(`emb:${id}`));
    this.db.exec({ sql: "INSERT OR REPLACE INTO embeddings (secret_id, ciphertext, iv) VALUES (?, ?, ?)", bind: [id, s.ct, s.iv] });
    u.vectors.set(id, new Float32Array(bytes.buffer));
  }

  search(q: string, qVec: Float32Array | null, limit = 20): { id: string; score: number; fts: number; cosine: number | null }[] {
    const u = this.need();
    const tokens = (q.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 12);
    const bm = new Map<string, number>();
    if (tokens.length) {
      const match = tokens.map((t) => `"${t.replace(/"/g, "")}"*`).join(" OR ");
      for (const r of u.mem.selectObjects("SELECT secret_id, bm25(secrets_fts, 0, 4.0, 2.0, 1.0, 2.0) AS s FROM secrets_fts WHERE secrets_fts MATCH ? ORDER BY s LIMIT 200", [match])) bm.set(String(r.secret_id), Number(r.s));
    }
    const fts = normaliseBm25(bm);
    const rows = [...u.items.keys()].map((id) => {
      const v = qVec ? u.vectors.get(id) : undefined;
      const row = this.db.selectObjects("SELECT updated_at FROM secrets WHERE id = ?", [id])[0];
      return { id, fts: fts.get(id) ?? 0, cosine: qVec && v ? dot(qVec, v) : null, updatedAt: Number(row?.updated_at ?? 0), usedAt: u.usage[id] };
    });
    const ranked = rankResults(qVec ? rows : rows.map((r) => ({ ...r, cosine: null })), this.now());
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ranked.slice(0, limit).map((r) => ({ ...r, fts: byId.get(r.id)!.fts, cosine: byId.get(r.id)!.cosine }));
  }

  /* ── contacts ── */

  async peers(): Promise<Peer[]> {
    const u = this.need();
    const out: Peer[] = [];
    for (const r of this.db.selectObjects("SELECT peer_id, ciphertext, iv, trust_level, last_seen FROM p2p_peers ORDER BY last_seen DESC")) {
      const p = await openJson<{ alias: string; card: string }>(u.dek, { iv: u8(r.iv), ct: u8(r.ciphertext) }, `peer:${r.peer_id}`);
      out.push({ peerId: String(r.peer_id), alias: p.alias, card: p.card, trust: Number(r.trust_level), lastSeen: Number(r.last_seen) });
    }
    return out;
  }

  async addPeer(card: string, alias: string): Promise<Peer> {
    const u = this.need();
    const pub = decodeCard(card);
    if (!pub) throw new Error("bad-card");
    const peerId = await handleFor(pub.ed, pub.x);
    if (peerId === u.handle) throw new Error("self");
    const name = alias.trim().slice(0, 60) || peerId;
    const s = await sealJson(u.dek, { alias: name, card: card.trim() }, `peer:${peerId}`);
    const now = this.now();
    this.db.exec({ sql: "INSERT INTO p2p_peers (peer_id, ciphertext, iv, trust_level, last_seen) VALUES (?, ?, ?, 1, ?) ON CONFLICT(peer_id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv", bind: [peerId, s.ct, s.iv, now] });
    return { peerId, alias: name, card: card.trim(), trust: 1, lastSeen: now };
  }

  removePeer(peerId: string): void {
    this.need();
    this.db.exec({ sql: "DELETE FROM p2p_peers WHERE peer_id = ?", bind: [peerId] });
  }

  private async peer(peerId: string): Promise<Peer | undefined> {
    return (await this.peers()).find((p) => p.peerId === peerId);
  }

  /* ── P2P share (envelopes are transport-agnostic: WebRTC now, a TTL mailbox later) ── */

  private async seal(kind: "share" | "update", id: string, d: ItemData, to: Peer, extra: { role?: Role; expiresAt?: number }, withFile: boolean): Promise<Envelope> {
    const u = this.need();
    const pub = decodeCard(to.card);
    if (!pub) throw new Error("bad-card");
    const { eph, key } = await shareKeyToRecipient(pub.x);
    let chunksOut: Uint8Array[] = [];
    let leaves: string[] = [];
    let root: string | undefined;
    if (withFile && d.file) {
      const file = await this.readFile(id);
      const parts: Uint8Array[] = [];
      const n = d.file.chunks;
      for (let i = 0; i < n; i++) {
        const part = file.bytes.subarray(i * 1048576, Math.min(file.bytes.length, (i + 1) * 1048576));
        parts.push((await aesSeal(key, part, enc.encode(`chunk:${id}:${i}/${n}`), shareIv(i + 1))).ct);
      }
      SecureBuffer.wipe(file.bytes);
      chunksOut = parts;
      const lv = await Promise.all(parts.map((ct, i) => chunkLeaf({ iv: shareIv(i + 1), ct })));
      leaves = lv.map(b64u);
      root = hex(await merkleRoot(lv));
    }
    const payload = { kind, data: { ...stripLocal(d), category: d.category, clock: d.clock, ...(d.file ? { file: { ...d.file, root: root ?? d.file.root } } : {}) }, ...extra };
    const ts = this.now();
    const body = enc.encode(JSON.stringify(payload));
    const ct = (await aesSeal(key, body, enc.encode(`hdr:${id}:${to.peerId}:${ts}`), shareIv(0))).ct;
    SecureBuffer.wipe(body);
    const h = JSON.stringify({ t: "fny-safe", v: 1, kind, from: u.card, to: to.peerId, ts, id, eph: b64u(eph), ct: b64u(ct), n: chunksOut.length, leaves, root: root ?? null });
    return { h, sig: b64u(sign(u.id, enc.encode(h))), chunks: chunksOut };
  }

  async buildShare(id: string, peerId: string, role: Role, expiresAt?: number): Promise<Outgoing> {
    const u = this.need();
    const d = u.items.get(id);
    if (!d) throw new Error("not-found");
    if (d.received && d.received.role !== "admin") throw new Error("forbidden");
    if (d.received?.expiresAt && expiresAt && expiresAt > d.received.expiresAt) expiresAt = d.received.expiresAt;
    if (d.received?.expiresAt && !expiresAt) expiresAt = d.received.expiresAt;
    const peer = await this.peer(peerId);
    if (!peer) throw new Error("unknown-peer");
    const envelope = await this.seal("share", id, d, peer, { role, ...(expiresAt ? { expiresAt } : {}) }, true);
    return { peerId, alias: peer.alias, inbox: decodeCard(peer.card)!.inbox, envelope };
  }

  /** Records a grant once the recipient acknowledged the share. */
  async recordGrant(id: string, peerId: string, role: Role, expiresAt?: number): Promise<void> {
    const u = this.need();
    const d = u.items.get(id);
    if (!d) return;
    const grants = (d.grants ?? []).filter((g) => g.peerId !== peerId);
    grants.push({ peerId, role, ...(expiresAt ? { expiresAt } : {}), at: this.now() });
    await this.writeLocalOnly(id, { ...d, grants });
  }

  /** Local-only metadata change (grants): new ciphertext, same version/clock. */
  private async writeLocalOnly(id: string, data: ItemData): Promise<void> {
    const u = this.need();
    const s = await sealJson(u.dek, data, `item:${id}`);
    this.db.exec({ sql: "UPDATE secrets SET ciphertext = ?, iv = ? WHERE id = ?", bind: [s.ct, s.iv, id] });
    u.items.set(id, structuredClone(data));
  }

  /** Updates to send for an edited shared item: to the owner (editor/admin) and to my own recipients. */
  async buildUpdates(id: string): Promise<Outgoing[]> {
    const u = this.need();
    const d = u.items.get(id);
    if (!d) throw new Error("not-found");
    const targets: { peerId: string; extra: { role?: Role; expiresAt?: number } }[] = [];
    if (d.received && d.received.role !== "reader") targets.push({ peerId: d.received.from, extra: {} });
    if (!d.received || d.received.role === "admin") for (const g of d.grants ?? []) targets.push({ peerId: g.peerId, extra: { role: g.role, ...(g.expiresAt ? { expiresAt: g.expiresAt } : {}) } });
    const out: Outgoing[] = [];
    for (const t of targets) {
      const peer = await this.peer(t.peerId);
      if (!peer) continue;
      out.push({ peerId: peer.peerId, alias: peer.alias, inbox: decodeCard(peer.card)!.inbox, envelope: await this.seal("update", id, d, peer, t.extra, false) });
    }
    return out;
  }

  /** Verifies, decrypts and applies an incoming envelope. */
  async receive(env: Envelope): Promise<ReceiveResult> {
    const u = this.need();
    let h: { t: string; v: number; kind: "share" | "update"; from: string; to: string; ts: number; id: string; eph: string; ct: string; n: number; leaves: string[]; root: string | null };
    try {
      h = JSON.parse(env.h);
    } catch {
      return { status: "rejected", reason: "malformed" };
    }
    if (h.t !== "fny-safe" || h.v !== 1 || !["share", "update"].includes(h.kind) || typeof h.id !== "string" || !/^[\w-]{8,64}$/.test(h.id)) return { status: "rejected", reason: "malformed" };
    const pub = decodeCard(h.from);
    if (!pub) return { status: "rejected", reason: "malformed" };
    if (!verify(pub.ed, enc.encode(env.h), fromB64u(env.sig))) return { status: "rejected", reason: "bad-signature" };
    const from = await handleFor(pub.ed, pub.x);
    if (h.to !== u.handle) return { status: "rejected", reason: "not-for-me", from };
    if (Math.abs(this.now() - h.ts) > MAX_SHARE_AGE_MS) return { status: "rejected", reason: "too-old", from };
    if (env.chunks.length !== h.n || h.leaves.length !== h.n) return { status: "rejected", reason: "integrity", from };
    // Piece-by-piece integrity: every chunk against its signed leaf, then the root.
    const leaves: Uint8Array[] = [];
    for (let i = 0; i < h.n; i++) {
      const leaf = await chunkLeaf({ iv: shareIv(i + 1), ct: env.chunks[i]! });
      if (b64u(leaf) !== h.leaves[i]) return { status: "rejected", reason: "integrity", from };
      leaves.push(leaf);
    }
    if (h.n && hex(await merkleRoot(leaves)) !== h.root) return { status: "rejected", reason: "integrity", from };
    const key = await shareKeyFromSender(u.id, fromB64u(h.eph));
    let payload: { kind: string; data: ItemData; role?: Role; expiresAt?: number };
    try {
      const body = await aesOpen(key, { iv: shareIv(0), ct: fromB64u(h.ct) }, enc.encode(`hdr:${h.id}:${h.to}:${h.ts}`));
      payload = JSON.parse(dec.decode(body));
      SecureBuffer.wipe(body);
    } catch {
      return { status: "rejected", reason: "decrypt", from };
    }
    const incoming: ItemData = { ...stripLocal(payload.data), category: payload.data.category, clock: payload.data.clock ?? {}, ...(payload.data.file ? { file: payload.data.file } : {}) };
    let plainChunks: { iv: Uint8Array; ct: Uint8Array }[] | null = null;
    if (h.n && incoming.file) {
      // Re-encrypt the file under this vault's DEK.
      const parts: Uint8Array[] = [];
      for (let i = 0; i < h.n; i++) parts.push(await aesOpen(key, { iv: shareIv(i + 1), ct: env.chunks[i]! }, enc.encode(`chunk:${h.id}:${i}/${h.n}`)));
      const bytes = concat(...parts);
      parts.forEach((p) => SecureBuffer.wipe(p));
      const local = await encryptChunks(u.dek, bytes, `file:${h.id}`);
      SecureBuffer.wipe(bytes);
      incoming.file = { ...incoming.file, size: incoming.file.size, chunks: local.length, root: hex(await merkleRoot(await Promise.all(local.map(chunkLeaf)))) };
      plainChunks = local;
    }
    const known = await this.peer(from);
    const existing = u.items.get(h.id);

    if (!existing) {
      if (h.kind !== "share" || !payload.role) return { status: "rejected", reason: "unknown-item", from };
      if (payload.expiresAt && payload.expiresAt <= this.now()) return { status: "rejected", reason: "expired", from };
      const data: ItemData = { ...incoming, received: { from, role: payload.role, ...(payload.expiresAt ? { expiresAt: payload.expiresAt } : {}), at: this.now() } };
      if (!known) {
        const pendingId = b64u(randomBytes(9));
        this.pending.set(pendingId, { from, card: h.from, itemId: h.id, data, chunks: plainChunks, title: data.title });
        return { status: "pending", pendingId, from, title: data.title, card: h.from };
      }
      await this.writeItem(h.id, data, { chunks: plainChunks?.map((c, idx) => ({ idx, ...c })) ?? null });
      this.touchPeer(from);
      return { status: "new", id: h.id, from, alias: known.alias, title: data.title };
    }

    // Authorisation (client-enforced): updates come from my upstream, or from a downstream editor/admin.
    const upstream = existing.received?.from === from;
    const grant = existing.grants?.find((g) => g.peerId === from);
    if (!upstream && !(grant && grant.role !== "reader")) return { status: "rejected", reason: "forbidden", from };
    const order = compareClocks(incoming.clock, existing.clock);
    const received = upstream && payload.role ? { from, role: payload.role, ...(payload.expiresAt ? { expiresAt: payload.expiresAt } : {}), at: existing.received!.at } : existing.received;
    if (order === "before" || order === "equal") {
      if (received !== existing.received) await this.writeLocalOnly(h.id, { ...existing, received });
      return { status: "stale", id: h.id, from, alias: known?.alias, title: existing.title };
    }
    if (order === "after") {
      const data: ItemData = { ...incoming, file: existing.file, ...(existing.grants ? { grants: existing.grants } : {}), ...(received ? { received } : {}) };
      await this.writeItem(h.id, data);
      this.touchPeer(from);
      return { status: "updated", id: h.id, from, alias: known?.alias, title: data.title };
    }
    // Concurrent edits: keep both, never overwrite.
    const s = await sealJson(u.dek, { ...incoming, file: existing.file }, `conflict:${h.id}`);
    this.db.transaction(() => {
      this.db.exec({ sql: "DELETE FROM secret_conflicts WHERE secret_id = ? AND author_key = ?", bind: [h.id, from] });
      this.db.exec({ sql: "INSERT INTO secret_conflicts (conflict_id, secret_id, author_key, ciphertext, iv, created_at) VALUES (?, ?, ?, ?, ?, ?)", bind: [uuid(), h.id, from, s.ct, s.iv, this.now()] });
      this.db.exec({ sql: "UPDATE secrets SET has_conflict = 1 WHERE id = ?", bind: [h.id] });
    });
    if (received !== existing.received) await this.writeLocalOnly(h.id, { ...existing, received });
    return { status: "conflict", id: h.id, from, alias: known?.alias, title: existing.title };
  }

  private touchPeer(peerId: string) {
    this.db.exec({ sql: "UPDATE p2p_peers SET last_seen = ? WHERE peer_id = ?", bind: [this.now(), peerId] });
  }

  pendingShares(): { pendingId: string; from: string; title: string; card: string }[] {
    return [...this.pending.entries()].map(([pendingId, p]) => ({ pendingId, from: p.from, title: p.title, card: p.card }));
  }

  async acceptPending(pendingId: string, alias: string): Promise<string> {
    const p = this.pending.get(pendingId);
    if (!p) throw new Error("not-found");
    this.pending.delete(pendingId);
    await this.addPeer(p.card, alias);
    await this.writeItem(p.itemId, p.data, { chunks: p.chunks?.map((c, idx) => ({ idx, ...c })) ?? null });
    return p.itemId;
  }

  declinePending(pendingId: string): void {
    this.pending.delete(pendingId);
  }

  /* ── conflicts ── */

  async conflicts(id: string): Promise<ConflictInfo[]> {
    const u = this.need();
    const peers = new Map((await this.peers()).map((p) => [p.peerId, p.alias]));
    const out: ConflictInfo[] = [];
    for (const r of this.db.selectObjects("SELECT conflict_id, author_key, ciphertext, iv, created_at FROM secret_conflicts WHERE secret_id = ? ORDER BY created_at", [id])) {
      out.push({ conflictId: String(r.conflict_id), author: String(r.author_key), authorAlias: peers.get(String(r.author_key)), at: Number(r.created_at), data: await openJson<ItemData>(u.dek, { iv: u8(r.iv), ct: u8(r.ciphertext) }, `conflict:${id}`) });
    }
    return out;
  }

  /** Keep mine ("local"), keep theirs (a conflict id) or a manual merge; the result dominates every branch. */
  async resolve(id: string, choice: { keep: "local" } | { keep: "remote"; conflictId: string } | { keep: "manual"; fields: ItemFields }): Promise<void> {
    const u = this.need();
    const cur = u.items.get(id);
    if (!cur) throw new Error("not-found");
    const all = await this.conflicts(id);
    let clock = cur.clock;
    for (const c of all) clock = mergeClocks(clock, c.data.clock);
    let fields: ItemFields;
    if (choice.keep === "local") fields = stripLocal(cur);
    else if (choice.keep === "remote") {
      const c = all.find((x) => x.conflictId === choice.conflictId);
      if (!c) throw new Error("not-found");
      fields = stripLocal(c.data);
    } else fields = cleanFields(choice.fields);
    const data: ItemData = { ...fields, category: cur.category, clock: tick(clock, u.handle), ...(cur.file ? { file: cur.file } : {}), ...(cur.grants ? { grants: cur.grants } : {}), ...(cur.received ? { received: cur.received } : {}) };
    await this.writeItem(id, data);
    this.db.transaction(() => {
      this.db.exec({ sql: "DELETE FROM secret_conflicts WHERE secret_id = ?", bind: [id] });
      this.db.exec({ sql: "UPDATE secrets SET has_conflict = 0 WHERE id = ?", bind: [id] });
    });
  }

  /* ── expiry, security ── */

  /** Deletes received items whose share expired (client-enforced). */
  purgeExpired(): string[] {
    const u = this.u;
    if (!u) return [];
    const now = this.now();
    const gone = [...u.items.entries()].filter(([, d]) => d.received?.expiresAt && d.received.expiresAt <= now).map(([id]) => id);
    for (const id of gone) void this.remove(id);
    return gone;
  }

  security(): SecurityReport {
    const u = this.need();
    const now = this.now();
    const logins = [...u.items.entries()].filter(([, d]) => d.category === "login" && d.password);
    const weak = logins.map(([id, d]) => ({ id, title: d.title, bits: estimateBits(d.password!) })).filter((x) => x.bits < WEAK_BITS);
    const groups = new Map<string, string[]>();
    for (const [id, d] of logins) groups.set(d.password!, [...(groups.get(d.password!) ?? []), id]);
    const reused = [...groups.values()].filter((ids) => ids.length > 1).map((ids) => ({ ids, titles: ids.map((i) => u.items.get(i)!.title) }));
    const old = logins
      .map(([id, d]) => ({ id, title: d.title, days: Math.floor((now - Number(this.db.selectValue("SELECT updated_at FROM secrets WHERE id = ?", [id]) ?? now)) / 86_400_000) }))
      .filter((x) => x.days >= 365);
    return { total: u.items.size, logins: logins.length, weak, reused, old };
  }

  /** SHA-1 of one password, for the opt-in HIBP k-anonymity check (only the first 5 hex chars leave the device). */
  async passwordSha1(id: string): Promise<string> {
    const d = this.get(id);
    if (!d.password) throw new Error("no-password");
    const h = new Uint8Array(await crypto.subtle.digest("SHA-1", B(enc.encode(d.password))));
    return hex(h).toUpperCase();
  }
}

/* ── helpers ── */

function packJson(s: Sealed): Uint8Array {
  return concat(s.iv, s.ct);
}
function unpackJson(b: Uint8Array): Sealed {
  return { iv: b.slice(0, 12), ct: b.slice(12) };
}

export function hostOf(url?: string): string {
  if (!url) return "";
  try {
    return new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function cleanFields(f: Partial<ItemFields>): ItemFields {
  const s = (v: unknown, max = 10_000) => (typeof v === "string" && v.length ? v.slice(0, max) : undefined);
  const out: ItemFields = {
    category: (f.category ?? "note") as ItemFields["category"],
    title: (s(f.title, 200) ?? "").trim() || "—",
    tags: Array.isArray(f.tags) ? [...new Set(f.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 20) : [],
  };
  for (const k of ["username", "password", "url", "notes", "apiKey", "service"] as const) {
    const v = s(f[k], k === "notes" ? 100_000 : 10_000);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function stripLocal(d: ItemData): ItemFields {
  const { clock: _c, grants: _g, received: _r, file: _f, ...rest } = d;
  return cleanFields(rest);
}

function indexFts(mem: Db, id: string, d: ItemData) {
  mem.exec({ sql: "DELETE FROM secrets_fts WHERE secret_id = ?", bind: [id] });
  const summary = [d.username, d.service, d.file?.name, (d.notes || "").slice(0, 300)].filter(Boolean).join(" ");
  mem.exec({ sql: "INSERT INTO secrets_fts (secret_id, title, tags, notes_summary, domain) VALUES (?, ?, ?, ?, ?)", bind: [id, d.title, (d.tags ?? []).join(" "), summary, hostOf(d.url).replace(/\./g, " ")] });
}

/** Text embedded for semantic search: never the password or API key. */
export function embedText(d: ItemData): string {
  return [d.title, (d.tags ?? []).join(", "), d.service, hostOf(d.url), d.username, d.file?.name, (d.notes || "").slice(0, 400)].filter(Boolean).join(". ");
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}
