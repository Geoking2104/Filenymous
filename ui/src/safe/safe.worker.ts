/**
 * Vault worker: the only place where the vault DEK, the identity keys and
 * decrypted items live (in this worker's memory, while unlocked). SQLite runs
 * here on the opfs-sahpool VFS (Origin Private File System, no COOP/COEP needed).
 */
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { VaultRepo, type Db } from "./repo";

const DB_FILE = "/fny-safe.sqlite3";
const CHECK_FILE = "/fny-safe-import.sqlite3";

type Sqlite = Awaited<ReturnType<typeof sqlite3InitModule>>;
type Pool = Awaited<ReturnType<Sqlite["installOpfsSAHPoolVfs"]>>;

let boot: Promise<{ sqlite3: Sqlite; pool: Pool }> | null = null;
let repo: VaultRepo | null = null;
let db: Db | null = null;

function start() {
  return (boot ??= (async () => {
    const sqlite3 = await sqlite3InitModule();
    let last = "";
    // Access handles are exclusive: another tab (or a just-terminated worker
    // still releasing them) holds the pool. Retry briefly, then report "busy".
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const opts = { name: "fny-safe", directory: ".fny-safe", preserveOnInitFailure: true, forceReinitIfPreviouslyFailed: true };
        const pool = await sqlite3.installOpfsSAHPoolVfs(opts as Parameters<Sqlite["installOpfsSAHPoolVfs"]>[0]);
        return { sqlite3, pool };
      } catch (e) {
        last = String((e as Error)?.message || e);
        if (!/NoModificationAllowed|InvalidState|access handle|lock|modif/i.test(last)) break;
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
    if (typeof navigator.storage?.getDirectory !== "function") throw new Error(`opfs-unavailable: ${last}`);
    throw new Error(/NoModificationAllowed|InvalidState|access handle|lock|modif/i.test(last) ? "busy" : `opfs-unavailable: ${last}`);
  })());
}

async function getRepo(): Promise<VaultRepo> {
  if (repo) return repo;
  const { sqlite3, pool } = await start();
  db = new pool.OpfsSAHPoolDb(DB_FILE) as unknown as Db;
  repo = new VaultRepo(db, () => new sqlite3.oo1.DB(":memory:", "c") as unknown as Db);
  return repo;
}

async function exportBackup(): Promise<Uint8Array> {
  const { pool } = await start();
  await getRepo();
  db!.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  return pool.exportFile(DB_FILE);
}

async function importBackup(bytes: Uint8Array): Promise<void> {
  const { sqlite3, pool } = await start();
  if (bytes.length < 512 || new TextDecoder().decode(bytes.subarray(0, 15)) !== "SQLite format 3") throw new Error("bad-backup");
  await pool.importDb(CHECK_FILE, bytes);
  try {
    const check = new pool.OpfsSAHPoolDb(CHECK_FILE) as unknown as Db;
    let ok = false;
    try {
      const format = check.selectValue("SELECT v FROM meta WHERE k = 'format'");
      const text = typeof format === "string" ? format : format ? new TextDecoder().decode(format as Uint8Array) : "";
      ok = text === "filenymous-safe/1" && !!check.selectValue("SELECT v FROM meta WHERE k = 'dek_rec'");
    } catch {
      ok = false;
    } finally {
      check.close();
    }
    if (!ok) throw new Error("bad-backup");
  } finally {
    pool.unlink(CHECK_FILE);
  }
  repo?.lock();
  db?.close();
  repo = null;
  db = null;
  await pool.importDb(DB_FILE, bytes);
  void sqlite3;
  await getRepo();
}

async function destroyVault(): Promise<void> {
  const { pool } = await start();
  repo?.lock();
  db?.close();
  repo = null;
  db = null;
  pool.unlink(DB_FILE);
}

type Req = { id: number; op: string; args: unknown[] };

const ctx = self as unknown as { postMessage(m: unknown, t?: Transferable[]): void; onmessage: ((e: MessageEvent<Req>) => void) | null };

const OPS = new Set([
  "status", "create", "checkPhrase", "unlockPassword", "unlockPasskey", "unlockPhrase", "setPassword", "addPasskey", "removePasskey", "hasPassword",
  "lock", "identity", "list", "get", "secret", "put", "remove", "versions", "getVersion", "restoreVersion", "readFile", "embeddingTodo",
  "setEmbedding", "search", "peers", "addPeer", "removePeer", "buildShare", "recordGrant", "buildUpdates", "receive", "pendingShares",
  "acceptPending", "declinePending", "conflicts", "resolve", "purgeExpired", "security", "passwordSha1", "settings", "setSettings",
]);

let queue: Promise<unknown> = Promise.resolve();

ctx.onmessage = (e) => {
  const { id, op, args } = e.data;
  // One operation at a time: SQLite transactions and key state stay consistent.
  queue = queue.then(async () => {
    try {
      let result: unknown;
      if (op === "exportBackup") result = await exportBackup();
      else if (op === "importBackup") result = await importBackup(args[0] as Uint8Array);
      else if (op === "destroyVault") result = await destroyVault();
      else if (op === "persisted") result = await navigator.storage?.persisted?.();
      else {
        if (!OPS.has(op)) throw new Error(`unknown op ${op}`);
        const r = await getRepo();
        result = await (r as unknown as Record<string, (...a: unknown[]) => unknown>)[op]!(...args);
      }
      const transfer: Transferable[] = [];
      if (result instanceof Uint8Array) transfer.push(result.buffer);
      ctx.postMessage({ id, ok: true, result }, transfer);
    } catch (err) {
      ctx.postMessage({ id, ok: false, error: String((err as Error)?.message || err) });
    }
  });
};
