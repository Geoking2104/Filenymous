# Public Room UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify the public Filenymous information architecture and expose Mode ROOM as a clear, usable transfer surface on GitHub Pages and in the React UI.

**Architecture:** Keep the current Magic Link/WebRTC flow intact. Add Rooms as a visible product mode, keep Holochain/Iroh details in Advanced, and update tests so the static page and React UI cannot regress to a jargon-heavy home.

**Tech Stack:** React 18, Vite, Zustand, static HTML demo, Vitest.

---

### Task 1: React Navigation And App Shell

**Files:**
- Modify: `ui/src/store/useStore.ts`
- Modify: `ui/src/components/Header.tsx`
- Modify: `ui/src/App.tsx`
- Test: `ui/src/components/RoomPanel.test.tsx`

- [ ] **Step 1: Update the tab model**

Set public tabs to `send`, `receive`, `rooms`, `history`, and `advanced`. Keep legacy panels accessible through the Advanced composite instead of top-level tabs.

- [ ] **Step 2: Simplify Header copy**

Replace the current mixed French/emoji navigation with plain labels: `Send`, `Receive`, `Rooms`, `History`, `Advanced`.

- [ ] **Step 3: Route the tabs**

Render `SendPanel`, `ReceivePanel`, `RoomPanel`, `HistoryPanel`, and an Advanced section containing identity, privacy, and wallet controls.

- [ ] **Step 4: Update RoomPanel tests**

Assert that the Room panel exposes a create-room action, an invite link, file input, peer area, and human-readable explanation.

### Task 2: Room Panel UX

**Files:**
- Modify: `ui/src/components/RoomPanel.tsx`

- [ ] **Step 1: Replace technical first impression**

Use simple copy: temporary private room, invite link, files, chat, participants, expiration.

- [ ] **Step 2: Make room creation visible**

Create a room ID and invite URL using `#/room/<roomId>#key=<inviteCode>`, show it in a copyable field, and show clear next steps.

- [ ] **Step 3: Keep current safe simulation**

Retain the demo peer and queued file requests so the UI remains usable without requiring a live Holochain conductor.

### Task 3: Static GitHub Pages Surface

**Files:**
- Modify: `docs/demo/index.html`
- Modify: `filenymous-app.html`
- Test: `tests/src/static_room_demo.test.ts`
- Test: `tests/src/magic_ux.test.ts`

- [ ] **Step 1: Add a visible Rooms nav item**

Keep Home as the landing workspace, then expose Send, Receive, Rooms, Files, and Advanced.

- [ ] **Step 2: Add `panel-rooms`**

Add a Mode ROOM section with create room, invite link, file picker, participant list, chat placeholder, and status feedback.

- [ ] **Step 3: Add room JavaScript**

Implement `createPublicRoom`, `copyPublicRoomLink`, `addPublicRoomFiles`, and `sendPublicRoomMessage` with local state only. The mode must be clearly marked as browser-first and encrypted-room-ready.

- [ ] **Step 4: Sync packaged HTML**

Copy `docs/demo/index.html` to `filenymous-app.html` after validation.

### Task 4: Documentation And Verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README English update**

Document Magic Link, Rooms, local browser encryption, GitHub Pages deployment, and the advanced network roadmap.

- [ ] **Step 2: Run tests**

Run `npm test --prefix ui -- --run` and the targeted static tests under `tests`.

- [ ] **Step 3: Build UI**

Run `npm run build --prefix ui`.

- [ ] **Step 4: GitHub deploy**

Commit to `main`, push, refresh the `gh-pages` static branch if needed, and verify GitHub Pages.
