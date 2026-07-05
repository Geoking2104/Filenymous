# Real Room P2P Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the local-only public ROOM demo with a working browser room flow: signaling, live presence, E2E chat, encrypted file transfer handoff, expiration/revocation, and two-window validation.

**Architecture:** Keep the existing one-time WebRTC sender/receiver relay unchanged. Add a separate in-memory `room-*` signaling namespace for group presence and encrypted room events, then wire the static web UI to that namespace with client-side AES-GCM payload encryption derived from the room invite key.

**Tech Stack:** Node.js `ws` signaling server, Vitest integration/static tests, browser Web Crypto, static HTML/JS deployed through GitHub Pages.

---

### Task 1: Room Signaling Contract

**Files:**
- Modify: `tests/src/p2p_signal_relay.test.ts`
- Modify: `tests/src/p2p_signal_server.test.ts`
- Modify: `p2p-signal/server.js`

- [ ] **Step 1: Write failing relay integration tests**

Add tests that connect two WebSocket clients with:

```ts
{ type: "room-join", roomId: "room-testabc", peerId: "alice", displayName: "Alice" }
{ type: "room-join", roomId: "room-testabc", peerId: "bob", displayName: "Bob" }
{ type: "room-event", roomId: "room-testabc", event: { kind: "chat", iv: "a", ciphertext: "b" } }
{ type: "room-close", roomId: "room-testabc", reason: "done" }
```

Expected behavior:

```ts
expect(joined.peers).toContainEqual({ peerId: "alice", displayName: "Alice" });
expect(peerJoined.peer).toEqual({ peerId: "bob", displayName: "Bob" });
expect(roomEvent).toMatchObject({ type: "room-event", from: "alice" });
expect(closed).toMatchObject({ type: "room-closed", roomId: "room-testabc" });
```

- [ ] **Step 2: Run the relay tests and verify RED**

Run:

```bash
cd tests
npm test -- src/p2p_signal_relay.test.ts src/p2p_signal_server.test.ts
```

Expected: failures mentioning missing `room-join`, `room-event`, or `room-close` behavior.

- [ ] **Step 3: Implement the room namespace**

Add `roomSessions = new Map()`, `validateRoomId`, `validateRoomPeerId`, `validateRoomEvent`, `joinRoomPeer`, `leaveRoomPeer`, `broadcastRoom`, and handlers for:

```js
room-join
room-event
room-close
room-leave
```

Preserve existing `join`, `signal`, and one-time-code behavior.

- [ ] **Step 4: Run room relay tests and verify GREEN**

Run:

```bash
cd tests
npm test -- src/p2p_signal_relay.test.ts src/p2p_signal_server.test.ts
```

Expected: all selected tests pass.

### Task 2: Live Room Presence in the Web UI

**Files:**
- Modify: `tests/src/web_mode_standalone.test.ts`
- Modify: `tests/src/static_room_demo.test.ts`
- Modify: `docs/demo/index.html`
- Sync: `filenymous-app.html`

- [ ] **Step 1: Write failing static UI tests**

Require the web app to contain:

```ts
expect(html).toContain("connectPublicRoom");
expect(html).toContain("room-join");
expect(html).toContain("room-peer-joined");
expect(html).toContain("room-peer-left");
expect(html).toContain("joinPublicRoomFromHash");
```

- [ ] **Step 2: Run the static tests and verify RED**

Run:

```bash
cd tests
npm test -- src/web_mode_standalone.test.ts src/static_room_demo.test.ts
```

Expected: failures for the missing room client functions.

- [ ] **Step 3: Implement room connection and presence**

Add browser functions:

```js
connectPublicRoom()
joinPublicRoomFromHash()
handlePublicRoomMessage(msg)
setPublicRoomPeers(peers)
```

Update `createPublicRoom()` to create a `room-*` id, derive a peer id, connect to the signaling server, and render connected peers in the room panel.

- [ ] **Step 4: Sync packaged HTML**

Run:

```powershell
Copy-Item docs\demo\index.html filenymous-app.html
```

- [ ] **Step 5: Run static tests and verify GREEN**

Run:

```bash
cd tests
npm test -- src/web_mode_standalone.test.ts src/static_room_demo.test.ts
```

Expected: all selected tests pass.

### Task 3: E2E Room Chat

**Files:**
- Modify: `tests/src/web_mode_standalone.test.ts`
- Modify: `docs/demo/index.html`
- Sync: `filenymous-app.html`

- [ ] **Step 1: Write failing static crypto tests**

Require browser runtime tokens:

