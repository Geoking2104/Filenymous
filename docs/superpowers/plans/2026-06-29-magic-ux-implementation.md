# Magic UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Filenymous `v0.3 Magic UX`: a one-screen public transfer workspace with Magic Link/one-time-code sharing, QR, clear progress, and folder or multi-file preparation while preserving existing web-only P2P behavior.

**Architecture:** Keep the current static public app in `docs/demo/index.html` as the source of truth and copy it to `filenymous-app.html` after each HTML change. Add small inline helper modules inside the existing script: transfer state, selected payload preparation, share artifact rendering, and progress estimates. Keep Iroh/Holochain technical copy out of the primary home path and leave it in Advanced/security areas.

**Tech Stack:** Static HTML/CSS/JavaScript, WebCrypto, WebRTC DataChannel, IndexedDB, local QR generator, Vitest static tests, Vite UI build smoke check.

---

## File Structure

- Modify `docs/demo/index.html`: public Magic UX markup, CSS, i18n keys, transfer state helpers, folder/multi-file handling, progress UI, share artifact rendering.
- Modify `filenymous-app.html`: synchronized copy of `docs/demo/index.html`.
- Create `tests/src/magic_ux.test.ts`: targeted static tests for Magic UX, no-jargon primary copy, transfer state helpers, folder controls, progress UI, and packaged HTML sync expectations.
- Modify `tests/src/web_mode_standalone.test.ts`: keep existing public fallback expectations aligned with new Magic Link wording.
- Modify `tests/src/p2p_direct.test.ts`: preserve direct P2P behavior checks if wording changes from "Direct P2P - One-time code" to a more public label.

Do not touch Rust/Holochain zomes in this release. Do not deploy to OVH or GitHub Pages until implementation, tests, and browser QA are complete and explicitly approved.

---

### Task 1: Add Magic UX Static Regression Tests

**Files:**
- Create: `tests/src/magic_ux.test.ts`
- Modify: `tests/src/web_mode_standalone.test.ts`

- [ ] **Step 1: Write the failing Magic UX test file**

Create `tests/src/magic_ux.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, "../../docs/demo/index.html"), "utf8");
const packagedHtml = readFileSync(path.join(__dirname, "../../filenymous-app.html"), "utf8");

function stripScriptsAndStyles(source: string): string {
  return source
    .replace(/<script(?:[^>]*)>[\s\S]*?<\/script>/g, "")
    .replace(/<style(?:[^>]*)>[\s\S]*?<\/style>/g, "");
}

function panel(source: string, id: string): string {
  const start = source.indexOf(`<section id="${id}"`);
  if (start < 0) return "";
  const next = source.indexOf("<section id=", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

const visibleHtml = stripScriptsAndStyles(html);
const visiblePackagedHtml = stripScriptsAndStyles(packagedHtml);
const primaryHome = stripScriptsAndStyles(panel(html, "panel-room"));

describe("Magic UX public transfer workspace", () => {
  it("makes Magic Link the primary public transfer action", () => {
    for (const phrase of [
      "Create Magic Link",
      "Add files or folder",
      "Share by link, code, or QR",
      "Keep this page open during direct transfer",
    ]) {
      expect(visibleHtml).toContain(phrase);
      expect(visiblePackagedHtml).toContain(phrase);
    }
  });

  it("keeps technical network jargon out of the primary home workspace", () => {
    for (const phrase of ["Iroh", "Holochain", "Holo Web Conductor", "WebRTC", "conductor"]) {
      expect(primaryHome).not.toContain(phrase);
    }
  });

  it("ships folder and multi-file controls with accessible fallbacks", () => {
    expect(html).toContain('id="home-folder-input"');
    expect(html).toContain("webkitdirectory");
    expect(html).toContain('id="home-file-input"');
    expect(html).toContain("multiple");
    expect(visibleHtml).toContain("Folder support depends on your browser");
  });

  it("defines a shared transfer state model and share artifact renderer", () => {
    for (const token of [
      "TRANSFER_STATES",
      "setTransferState",
      "createShareArtifact",
      "renderShareArtifact",
      "prepareSelectedPayload",
      "estimateTransferTime",
    ]) {
      expect(html).toContain(token);
      expect(packagedHtml).toContain(token);
    }
  });

  it("shows progress, speed, estimate, and download-location guidance", () => {
    for (const id of [
      'id="magic-progress"',
      'id="magic-progress-fill"',
      'id="magic-progress-label"',
      'id="magic-progress-estimate"',
      'id="magic-download-location"',
    ]) {
      expect(html).toContain(id);
      expect(packagedHtml).toContain(id);
    }
    expect(visibleHtml).toContain("Downloads folder");
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run:

```bash
npm test --prefix tests -- --run src/magic_ux.test.ts
```

Expected: FAIL because `Create Magic Link`, folder controls, `TRANSFER_STATES`, and progress IDs do not exist yet.

- [ ] **Step 3: Update the existing standalone test expectations**

In `tests/src/web_mode_standalone.test.ts`, update the home-entry expectations to include Magic Link while preserving existing behavior:

```ts
it("makes the home page a usable transfer entry point", () => {
  expect(html).toContain('id="home-file-input"');
  expect(html).toContain('id="home-send-btn"');
  expect(html).toContain("createFromHome");
  expect(visibleHtml).toContain("Add files or folder");
  expect(visibleHtml).toContain("Create Magic Link");
  expect(packagedHtml).toContain('id="home-file-input"');
});
```

Also update the simplified home message test:

```ts
it("uses the simplified public home message", () => {
  expect(visibleHtml).toContain("Send files with one private link");
  expect(visibleHtml).toContain("No cloud, no account");
  expect(visiblePackagedHtml).toContain("Send files with one private link");
});
```

- [ ] **Step 4: Run the affected tests to verify they fail**

Run:

```bash
npm test --prefix tests -- --run src/magic_ux.test.ts src/web_mode_standalone.test.ts
```

Expected: FAIL because the production HTML still has the old copy and missing Magic UX elements.

- [ ] **Step 5: Commit the failing tests**

```bash
git add tests/src/magic_ux.test.ts tests/src/web_mode_standalone.test.ts
git commit -m "test: define magic ux public transfer expectations"
```

---

### Task 2: Add Magic Workspace Markup And No-Jargon Home Copy

**Files:**
- Modify: `docs/demo/index.html`
- Modify: `filenymous-app.html`

- [ ] **Step 1: Replace the home transfer card markup**

In `docs/demo/index.html`, replace the current `.home-transfer-card` content inside `#panel-room` with:

