# Coffre-fort (P2P vault) — design and threat model

The **Coffre-fort** tab (`https://filenymous.eu/app/#safe`, alias `#coffre`) is a
password and secrets vault that lives entirely in your browser and shares items
directly with other people's vaults. There is no account and no vault server.

It is separate from the **one-time secret** service (`#secret-new`, `#s:` links,
code in `ui/src/vault/`), which is unchanged.

## What phase 1 ships

| Area | What it does |
|---|---|
| Onboarding | 24-word recovery phrase (BIP-39, 256-bit), blurred until you click each word, then a 3-word check. A password is optional but recommended. |
| Unlock | Password (Argon2id), passkey (WebAuthn **PRF** only, feature-detected), or the recovery phrase. |
| Lock | Manual lock, auto-lock after 1–60 min of inactivity (default 5). |
| Items | Login, secure note, API key, file (≤ 64 MB). Every save keeps a version; any version can be restored. |
| ⌘K / Ctrl K | Palette: fuzzy search, Enter copies, ⇧Enter copies the username, ⌥Enter reveals for 10 s. Copies are wiped from the clipboard after 30 s (when the tab can still write to it). Optional local semantic search (self-hosted MiniLM model and runtime, ~44 MB downloaded once from filenymous.eu, runs in a worker). |
| Sharing | Item → contact, with a role (reader / editor / admin) and an optional expiry. Delivered peer-to-peer over WebRTC. |
| Conflicts | Vector clocks per item. Concurrent edits are never overwritten: the item shows "2 versions concurrentes détectées", a side-by-side diff, and Keep A / Keep B / manual merge. |
| Backup | Encrypted export file (still protected by your keys), import, and a `navigator.storage.persist()` request. |
| Security | Weak / reused / old password report computed locally. Breach check (HIBP k-anonymity, 5-char SHA-1 prefix, padded) only when you click. |

## Architecture

```
React tab (SafePanel) ── postMessage RPC ──► safe.worker (module worker)
                                              ├─ sqlite-wasm, opfs-sahpool VFS  (encrypted rows only)
                                              ├─ keys: vault DEK, Ed25519 / X25519 identity
                                              └─ repo: items, versions, contacts, shares, clocks
SafePanel ── WebRTC DataChannel ◄─► recipient's SafePanel
          └─ SDP / ICE via the existing Filenymous signaling relay ("wall" rooms)
```

* **Storage.** SQLite (official `@sqlite.org/sqlite-wasm`) with the `opfs-sahpool`
  VFS, in a dedicated worker. This needs no cross-origin isolation (no COEP), so
  the rest of the app is untouched. Only one tab can hold the database at a time;
  a second tab shows "vault open in another tab".
* **Keys.**
  ```
  password ──Argon2id (t=3, m=64 MiB, p=4)──► KEK  ──wraps──► vault DEK
  24-word phrase (256 bits) ──HKDF──► recovery key ──wraps──► vault DEK
  passkey PRF output ──HKDF──► passkey key ──wraps──► vault DEK (optional)
  vault DEK ──AES-256-GCM──► every record, version, file chunk, contact, embedding
  ```
  Each wrap and record uses AES-256-GCM with associated data binding it to its
  slot / row, so blobs cannot be swapped between rows.
* **Identity.** An Ed25519 signing key and an X25519 key agreement key
  (`@noble/curves`), both encrypted under the DEK. You are shown as a short
  fingerprint handle such as `fny-xxxx-xxxx-xxxx-xxxx`; your contact card carries
  both public keys and your inbox id.
* **Passkeys.** Only the WebAuthn PRF extension is used: the authenticator returns
  a secret derived from (credential, salt) after user verification, and that
  secret is HKDF'd into a wrapping key. Nothing is ever derived from assertion
  signatures or other assertion data. If the browser does not positively report
  PRF support, the passkey option is hidden.

## Sharing protocol (`fny-safe` v1)