```ts
expect(html).toContain("derivePublicRoomKey");
expect(html).toContain("encryptPublicRoomPayload");
expect(html).toContain("decryptPublicRoomPayload");
expect(html).toContain("room-event");
expect(html).toContain("kind: 'chat'");
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
cd tests
npm test -- src/web_mode_standalone.test.ts
```

Expected: missing chat crypto function failures.

- [ ] **Step 3: Implement chat encryption**

Use Web Crypto AES-GCM and a SHA-256 derived room key from the invite secret. Send chat messages as encrypted `room-event` payloads, and decrypt inbound payloads before rendering.

- [ ] **Step 4: Sync packaged HTML and verify GREEN**

Run:

```powershell
Copy-Item docs\demo\index.html filenymous-app.html
cd tests
npm test -- src/web_mode_standalone.test.ts
```

Expected: selected tests pass.

### Task 4: Encrypted Room File Transfer

**Files:**
- Modify: `tests/src/web_mode_standalone.test.ts`
- Modify: `docs/demo/index.html`
- Sync: `filenymous-app.html`

- [ ] **Step 1: Write failing static file transfer tests**

Require:

```ts
expect(html).toContain("sharePublicRoomFile");
expect(html).toContain("downloadPublicRoomFile");
expect(html).toContain("kind: 'file-offer'");
expect(html).toContain("kind: 'file-chunk'");
expect(html).toContain("kind: 'file-complete'");
expect(html).toContain("roomFileTransfers");
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
cd tests
npm test -- src/web_mode_standalone.test.ts
```

Expected: missing file transfer function failures.

- [ ] **Step 3: Implement encrypted chunk relay fallback**

Encrypt file chunks locally with the room key and send only ciphertext via room events. Render name, size, percent progress, and a download button for reconstructed received files. Keep copy clear that the server relays ciphertext only and stores nothing.

- [ ] **Step 4: Sync packaged HTML and verify GREEN**

Run:

```powershell
Copy-Item docs\demo\index.html filenymous-app.html
cd tests
npm test -- src/web_mode_standalone.test.ts
```

Expected: selected tests pass.

### Task 5: Expiry, Close, and Revocation

**Files:**
- Modify: `tests/src/p2p_signal_relay.test.ts`
- Modify: `tests/src/web_mode_standalone.test.ts`
- Modify: `p2p-signal/server.js`
- Modify: `docs/demo/index.html`
- Sync: `filenymous-app.html`

- [ ] **Step 1: Write failing tests**

Require `room-close` to notify peers and delete the room; require UI tokens:

```ts
expect(html).toContain("closePublicRoom");
expect(html).toContain("room-close");
expect(html).toContain("Room closed");
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
cd tests
npm test -- src/p2p_signal_relay.test.ts src/web_mode_standalone.test.ts
```

Expected: missing close/revocation behavior failures.

- [ ] **Step 3: Implement close controls**

Add a close button, send `room-close`, clear active transfers, block new sends after close, and show a visible status.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
cd tests
npm test -- src/p2p_signal_relay.test.ts src/web_mode_standalone.test.ts
```

Expected: selected tests pass.

### Task 6: Validation, Commit, Push, and Pages

**Files:**
- Verify all touched files.

- [ ] **Step 1: Run targeted test suite**

Run:

```bash
cd tests
npm test -- src/p2p_signal_relay.test.ts src/p2p_signal_server.test.ts src/web_mode_standalone.test.ts src/static_room_demo.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 2: Run broader CI-safe tests**

Run the existing web/P2P/Rust validation commands available in the repo. If a command is unavailable locally, record the exact error.

- [ ] **Step 3: Inspect git diff**

Run:

```bash
git diff -- docs/demo/index.html filenymous-app.html p2p-signal/server.js tests/src/p2p_signal_relay.test.ts tests/src/p2p_signal_server.test.ts tests/src/web_mode_standalone.test.ts tests/src/static_room_demo.test.ts docs/superpowers/plans/2026-07-03-real-room-p2p.md
git status --short --branch
```

- [ ] **Step 4: Commit and push main**

Run:

```bash
git add docs/demo/index.html filenymous-app.html p2p-signal/server.js tests/src/p2p_signal_relay.test.ts tests/src/p2p_signal_server.test.ts tests/src/web_mode_standalone.test.ts tests/src/static_room_demo.test.ts docs/superpowers/plans/2026-07-03-real-room-p2p.md
git commit -m "Add real public room signaling"
git push origin main
```

- [ ] **Step 5: Publish GitHub Pages**

Deploy the updated static site to `gh-pages` using the existing repo workflow or direct gh-pages branch update, then verify [https://geoking2104.github.io/Filenymous/](https://geoking2104.github.io/Filenymous/) loads the updated UI.