```html
<section class="home-transfer-card" aria-label="Create a transfer" data-i18n-aria-label="home.transferCard">
  <div class="magic-drop-actions">
    <label class="home-drop" id="home-drop" for="home-file-input" tabindex="0">
      <input type="file" id="home-file-input" hidden multiple />
      <span>
        <span class="home-plus" aria-hidden="true">+</span>
        <span class="home-drop-title" data-i18n="home.addFile">Add files or folder</span>
        <span class="home-drop-copy" data-i18n="home.dropHint">Drop files here or click to choose them.</span>
      </span>
    </label>
    <button type="button" class="btn btn-secondary btn-full" id="home-folder-btn" onclick="chooseFolderFromHome(event)" data-i18n="home.chooseFolder">
      Choose folder
    </button>
    <input type="file" id="home-folder-input" hidden webkitdirectory directory multiple />
  </div>

  <div class="home-file-preview" id="home-file-preview" data-i18n="home.noFile">No file selected</div>
  <p class="muted magic-folder-note" data-i18n="home.folderSupport">Folder support depends on your browser. If it is unavailable, select multiple files instead.</p>

  <div id="magic-progress" class="magic-progress hidden" aria-live="polite">
    <div class="magic-progress-top">
      <span id="magic-progress-label" data-i18n="magic.idle">Ready</span>
      <span id="magic-progress-estimate">--</span>
    </div>
    <div class="progress-bar"><div id="magic-progress-fill" class="progress-fill" style="width:0%"></div></div>
    <p id="magic-download-location" class="muted" data-i18n="magic.downloadLocation">Received files appear in your browser Downloads folder unless you choose another location.</p>
  </div>

  <div class="home-actions">
    <button id="home-send-btn" class="btn btn-primary btn-full" onclick="createFromHome(event)" disabled>
      <span data-i18n="home.createCode">Create Magic Link</span>
    </button>
    <label class="human-proof" for="home-human-proof">
      <input type="checkbox" id="home-human-proof" />
      <span data-i18n="human.send">I am human and I am starting this share myself.</span>
    </label>
    <div class="home-secondary-row">
      <button class="btn btn-secondary" onclick="showTab('receive')" data-i18n="nav.receive">Receive</button>
      <button class="btn btn-secondary" onclick="openSendAdvanced(event)" data-i18n="home.options">Options</button>
    </div>
  </div>
</section>
```

- [ ] **Step 2: Replace the home headline and proof copy**

In the `.home-copy` block, use this copy:

```html
<section class="home-copy" aria-label="Overview" data-i18n-aria-label="home.presentation">
  <h1 data-i18n="home.title">Send files with one private link</h1>
  <p data-i18n="home.subtitle">No cloud, no account. Filenymous encrypts in your browser, then gives you a Magic Link, one-time code, or QR to share.</p>
  <div class="home-proof-list" aria-label="Guarantees" data-i18n-aria-label="home.guarantees">
    <div class="home-proof"><strong data-i18n="home.proof1Title">One gesture</strong><span data-i18n="home.proof1Copy">Add files, create the link, share it.</span></div>
    <div class="home-proof"><strong data-i18n="home.proof2Title">Local first</strong><span data-i18n="home.proof2Copy">Files are encrypted before sharing.</span></div>
    <div class="home-proof"><strong data-i18n="home.proof3Title">Clear progress</strong><span data-i18n="home.proof3Copy">Progress and time estimates stay visible.</span></div>
  </div>
</section>
```

