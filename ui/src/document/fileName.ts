/** File names of the Document tab: an editable stem plus the save format's extension. */
export type SaveFormat = "pdf" | "md";

const EXT = /\.(pdf|md|markdown|txt)$/i;

/** "Rapport.final.PDF" → "Rapport.final" (only known document extensions are removed). */
export function stem(name: string): string {
  return name.trim().replace(EXT, "") || "document";
}

/** Characters no OS accepts in a file name are replaced; the stem is never empty. */
export function sanitizeStem(input: string): string {
  const s = input
    .replace(EXT, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 150)
    .trim();
  return s || "document";
}

export function withExt(s: string, format: SaveFormat): string {
  return `${sanitizeStem(s)}.${format}`;
}

export const MIME: Record<SaveFormat, string> = { pdf: "application/pdf", md: "text/markdown" };

export type OpenKind = "pdf" | "markdown" | "text" | null;

/** What an opened file is, from its name and type (contents are checked later for PDFs). */
export function openKind(file: { name: string; type?: string }): OpenKind {
  const n = file.name.toLowerCase();
  if (n.endsWith(".pdf") || file.type === "application/pdf") return "pdf";
  if (/\.(md|markdown|mdown|mkd)$/.test(n) || file.type === "text/markdown") return "markdown";
  if (n.endsWith(".txt") || file.type === "text/plain") return "text";
  return null;
}