1. Each unlocked vault hosts an **inbox** room on the signaling relay. The room id
   is `wall-` + first 24 hex of `sha256(inboxSecret)`; `inboxSecret` is
   HMAC-derived from the vault identity, so only that vault can host its inbox (the
   relay checks the hash).
2. The sender joins the recipient's inbox as a peer, negotiates a WebRTC
   DataChannel (`fny-safe-v1`, DTLS) and pushes one **envelope**.
3. Envelope = signed JSON header + encrypted chunks:
   * ephemeral X25519 → recipient X25519 ECDH → HKDF → AES-256-GCM key;
   * the item payload (data, role, expiry, vector clock) is encrypted under it;
   * file chunks are encrypted per 1 MiB chunk, with a Merkle root of the chunk
     ciphertexts in the header, verified chunk by chunk on receipt;
   * the header is signed with the sender's Ed25519 key.
4. The recipient verifies the signature, that it is the addressee, and the sender.
   An unknown sender lands in **pending** until accepted. Updates from editors and
   admins are merged with vector clocks; concurrent edits become a conflict.

The envelope is self-contained and transport-agnostic, so a future store-and-forward
mailbox can carry it unchanged (see follow-ups).

## Threat model

**Protected against**

* The Filenymous servers and the signaling relay: they never see vault content,
  keys, item titles or contact names. The relay sees inbox ids, timing, and IP
  addresses of peers that connect (as for any WebRTC signaling).
* Someone who copies the browser profile or the backup file without your password,
  phrase or passkey: everything is AES-256-GCM under a random DEK; the password
  wrap is Argon2id-hardened.
* Tampering with a share in transit or by a malicious relay: DTLS, plus an Ed25519
  signature and per-chunk Merkle verification.

**Not protected against — please read**

* **A compromised device.** Malware, a malicious browser extension, or someone
  using your unlocked session can read everything while the vault is open.
* **Memory.** Locking drops keys and wipes the buffers we control, on a
  **best-effort** basis. JavaScript engines may keep copies (strings, GC, JIT), so
  we do not claim that secrets are erased from RAM.
* **Clipboard.** The 30 s clear only works if the tab can still write to the
  clipboard; clipboard managers and OS history may keep copies.
* **Roles and expiry are client-enforced.** They are honoured by the recipient's
  Filenymous app, not by cryptography. Anyone you share with can copy what they
  have seen. Revoking a share or letting it expire does not un-share it.
* **Losing all unlock methods.** There is no reset and no server copy. Without the
  password, a passkey or the 24-word phrase, the vault is lost.
* **Clearing site data** deletes the vault. Export backups and accept the
  persistent-storage request.
* **Metadata to peers.** A recipient learns your handle and public keys.
* **HIBP.** When you click "check", the first 5 hex chars of each password's SHA-1
  are sent to `api.pwnedpasswords.com` (k-anonymity, padded responses). Nothing is
  sent unless you click.

## Limits in phase 1

* Both vaults must be open at the same time to deliver a share or an update; there
  is no offline delivery yet.
* One open tab per vault (OPFS access-handle lock).
* No browser extension / autofill yet.

## Follow-ups

* **Browser extension (UJ-05)**: autofill and save-on-submit, talking to the open
  vault tab.
* **Offline mailbox**: a TTL store-and-forward box on the relay holding sealed
  envelopes (already self-contained and signed) until the recipient comes online.

## Code map

`ui/src/safe/` — `crypto.ts` (KDF, wraps, phrase, signatures), `repo.ts` (SQLite
schema, items, versions, sharing, conflicts), `clock.ts` (vector clocks),
`safe.worker.ts` / `client.ts` (worker RPC), `transport.ts` (WebRTC delivery and
inbox), `passkey.ts` (PRF), `Safe*.tsx` (UI). Tests: `*.test.ts` (Vitest) and
`ui/e2e/safe.spec.ts` (Playwright, two browsers sharing over a local relay).