- [ ] **Step 3: Replace shortcut labels with public wording**

Use:

```html
<div class="home-rail" aria-label="Shortcuts" data-i18n-aria-label="home.shortcuts">
  <button class="btn btn-secondary" onclick="showTab('receive')">
    <span><strong data-i18n="nav.receive">Receive</strong><span data-i18n="home.receiveHint">Enter a code or paste a link.</span></span>
  </button>
  <button class="btn btn-secondary" onclick="renderQrForCurrentLink()">
    <span><strong data-i18n="common.qrCode">QR code</strong><span data-i18n="home.qrHint">Share by camera scan.</span></span>
  </button>
  <button class="btn btn-secondary" onclick="showTab('history')">
    <span><strong data-i18n="nav.files">Files</strong><span data-i18n="home.filesHint">Local transfer history.</span></span>
  </button>
</div>
```

- [ ] **Step 4: Move network cards out of the primary home**

Keep the existing transport cards, room technical card, and mini-chat markup, but place them in the Advanced/Identity panel or leave them hidden from `#panel-room` with CSS:

```css
#panel-room > .app-hero,
#panel-room > .flow-steps,
#panel-room > .transport-grid,
#panel-room > .card,
#panel-room > .split-grid {
  display: none;
}
```

The key requirement is that `primaryHome` in `tests/src/magic_ux.test.ts` does not contain `Iroh`, `Holochain`, `Holo Web Conductor`, `WebRTC`, or `conductor`.

- [ ] **Step 5: Add CSS for the new controls**

Add near the existing `.home-*` CSS:

```css
.magic-drop-actions {
  display: grid;
  gap: 10px;
}
.magic-folder-note {
  margin: -4px 0 12px;
  font-size: 12px;
  line-height: 1.4;
}
.magic-progress {
  display: grid;
  gap: 8px;
  margin: 12px 0;
}
.magic-progress-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  font-weight: 700;
}
.magic-progress-top span:last-child {
  color: var(--muted);
  font-weight: 600;
}
```

- [ ] **Step 6: Copy source HTML to packaged HTML**

Run:

```powershell
Copy-Item -LiteralPath .\docs\demo\index.html -Destination .\filenymous-app.html -Force
```

- [ ] **Step 7: Run tests and verify Task 2 status**

Run:

```bash
npm test --prefix tests -- --run src/magic_ux.test.ts src/web_mode_standalone.test.ts
```

Expected: Some tests still FAIL because JavaScript helpers and i18n keys are not yet implemented, but the markup and no-jargon checks should move closer to green.

- [ ] **Step 8: Commit the markup**

```bash
git add docs/demo/index.html filenymous-app.html
git commit -m "feat: add magic ux public workspace"
```

---

### Task 3: Add Transfer State, Progress, And Share Artifact Helpers

**Files:**
- Modify: `docs/demo/index.html`
- Modify: `filenymous-app.html`

- [ ] **Step 1: Add transfer constants after the global state**

Find the existing `const S = { ... }` block and add these constants immediately after it:

```js
const TRANSFER_STATES = Object.freeze({
  IDLE: 'idle',
  SELECTING: 'selecting',
  ENCRYPTING: 'encrypting',
  READY_TO_SHARE: 'ready_to_share',
  WAITING_FOR_PEER: 'waiting_for_peer',
  TRANSFERRING: 'transferring',
  VERIFYING: 'verifying',
  COMPLETE: 'complete',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

S.transferState = TRANSFER_STATES.IDLE;
S.transferStartedAt = 0;
S.selectedFiles = [];
S.preparedPayload = null;
S.lastShareArtifact = null;
```

- [ ] **Step 2: Add progress helper functions near `setStatus`**

Insert after `setStatus`:

