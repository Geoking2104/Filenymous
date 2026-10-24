/** Test helper: sqlite-wasm (Node build) with in-memory databases. */
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Db } from "./repo";

let mod: Promise<Awaited<ReturnType<typeof sqlite3InitModule>>> | null = null;

export async function memoryDbFactory(): Promise<() => Db> {
  const sqlite3 = await (mod ??= sqlite3InitModule());
  return () => new sqlite3.oo1.DB(":memory:", "c") as unknown as Db;
}
