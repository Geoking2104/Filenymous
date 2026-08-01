/**
 * Shared send pipeline — used by SendPanel and UX v3 SendWorkspace.
 *
 * Flow:
 *  1. Resolve recipient on DHT (contact hash → agent → X25519)
 *  2. Generate AES-256 key, encrypt file chunks locally
 *  3. Publish encrypted chunks + parcel manifest on DHT
 *  4. Build Magic Link (#parcel:aesKey) or agent-notified link
 */

import { hashContact } from "../crypto/contact";
import { generateAesKey, exportAesKey } from "../crypto/aes";
import { encryptFile } from "../crypto/chunker";
import { encryptAesKeyForRecipient, importX25519PublicKey } from "../crypto/ecies";
import { identityZome } from "../holochain/identity";
import { fileStorageZome } from "../holochain/fileStorage";
import { parcelZome } from "../holochain/delivery";
import { canWrite, initClient } from "../holochain/client";

const CHUNK_SIZE = 256 * 1024;

export type DeliveryMode = "agent" | "link";

export type ProgressFn = (pct: number, stepKey: string, params?: Record<string, string | number>) => void;

export interface SendTransferInput {
  files: File[];
  recipient: string;
  /** Expiry key: 24h | 7d | 30d | never */
  expiry?: string;
  /** Max downloads; 0 = unlimited */
  maxDownloads?: number;
  onProgress?: ProgressFn;
}

export interface SendTransferResult {
  link: string;
  parcelEhB64: string;
  fileName: string;
  totalSize: number;
  mode: DeliveryMode;
  maxDownloads: number;
  /** Short display code derived from parcel hash */
  code: string;
}

export function isValidContact(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || /^\+[1-9]\d{7,14}$/.test(v);
}

function encodeB64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function codeFromParcel(parcelEhB64: string): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) {
    const c = parcelEhB64.charCodeAt(i % parcelEhB64.length) || 0;
    out += alphabet[c % alphabet.length];
  }
  return `${out.slice(0, 2)}·${out.slice(2, 4)}·${out.slice(4, 6)}`;
}

const EXPIRY_MAP: Record<string, number> = {
  "24h": 24 * 3600 * 1e6,
  "7d": 7 * 24 * 3600 * 1e6,
  "30d": 30 * 24 * 3600 * 1e6,
  never: 0,
};

/**
 * Full encrypted send. Requires Holochain write (canWrite).
 */
export async function sendTransfer(input: SendTransferInput): Promise<SendTransferResult> {
  const { files, recipient, expiry = "7d", maxDownloads = 1, onProgress } = input;
  const progress = (pct: number, stepKey: string, params?: Record<string, string | number>) => {
    onProgress?.(pct, stepKey, params);
  };

  if (!files.length) throw new Error("no_files");
  if (!isValidContact(recipient)) throw new Error("invalid_recipient");

  await initClient();
  if (!canWrite()) throw new Error("no_write");

  progress(5, "send.progressResolve");
  const contactHash = await hashContact(recipient);
  const recipientAgent = await identityZome.getAgentForContact(contactHash);

  progress(12, "send.progressAes");
  const aesKey = await generateAesKey();
  const aesRaw = await exportAesKey(aesKey);

  const totalSize = files.reduce((s, f) => s + f.size, 0);
  const totalChunks = Math.max(1, Math.ceil(totalSize / CHUNK_SIZE));
  const fileName = files.length === 1 ? files[0]!.name : `${files.length}_files`;

  progress(18, "send.progressEncrypt");
  const encryptedChunks: Uint8Array[] = [];
  let chunksProcessed = 0;
  for (const file of files) {
    for await (const chunk of encryptFile(file, aesKey)) {
      encryptedChunks.push(chunk.data);
      chunksProcessed++;
      progress(
        18 + Math.round((chunksProcessed / totalChunks) * 35),
        "send.progressChunk",
        { current: chunksProcessed, total: totalChunks },
      );
    }
  }

  progress(55, "send.progressPublish");
  const fileHash = await fileStorageZome.createFile(fileName, encryptedChunks);

  let encryptedKeyBlob = "";
  let deliveryMode: DeliveryMode = "link";

  if (recipientAgent) {
    progress(72, "send.progressWrap");
    const x25519B64 = await identityZome.getX25519Key(recipientAgent);
    if (x25519B64) {
      const x25519Raw = Uint8Array.from(atob(x25519B64), (c) => c.charCodeAt(0));
      const recipKey = await importX25519PublicKey(x25519Raw);
      const blob = await encryptAesKeyForRecipient(aesRaw, recipKey);
      encryptedKeyBlob = btoa(String.fromCharCode(...blob));
      deliveryMode = "agent";
    }
  }

  const expiryDelta = EXPIRY_MAP[expiry] ?? EXPIRY_MAP["7d"]!;
  const expiry_us = expiryDelta ? Date.now() * 1000 + expiryDelta : 0;

  progress(80, "send.progressManifest");
  const parcelOut = await parcelZome.createParcel({
    file_hash: fileHash,
    file_name: fileName,
    file_size: totalSize,
    chunk_count: totalChunks,
    recipient_contact_hash: contactHash,
    encrypted_key_blob: encryptedKeyBlob,
    expiry_us,
    max_downloads: maxDownloads,
  });

  progress(92, "send.progressLink");
  const parcelEhB64 = encodeB64Url(new Uint8Array(parcelOut.parcel_eh as unknown as number[]));

  let transferLink: string;
  if (deliveryMode === "agent") {
    transferLink = `${window.location.origin}/#${parcelEhB64}`;
  } else {
    const aesB64 = encodeB64Url(aesRaw);
    transferLink = `${window.location.origin}/#${parcelEhB64}:${aesB64}`;
  }

  progress(100, "send.progressDone");

  return {
    link: transferLink,
    parcelEhB64,
    fileName,
    totalSize,
    mode: deliveryMode,
    maxDownloads,
    code: codeFromParcel(parcelEhB64),
  };
}
