# Document tab (local PDF tools)

`#document` (also `#doc`, `#pdf`) opens a PDF workspace that runs **entirely in the
browser**: files are read with the File API, rendered with pdf.js in a Web Worker and
edited with pdf-lib. Nothing is uploaded; the only network traffic is the optional
hand-off to the existing P2P transfer.

The feature is written from scratch on permissive libraries. No code from
PDFCraft (AGPL-3.0) is used, so the project stays MIT.

## Features (v1)

| Tool | What it does | Implementation |
|---|---|---|
| Viewer | pages, zoom (50–300 % / fit), thumbnails, keyboard page navigation | pdf.js canvas render, lazy thumbnails (IntersectionObserver) |
| Pages | reorder, rotate, duplicate, delete, multi-select, extract selection | edit list materialised with `applyPageEdits` |
| Merge | append other PDFs, reorder the queue | `mergePdfs` (form fields kept, first name wins) |
| Split | by ranges (`1-3, 5, 8-`) or every N pages → PDF or `.zip`; "keep only these pages" | `parseRanges`, `splitByRanges`, fflate |
| Form | fill AcroForm text / checkbox / dropdown / radio / list fields, optional flatten | `listFormFields`, `fillForm` |
| Text & signature | place text (size, colour) or a PNG/JPEG / hand-drawn signature, drag or move with arrow keys | `addOverlays` (rotation-aware coordinates) |
| Optimise | lossless: drop unreachable objects, Flate-compress unfiltered streams, object streams; strip metadata (Info, XMP, IDs, PieceInfo) | `optimise` |
| Export | download, **send with Filenymous** (review step of the P2P flow), **store in the Coffre-fort** | `handoff.ts` |

Coffre-fort integration: "Ranger dans le coffre-fort" opens the vault (unlock if needed)
with a new *file* item pre-filled with the PDF; a PDF item in the vault has an
"Ouvrir dans Document" button. The file goes through an in-memory slot
(`ui/src/document/handoff.ts`), never through storage.

Undo: 20 steps (page edits and every committed operation).

## Files

- `ui/src/document/pdfOps.ts`: pure pdf-lib operations (unit-tested, `pdfOps.test.ts`)
- `ui/src/document/pdfView.ts`: pdf.js loading and rendering (worker, hardening)
- `ui/src/document/DocumentPanel.tsx` and `document.css`: UI (lazy-loaded chunk)
- `ui/src/document/handoff.ts`: Document ↔ Coffre-fort hand-off
- `ui/e2e/document.spec.ts`: Playwright end-to-end

## Dependencies and licences

| Package | Version | Licence | Role |
|---|---|---|---|
| pdfjs-dist | 4.10.38 | Apache-2.0 | rendering (legacy build, for Safari < 17.4 / Firefox ESR) |
| pdf-lib | 1.17.1 | MIT | editing |
| @pdf-lib/standard-fonts | 1.0.0 | MIT | pdf-lib dependency |
| @pdf-lib/upng | 1.0.1 | MIT | pdf-lib dependency |
| pako | 1.x / 2.x | MIT AND Zlib | pdf-lib dependency |
| tslib | 2.x | 0BSD | pdf-lib dependency |
| fflate | already used | MIT | zip of split outputs, Flate recompression |
| @napi-rs/canvas | 0.1.x (optional, Node only) | MIT | pdfjs-dist optional dependency, not bundled |

pdfjs-dist 5+/6 is not used yet: it requires Node ≥ 22.13 at install time and the
UI type-check CI job runs on Node 20.

## Security and deployment notes

- pdf.js runs with `isEvalSupported: false`, no XFA, no scripting/sandbox; the
  bytes are copied before being transferred to the worker.
- The worker is bundled by Vite (`?worker`) as a plain `.js` asset, so no `.mjs`
  MIME type is needed on the host. No WASM is involved.
- No CSP change is needed (the app has no global CSP). If one is added later it
  must allow `worker-src 'self'` and `img-src blob:` (overlay previews).
- The tab is a separate lazy chunk (~970 kB, ~340 kB gzip, plus the 1.3 MB
  worker): nothing is loaded until `#document` is opened.

## Known limits (v1)

- Annotations and signatures are drawn into the page content. They are not editable
  PDF annotation objects, and they are not a certified electronic signature (PAdES).
- Text uses the standard Helvetica font (WinAnsi): non-Latin characters (emoji,
  CJK, Arabic…) are dropped in added text and filled form fields.
- Encrypted PDFs can be viewed and sent but not edited (pdf-lib cannot decrypt);
  PDFs that need a password to open are refused.
- pdf.js cMaps and standard-font data are not shipped: non-embedded CJK fonts may
  render with fallbacks (system fonts are used).
- "Optimise" is lossless only: images are not downsampled, so gains depend on the file.
- Page edits rebuild the document. Form fields on kept pages are carried over, but
  bookmarks (outline), named destinations, and document-level JavaScript/attachments
  are dropped.