```js
function estimateTransferTime(doneBytes, totalBytes, startedAt = S.transferStartedAt) {
  if (!doneBytes || !totalBytes || !startedAt) return '--';
  const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1000);
  const bytesPerSecond = doneBytes / elapsedSeconds;
  if (!bytesPerSecond) return '--';
  const remainingSeconds = Math.max(0, Math.round((totalBytes - doneBytes) / bytesPerSecond));
  if (remainingSeconds < 60) return `${remainingSeconds}s left`;
  return `${Math.ceil(remainingSeconds / 60)}m left`;
}

function setMagicProgress(percent, label, doneBytes = 0, totalBytes = 0) {
  const panel = $('magic-progress');
  const fill = $('magic-progress-fill');
  const labelEl = $('magic-progress-label');
  const estimateEl = $('magic-progress-estimate');
  if (!panel || !fill || !labelEl || !estimateEl) return;
  panel.classList.remove('hidden');
  const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
  fill.style.width = `${safePercent}%`;
  labelEl.textContent = label;
  estimateEl.textContent = estimateTransferTime(doneBytes, totalBytes);
}

function setTransferState(nextState, detail = {}) {
  S.transferState = nextState;
  if (nextState === TRANSFER_STATES.ENCRYPTING || nextState === TRANSFER_STATES.TRANSFERRING) {
    S.transferStartedAt = Date.now();
  }
  const labels = {
    [TRANSFER_STATES.IDLE]: tr('magic.idle', 'Ready'),
    [TRANSFER_STATES.SELECTING]: tr('magic.selecting', 'Preparing selection...'),
    [TRANSFER_STATES.ENCRYPTING]: tr('magic.encrypting', 'Encrypting locally...'),
    [TRANSFER_STATES.READY_TO_SHARE]: tr('magic.ready', 'Ready to share'),
    [TRANSFER_STATES.WAITING_FOR_PEER]: tr('magic.waiting', 'Waiting for recipient...'),
    [TRANSFER_STATES.TRANSFERRING]: tr('magic.transferring', 'Transfer in progress...'),
    [TRANSFER_STATES.VERIFYING]: tr('magic.verifying', 'Checking transfer...'),
    [TRANSFER_STATES.COMPLETE]: tr('magic.complete', 'Complete'),
    [TRANSFER_STATES.FAILED]: tr('magic.failed', 'Transfer failed'),
    [TRANSFER_STATES.CANCELLED]: tr('magic.cancelled', 'Transfer cancelled'),
  };
  setMagicProgress(detail.percent ?? 0, detail.label || labels[nextState] || nextState, detail.doneBytes || 0, detail.totalBytes || 0);
}
```

- [ ] **Step 3: Add share artifact helpers near `currentShareLink`**

Insert before `function currentShareLink()`:

```js
function createShareArtifact({ kind, url = '', code = '', expiresAt = 0, transportHint = '', humanMessage = '' }) {
  return { kind, url, code, expiresAt, transportHint, humanMessage };
}

function renderShareArtifact(artifact) {
  S.lastShareArtifact = artifact;
  if (artifact.url) {
    $('link-text').textContent = artifact.url;
    $('link-result').classList.remove('hidden');
  }
  if (artifact.code) {
    $('p2p-code-out').textContent = artifact.code;
    $('p2p-result').classList.remove('hidden');
  }
  if (artifact.humanMessage) toast(artifact.humanMessage);
  setTransferState(TRANSFER_STATES.READY_TO_SHARE, { percent: 100, label: tr('magic.ready', 'Ready to share') });
}
```

- [ ] **Step 4: Use transfer state in P2P send**

In `window.startP2PSend`, after generating `code`, replace direct output/status setup with:

```js
const artifact = createShareArtifact({
  kind: 'one-time-code',
  code,
  transportHint: 'direct-p2p',
  humanMessage: tr('magic.codeReady', 'One-time code ready. Keep this page open.'),
});
renderShareArtifact(artifact);
setTransferState(TRANSFER_STATES.WAITING_FOR_PEER, { percent: 5, label: tr('magic.waiting', 'Waiting for recipient...') });
```

Keep the existing `$('p2p-result').classList.remove('hidden')` behavior if needed, but avoid duplicate code assignment.

- [ ] **Step 5: Use transfer state in web-link send**

In the bridge `handleSend` path:

```js
setTransferState(TRANSFER_STATES.ENCRYPTING, {
  percent: 15,
  label: tr('magic.encrypting', 'Encrypting locally...'),
  totalBytes: S.file.size,
});
```

After `createWebParcelLink`, replace direct link rendering with:

```js
renderShareArtifact(createShareArtifact({
  kind: 'magic-link',
  url: out.url,
  expiresAt: 0,
  transportHint: 'self-contained-link',
  humanMessage: tr('magic.linkReady', 'Magic Link ready to share.'),
}));
$('qr-panel').classList.add('hidden');
$('send-status').classList.add('hidden');
```

- [ ] **Step 6: Sync packaged HTML**

```powershell
Copy-Item -LiteralPath .\docs\demo\index.html -Destination .\filenymous-app.html -Force
```

- [ ] **Step 7: Run tests**

```bash
npm test --prefix tests -- --run src/magic_ux.test.ts src/web_mode_standalone.test.ts src/p2p_direct.test.ts
```

Expected: tests related to transfer state and share artifact should PASS. Folder preparation may still fail until Task 4.

- [ ] **Step 8: Commit helper implementation**

```bash
git add docs/demo/index.html filenymous-app.html
git commit -m "feat: add magic transfer state helpers"
```

---

### Task 4: Add Folder And Multi-File Payload Preparation

**Files:**
- Modify: `docs/demo/index.html`
- Modify: `filenymous-app.html`
- Modify: `tests/src/magic_ux.test.ts`

