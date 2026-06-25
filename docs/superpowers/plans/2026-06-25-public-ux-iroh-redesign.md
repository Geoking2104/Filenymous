# Public UX + Iroh Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the public Filenymous page around simple send/receive/file actions and document Iroh as the advanced transfer direction.

**Architecture:** Keep the current single-file public app in `docs/demo/index.html`, preserving existing DOM IDs and JavaScript functions. Add Iroh and public-directory messaging as UI and configuration-ready architecture, without adding a premature WASM dependency.

**Tech Stack:** Static HTML/CSS/JavaScript, WebCrypto, WebRTC DataChannel, Holochain/HWC hooks, future Iroh v1/iroh-blobs integration.

---

### Task 1: Public Information Architecture

**Files:**
- Modify: `docs/demo/index.html`

- [x] Replace tab labels with public-language destinations while preserving tab IDs.
- [x] Redesign `panel-room` as the home hub with three primary actions.
- [x] Keep "Salon de transfert", "Pairs presents", "mode autonome", and "Holo Web Conductor" copy for regression coverage.
- [x] Add transport cards for WebRTC direct, Iroh fallback/native, and Holochain advanced.

### Task 2: Send/Receive Simplification

**Files:**
- Modify: `docs/demo/index.html`

- [x] Add step-oriented copy above the file drop zone.
- [x] Keep `file-input`, `btn-send`, `p2p-result`, `p2p-code-out`, and `p2p-send-status`.
- [x] Put the one-time-code receive path before manual encrypted-link entry.
- [x] Keep `p2p-code-input`, `joinP2PReceive`, and `p2p-recv-status`.

### Task 3: Public Directory And Advanced Networks

**Files:**
- Modify: `docs/demo/index.html`

- [x] Add a "Repertoire public ouvert" area in the Files panel that explains public links without exposing raw server listing.
- [x] Reframe Identity as "Reseaux avances".
- [x] Add Iroh v1 and iroh-blobs copy with clear browser limitations.
- [x] Keep Holochain identity controls and existing element IDs.

### Task 4: Verification

**Files:**
- Test: `tests/src/static_room_demo.test.ts`
- Test: `tests/src/web_mode_standalone.test.ts`
- Test: `tests/src/p2p_direct.test.ts`

- [x] Run the static/P2P web tests.
- [x] Run the UI build or targeted static syntax check.
- [x] Validate the rendered page at desktop and mobile widths.
- [ ] If deployment is requested after validation, push GitHub and upload `docs/demo/index.html` to OVH web root.
