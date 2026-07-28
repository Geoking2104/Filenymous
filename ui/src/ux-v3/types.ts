export type PrimaryMode = "send" | "receive" | "room";

export type SharePath = "link" | "contact";

export type RoomKind = "private" | "public";

export type DrawerId = "contacts" | "identity" | "history" | "more" | null;

export interface LocalFileItem {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  /** In real app: hold File in a Map outside React state */
  file?: File;
}

export interface ShareResult {
  code: string;
  link: string;
  createdAt: number;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} Go`;
}

export function fileExtLabel(name: string): string {
  const ext = name.split(".").pop()?.toUpperCase() ?? "FILE";
  return ext.slice(0, 4);
}

export function createShareCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  for (let i = 0; i < 6; i++) out += alphabet[arr[i]! % alphabet.length];
  return `${out.slice(0, 2)}·${out.slice(2, 4)}·${out.slice(4, 6)}`;
}