- [ ] **Step 1: Extend the test for ZIP fallback tokens**

Add this test to `tests/src/magic_ux.test.ts`:

```ts
it("prepares folder or multi-file selections as a local zip payload", () => {
  for (const token of [
    "createStoredZip",
    "dosDateTime",
    "crc32",
    "prepareSelectedPayload",
    "chooseFolderFromHome",
  ]) {
    expect(html).toContain(token);
    expect(packagedHtml).toContain(token);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test --prefix tests -- --run src/magic_ux.test.ts
```

Expected: FAIL because `createStoredZip`, `dosDateTime`, and `crc32` do not exist.

- [ ] **Step 3: Add ZIP helper functions**

Insert before `function pickFile(f)`:

```js
function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: dosDate };
}

function crc32(bytes) {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function writeU16(out, value) {
  out.push(value & 255, (value >>> 8) & 255);
}

function writeU32(out, value) {
  out.push(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255);
}

async function createStoredZip(files) {
  const encoder = new TextEncoder();
  const fileRecords = [];
  const output = [];
  for (const file of files) {
    const name = file.webkitRelativePath || file.name;
    const nameBytes = encoder.encode(name.replace(/\\/g, '/'));
    const bytes = new Uint8Array(await file.arrayBuffer());
    const checksum = crc32(bytes);
    const stamp = dosDateTime(new Date(file.lastModified || Date.now()));
    const offset = output.length;
    writeU32(output, 0x04034b50);
    writeU16(output, 20);
    writeU16(output, 0);
    writeU16(output, 0);
    writeU16(output, stamp.time);
    writeU16(output, stamp.date);
    writeU32(output, checksum);
    writeU32(output, bytes.byteLength);
    writeU32(output, bytes.byteLength);
    writeU16(output, nameBytes.byteLength);
    writeU16(output, 0);
    output.push(...nameBytes, ...bytes);
    fileRecords.push({ nameBytes, bytes, checksum, stamp, offset });
  }
  const centralOffset = output.length;
  for (const record of fileRecords) {
    writeU32(output, 0x02014b50);
    writeU16(output, 20);
    writeU16(output, 20);
    writeU16(output, 0);
    writeU16(output, 0);
    writeU16(output, record.stamp.time);
    writeU16(output, record.stamp.date);
    writeU32(output, record.checksum);
    writeU32(output, record.bytes.byteLength);
    writeU32(output, record.bytes.byteLength);
    writeU16(output, record.nameBytes.byteLength);
    writeU16(output, 0);
    writeU16(output, 0);
    writeU16(output, 0);
    writeU16(output, 0);
    writeU32(output, 0);
    writeU32(output, record.offset);
    output.push(...record.nameBytes);
  }
  const centralSize = output.length - centralOffset;
  writeU32(output, 0x06054b50);
  writeU16(output, 0);
  writeU16(output, 0);
  writeU16(output, fileRecords.length);
  writeU16(output, fileRecords.length);
  writeU32(output, centralSize);
  writeU32(output, centralOffset);
  writeU16(output, 0);
  return new File([new Uint8Array(output)], 'filenymous-files.zip', { type: 'application/zip' });
}
```

- [ ] **Step 4: Add payload preparation**

Insert after `createStoredZip`:

```js
async function prepareSelectedPayload(files) {
  const list = Array.from(files || []);
  if (!list.length) return null;
  setTransferState(TRANSFER_STATES.SELECTING, { percent: 5, label: tr('magic.selecting', 'Preparing selection...') });
  if (list.length === 1 && !list[0].webkitRelativePath) {
    S.selectedFiles = list;
    S.preparedPayload = list[0];
    return list[0];
  }
  const zip = await createStoredZip(list);
  S.selectedFiles = list;
  S.preparedPayload = zip;
  return zip;
}
```

- [ ] **Step 5: Update file input and drop handlers**

Replace the existing input/drop handlers with async versions:

```js
fi.addEventListener('change', async () => { if (fi.files.length) pickFile(await prepareSelectedPayload(fi.files)); });
if (homeFi) homeFi.addEventListener('change', async () => { if (homeFi.files.length) pickFile(await prepareSelectedPayload(homeFi.files)); });

dz.addEventListener('drop', async e => {
  e.preventDefault();
  dz.classList.remove('drag-over');
  if (e.dataTransfer.files.length) pickFile(await prepareSelectedPayload(e.dataTransfer.files));
});

if (homeDrop) {
  homeDrop.addEventListener('drop', async e => {
    e.preventDefault();
    homeDrop.classList.remove('drag-over');
    if (e.dataTransfer.files.length) pickFile(await prepareSelectedPayload(e.dataTransfer.files));
  });
}
```

Keep existing `dragover`, `dragleave`, and `keydown` handlers.

- [ ] **Step 6: Add folder button handler**

