/** Multi-file selection helpers for the "Envoyer des fichiers" flow. */

/** Identity used to skip a file picked twice (same name, size and mtime). */
export const fileKey = (f: Pick<File, "name" | "size" | "lastModified">) => `${f.name}\u0000${f.size}\u0000${f.lastModified}`;

/** Appends `incoming` to `current`, keeping order and dropping duplicates. */
export function mergeFiles(current: readonly File[], incoming: Iterable<File> | ArrayLike<File> | null | undefined): File[] {
  const out = [...current];
  if (!incoming) return out;
  const seen = new Set(out.map(fileKey));
  for (const f of Array.from(incoming as ArrayLike<File>)) {
    const k = fileKey(f);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

/** Removes the file at `index` (no-op when out of range). */
export const removeFileAt = (current: readonly File[], index: number): File[] => current.filter((_, i) => i !== index);

/** Sum of the sizes, in bytes. */
export const totalBytes = (files: readonly Pick<File, "size">[]) => files.reduce((n, f) => n + f.size, 0);

/** True when a drag carries files (not text or a link dragged from the page). */
export const dragHasFiles = (dt: DataTransfer | null | undefined) => !!dt && Array.from(dt.types || []).includes("Files");