Add after `openSendAdvanced`:

```js
window.chooseFolderFromHome = function (event) {
  if (event) event.preventDefault();
  const folderInput = $('home-folder-input');
  if (!folderInput || !('webkitdirectory' in folderInput)) {
    toast(tr('magic.folderUnsupported', 'Folder picker unavailable. Select multiple files instead.'), 'warning');
    if (homeFi) homeFi.click();
    return;
  }
  folderInput.click();
};

const homeFolderInput = $('home-folder-input');
if (homeFolderInput) {
  homeFolderInput.addEventListener('change', async () => {
    if (homeFolderInput.files.length) pickFile(await prepareSelectedPayload(homeFolderInput.files));
  });
}
```

- [ ] **Step 7: Update `pickFile` preview for prepared ZIPs**

At the start of `pickFile(f)`, add:

```js
if (!f) return;
const selectedCount = S.selectedFiles?.length || 1;
const fileLabel = selectedCount > 1
  ? `${selectedCount} files - ${f.name}`
  : f.name;
```

Then replace `f.name` in preview text with `fileLabel` where the user-facing selection name is shown:

```js
badge.textContent = `${fileIcon(f.name)} ${fileLabel} - ${fmtBytes(f.size)}`;
homePreview.textContent = `${fileIcon(f.name)} ${fileLabel} - ${fmtBytes(f.size)}`;
```

- [ ] **Step 8: Sync packaged HTML**

```powershell
Copy-Item -LiteralPath .\docs\demo\index.html -Destination .\filenymous-app.html -Force
```

- [ ] **Step 9: Run tests**

```bash
npm test --prefix tests -- --run src/magic_ux.test.ts src/web_mode_standalone.test.ts src/p2p_direct.test.ts
```

Expected: PASS for Magic UX, standalone, and P2P direct tests.

- [ ] **Step 10: Commit folder/multi-file support**

```bash
git add docs/demo/index.html filenymous-app.html tests/src/magic_ux.test.ts
git commit -m "feat: prepare folders for magic transfers"
```

---

### Task 5: Add Magic UX i18n Keys For English, French, And Korean

**Files:**
- Modify: `docs/demo/index.html`
- Modify: `filenymous-app.html`
- Modify: `tests/src/magic_ux.test.ts`

- [ ] **Step 1: Extend tests for i18n keys**

Add to `tests/src/magic_ux.test.ts`:

```ts
it("localizes Magic UX labels across public languages", () => {
  for (const key of [
    "home.chooseFolder",
    "home.folderSupport",
    "home.qrHint",
    "home.filesHint",
    "magic.idle",
    "magic.selecting",
    "magic.encrypting",
    "magic.ready",
    "magic.waiting",
    "magic.transferring",
    "magic.complete",
    "magic.downloadLocation",
    "magic.linkReady",
    "magic.codeReady",
    "magic.folderUnsupported",
  ]) {
    expect(html).toContain(`"${key}"`);
    expect(packagedHtml).toContain(`"${key}"`);
  }
});
```

- [ ] **Step 2: Run the i18n test to verify it fails**

```bash
npm test --prefix tests -- --run src/magic_ux.test.ts
```

Expected: FAIL because new i18n keys are missing.

- [ ] **Step 3: Add English keys to `window.FILENYMOUS_I18N.en`**

Add these properties:

```js
"home.addFile": "Add files or folder",
"home.dropHint": "Drop files here or click to choose them.",
"home.createCode": "Create Magic Link",
"home.title": "Send files with one private link",
"home.subtitle": "No cloud, no account. Filenymous encrypts in your browser, then gives you a Magic Link, one-time code, or QR to share.",
"home.proof1Title": "One gesture",
"home.proof1Copy": "Add files, create the link, share it.",
"home.proof3Title": "Clear progress",
"home.proof3Copy": "Progress and time estimates stay visible.",
"home.chooseFolder": "Choose folder",
"home.folderSupport": "Folder support depends on your browser. If it is unavailable, select multiple files instead.",
"home.qrHint": "Share by camera scan.",
"home.filesHint": "Local transfer history.",
"magic.idle": "Ready",
"magic.selecting": "Preparing selection...",
"magic.encrypting": "Encrypting locally...",
"magic.ready": "Ready to share",
"magic.waiting": "Waiting for recipient...",
"magic.transferring": "Transfer in progress...",
"magic.verifying": "Checking transfer...",
"magic.complete": "Complete",
"magic.failed": "Transfer failed",
"magic.cancelled": "Transfer cancelled",
"magic.downloadLocation": "Received files appear in your browser Downloads folder unless you choose another location.",
"magic.linkReady": "Magic Link ready to share.",
"magic.codeReady": "One-time code ready. Keep this page open.",
"magic.folderUnsupported": "Folder picker unavailable. Select multiple files instead."
```

- [ ] **Step 4: Add French keys**

Add equivalent French values:

```js
"home.addFile": "Ajouter des fichiers ou un dossier",
"home.dropHint": "Glissez des fichiers ici ou cliquez pour les choisir.",
"home.createCode": "Créer le Magic Link",
"home.title": "Envoyez des fichiers avec un lien privé",
"home.subtitle": "Pas de cloud, pas de compte. Filenymous chiffre dans votre navigateur, puis vous donne un Magic Link, un code à usage unique ou un QR à partager.",
"home.proof1Title": "Un geste",
"home.proof1Copy": "Ajoutez les fichiers, créez le lien, partagez-le.",
"home.proof3Title": "Progression claire",
"home.proof3Copy": "La progression et le temps estimé restent visibles.",
"home.chooseFolder": "Choisir un dossier",
"home.folderSupport": "Le support des dossiers dépend de votre navigateur. Si indisponible, sélectionnez plusieurs fichiers.",
"home.qrHint": "Partager par scan caméra.",
"home.filesHint": "Historique local des transferts.",
"magic.idle": "Prêt",
"magic.selecting": "Préparation de la sélection...",
"magic.encrypting": "Chiffrement local...",
"magic.ready": "Prêt à partager",
"magic.waiting": "En attente du destinataire...",
"magic.transferring": "Transfert en cours...",
"magic.verifying": "Vérification du transfert...",
"magic.complete": "Terminé",
"magic.failed": "Transfert échoué",
"magic.cancelled": "Transfert annulé",
"magic.downloadLocation": "Les fichiers reçus apparaissent dans le dossier Téléchargements du navigateur, sauf si vous choisissez un autre emplacement.",
"magic.linkReady": "Magic Link prêt à partager.",
"magic.codeReady": "Code à usage unique prêt. Gardez cette page ouverte.",
"magic.folderUnsupported": "Sélecteur de dossier indisponible. Sélectionnez plusieurs fichiers à la place."
```

- [ ] **Step 5: Add Korean keys**

Add equivalent Korean values:

```js
"home.addFile": "파일 또는 폴더 추가",
"home.dropHint": "파일을 여기에 놓거나 클릭해서 선택하세요.",
"home.createCode": "Magic Link 만들기",
"home.title": "비공개 링크 하나로 파일 보내기",
"home.subtitle": "클라우드도 계정도 없습니다. Filenymous는 브라우저에서 암호화한 뒤 공유할 Magic Link, 일회용 코드 또는 QR을 만듭니다.",
"home.proof1Title": "한 번의 동작",
"home.proof1Copy": "파일을 추가하고 링크를 만든 뒤 공유합니다.",
"home.proof3Title": "명확한 진행률",
"home.proof3Copy": "진행률과 예상 시간이 계속 표시됩니다.",
"home.chooseFolder": "폴더 선택",
"home.folderSupport": "폴더 지원은 브라우저에 따라 다릅니다. 사용할 수 없으면 여러 파일을 선택하세요.",
"home.qrHint": "카메라 스캔으로 공유합니다.",
"home.filesHint": "로컬 전송 기록.",
"magic.idle": "준비됨",
"magic.selecting": "선택 항목 준비 중...",
"magic.encrypting": "로컬 암호화 중...",
"magic.ready": "공유 준비됨",
"magic.waiting": "수신자 대기 중...",
"magic.transferring": "전송 중...",
"magic.verifying": "전송 확인 중...",
"magic.complete": "완료",
"magic.failed": "전송 실패",
"magic.cancelled": "전송 취소됨",
"magic.downloadLocation": "받은 파일은 다른 위치를 선택하지 않는 한 브라우저 다운로드 폴더에 저장됩니다.",
"magic.linkReady": "Magic Link를 공유할 수 있습니다.",
"magic.codeReady": "일회용 코드가 준비되었습니다. 이 페이지를 열어 두세요.",
"magic.folderUnsupported": "폴더 선택을 사용할 수 없습니다. 대신 여러 파일을 선택하세요."
```

- [ ] **Step 6: Sync packaged HTML**

```powershell
Copy-Item -LiteralPath .\docs\demo\index.html -Destination .\filenymous-app.html -Force
```

- [ ] **Step 7: Run i18n alignment verification**

```powershell
@'
const fs = require('fs');
for (const f of ['docs/demo/index.html', 'filenymous-app.html']) {
  const h = fs.readFileSync(f, 'utf8');
  const i18n = JSON.parse(h.match(/window\.FILENYMOUS_I18N = (\{[\s\S]*?\n\});/)[1]);
  const keys = Object.keys(i18n.en).sort().join('\n');
  for (const lang of ['fr', 'ko']) {
    if (Object.keys(i18n[lang]).sort().join('\n') !== keys) throw new Error(`${f}: ${lang} keys differ`);
  }
  console.log(`${f}: i18n keys aligned`);
}
'@ | node -
```

Expected: both HTML files report `i18n keys aligned`.

- [ ] **Step 8: Run tests**

```bash
npm test --prefix tests -- --run src/magic_ux.test.ts src/web_mode_standalone.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit i18n**

```bash
git add docs/demo/index.html filenymous-app.html tests/src/magic_ux.test.ts
git commit -m "feat: localize magic ux copy"
```

---

### Task 6: Final Validation And Browser QA

**Files:**
- Modify only if validation reveals a bug:
  - `docs/demo/index.html`
  - `filenymous-app.html`
  - `tests/src/*.test.ts`

- [ ] **Step 1: Run targeted tests**

```bash
npm test --prefix tests -- --run src/magic_ux.test.ts src/web_mode_standalone.test.ts src/p2p_direct.test.ts src/p2p_signal_server.test.ts src/p2p_signal_hardening.test.ts src/p2p_signal_relay.test.ts
```

Expected: all listed test files PASS.

- [ ] **Step 2: Run UI build smoke test**

```bash
npm run build --prefix ui
```

Expected: build exits 0. Existing large chunk warning is acceptable if unchanged.

- [ ] **Step 3: Verify inline scripts and HTML sync**

```powershell
@'
const fs = require('fs');
for (const f of ['docs/demo/index.html', 'filenymous-app.html']) {
  const h = fs.readFileSync(f, 'utf8');
  const scripts = [...h.matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/g)];
  for (const [i, m] of scripts.entries()) new Function(m[1]);
  const i18n = JSON.parse(h.match(/window\.FILENYMOUS_I18N = (\{[\s\S]*?\n\});/)[1]);
  const keys = Object.keys(i18n.en).sort().join('\n');
  for (const lang of ['fr', 'ko']) {
    if (Object.keys(i18n[lang]).sort().join('\n') !== keys) throw new Error(`${f}: ${lang} keys differ`);
  }
  console.log(f + ': ' + scripts.length + ' inline scripts ok, i18n keys aligned');
}
'@ | node -

$a=(Get-FileHash .\docs\demo\index.html -Algorithm SHA256).Hash
$b=(Get-FileHash .\filenymous-app.html -Algorithm SHA256).Hash
if ($a -ne $b) { Write-Error "HTML files differ"; exit 1 }
"html sync ok $a"
```

Expected: inline scripts parse, dictionaries align, HTML hashes match.

- [ ] **Step 4: Run whitespace check**

```bash
git diff --check
```

Expected: no errors. CRLF warnings are acceptable on Windows if no whitespace errors are reported.

- [ ] **Step 5: Start local static server**

```powershell
Start-Process -WindowStyle Hidden -FilePath powershell.exe -ArgumentList @(
  '-NoProfile',
  '-Command',
  'cd "C:\Users\geoff\Documents\Claude\Projects\Filenymous\filenymous\.worktrees\holochain-sharedrop-defense"; npx --yes serve docs/demo -l 4173'
)
```

Expected: local site reachable at `http://127.0.0.1:4173/`.

- [ ] **Step 6: Browser QA checklist**

Use Chrome or the in-app browser at `http://127.0.0.1:4173/`.

Verify:

- home shows `Add files or folder`;
- primary CTA says `Create Magic Link`;
- no Iroh/Holochain/WebRTC/conductor jargon appears in the first viewport;
- selecting one file updates preview and enables the CTA;
- selecting several files prepares `filenymous-files.zip`;
- QR button renders a QR after a link is created;
- receive flow still accepts a link or `123-456-ABC` code;
- mobile width keeps buttons and text inside their containers.

- [ ] **Step 7: Commit validation fixes if needed**

If Task 6 required fixes:

```bash
git add docs/demo/index.html filenymous-app.html tests/src/magic_ux.test.ts tests/src/web_mode_standalone.test.ts tests/src/p2p_direct.test.ts
git commit -m "fix: polish magic ux validation"
```

If no fixes were required, do not create an empty commit.

---

## Production Handoff

After all tasks pass:

1. Report verification evidence to the user.
2. Ask for explicit approval to push and deploy.
3. Only after approval:
   - push the branch;
   - fast-forward `main` if appropriate;
   - tag the release as `v0.3.0` or the user-approved version;
   - deploy `docs/demo/index.html` to OVH;
   - verify GitHub Pages and OVH with cache-busting.

No automatic production deployment is part of this plan.

## Self-Review Notes

- Spec coverage: Release `v0.3 Magic Link UX` is covered by Tasks 1-6. Releases `v0.4 Reliability Moat` and `v0.5 Secure Rooms` are intentionally split into separate future plans.
- Placeholder scan: the plan contains no unresolved work markers or unspecified test steps.
- Type consistency: `TRANSFER_STATES`, `ShareArtifact`, `createShareArtifact`, `renderShareArtifact`, `prepareSelectedPayload`, and `estimateTransferTime` are defined before later tasks use them.
