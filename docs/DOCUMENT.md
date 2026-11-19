# Document tab (local editor and PDF tools)

`#document` (also `#doc`, `#pdf`) opens a Word-like workspace that runs **entirely in
the browser**. `#document-new` (also `#doc-new`) starts a blank document. It has two modes:

- **Text documents**: created from scratch ("Nouveau document"), opened from `.md` /
  `.txt`, or converted from a PDF's text. Edited in a rich-text editor (TipTap /
  ProseMirror) and saved as a real text **PDF** or as **Markdown**.
- **PDF documents**: rendered with pdf.js in a Web Worker and edited with pdf-lib
  (pages, merge, split, forms, text and signature, optimise).

Files are read with the File API. Nothing is uploaded; the only network traffic is the
optional hand-off to the existing P2P transfer.

The feature is written from scratch on permissive libraries. No code from
PDFCraft (AGPL-3.0) is used, so the project stays MIT.

## Word-like chrome (both modes)

- **Header**: the file name is editable in place (rename; `F2`). The extension follows
  the save format.
- **Menu bar**: *Fichier* (Nouveau, Ouvrir, Renommer, Enregistrer sous…, Enregistrer en
  PDF / en Markdown, Envoyer en P2P…, Ranger dans le coffre-fort…, Convertir en
  document éditable (PDF), Fermer), *Édition* (Annuler / Rétablir, Couper / Copier /
  Coller, Tout sélectionner, Rechercher), *Insertion* and *Format* (text) or *Pages* and
  *Outils PDF* (PDF). Menus are keyboard navigable (arrows, Home/End, Esc).
- **"Enregistrer sous" dialog** (`Ctrl+S`): file name, format (PDF / Markdown), then
  *Télécharger*, *Envoyer en P2P* or *Coffre-fort*. The export bar at the bottom offers
  the same three destinations with a format picker.
- **Shortcuts**: `Ctrl+S` save as, `Ctrl+O` open, `Alt+N` new document (browsers
  reserve `Ctrl+N`), `Ctrl+Z` / `Ctrl+Y` (or `Ctrl+Shift+Z`) undo / redo, `F2` rename.
  `Cmd` replaces `Ctrl` on macOS.

## Text editor

| Feature | Details |
|---|---|
| Toolbar | undo / redo, paragraph style (Paragraphe, Titre 1–4, Citation, Code), bold / italic / underline / strike / inline code, bulleted and numbered lists, indent / outdent, alignment (left, centre, right, justify), link (`Ctrl+K`), image (file picker, drag-and-drop or paste; PNG, JPEG, GIF, WebP ≤ 8 MB, stored inline), table (3×3 with header row; add / delete rows and columns), horizontal line, page break (`Ctrl+Enter`; `Shift+Enter` is a line break), cut / copy / paste, select all, find, clear formatting |
| Find / replace | `Ctrl+F`: case-insensitive, next / previous, replace, replace all |
| Open | `.md` (markdown-it, raw HTML **not** rendered), `.txt` (blank line = paragraph) |
| Save as PDF | A4, 2.2 cm margins, page numbers, real selectable / searchable text in **Noto Sans** (4 styles, embedded and subset), headings, paragraphs and alignment, bold / italic / underline / strike, inline code and code blocks (Courier), clickable links, nested lists, quotes, tables, images (PNG / JPEG directly, other formats converted with a canvas), horizontal lines, page breaks |
| Save as Markdown | GitHub-flavoured (tables, `~~strike~~`); page break = `\newpage` (pandoc) |
| Draft | the document is kept in this browser (`localStorage`) while you type and offered again ("Reprendre le brouillon") after a reload; it is deleted once saved or when closed without saving |
| Convert a PDF | *Éditer le texte* / *Convertir en document éditable*: pdf.js text extraction (lines and paragraphs rebuilt from positions), one page break per PDF page. **Text only**: layout, columns, images and fonts are lost; scanned PDFs have no text |

The PDF writer (`pdfExport.ts`) is our own layout engine on pdf-lib: it walks the
editor's ProseMirror JSON, wraps lines with the font metrics and paginates. Characters
outside the embedded font (emoji, CJK, Arabic, Hebrew, Indic scripts…) are replaced by `?`.

## Pages panel

The thumbnails no longer repeat a mini-menu under every page. Instead:

- **Selection**: click (one page), `Ctrl`/`Cmd`+click (add / remove), `Shift`+click
  (range); selected thumbnails are highlighted, the counter shows the selection.
- **One shared toolbar** above the thumbnails: rotate left / right, duplicate, move up /
  down, delete. Actions apply to the selection, or to the displayed page.
- **Drag-and-drop** of the selected pages to reorder (insertion line shown).
- **Right-click** (or the context-menu key / `Shift+F10`): rotate, duplicate, cut /
  copy / paste pages, move up / down / to start / to end, extract as PDF, delete.
- **Keyboard** in the list: arrows / `Home` / `End` (with `Shift` to extend), `Ctrl+A`,
  `Delete` / `Backspace`, `Ctrl+C` / `Ctrl+X` / `Ctrl+V` (pages are pasted after the
  selection), `Ctrl+D` duplicate, `Ctrl+↑` / `Ctrl+↓` move, `Esc` clear.
- The right-hand *Pages* panel keeps select all / clear, extract and delete the selection.

Selection and reordering logic is pure and unit-tested (`pageSelection.ts`).

## PDF tools

| Tool | What it does | Implementation |
|---|---|---|
| Viewer | pages, zoom (50–300 % / fit), thumbnails, keyboard page navigation | pdf.js canvas render, lazy thumbnails (IntersectionObserver) |
| Pages | reorder, rotate, duplicate, delete, multi-select, extract selection | edit list materialised with `applyPageEdits` |
| Merge | append other PDFs, reorder the queue | `mergePdfs` (form fields kept, first name wins) |
| Split | by ranges (`1-3, 5, 8-`) or every N pages → PDF or `.zip`; "keep only these pages" | `parseRanges`, `splitByRanges`, fflate |
| Form | fill AcroForm text / checkbox / dropdown / radio / list fields, optional flatten | `listFormFields`, `fillForm` |
| Text & signature | place text (size, colour) or a PNG/JPEG / hand-drawn signature, drag or move with arrow keys | `addOverlays` (rotation-aware coordinates) |
| Optimise | lossless: drop unreachable objects, Flate-compress unfiltered streams, object streams; strip metadata (Info, XMP, IDs, PieceInfo) | `optimise` |
| Export | PDF or Markdown (text of the PDF): download, **send with Filenymous** (review step of the P2P flow), **store in the Coffre-fort** | `handoff.ts`, `pdfText.ts` |

Coffre-fort integration: "Ranger dans le coffre-fort" opens the vault (unlock if needed)
with a new *file* item pre-filled with the PDF; a PDF item in the vault has an
"Ouvrir dans Document" button. The file goes through an in-memory slot
(`ui/src/document/handoff.ts`), never through storage.

Undo / redo: 20 steps (page edits and every committed operation) in PDF mode; the
editor has its own unlimited history in text mode.

## Files

- `ui/src/document/DocumentPanel.tsx` and `document.css`: panel, PDF mode, Pages panel (lazy chunk)
- `ui/src/document/TextEditor.tsx` and `editor.css`: Word-like editor (separate lazy chunk)
- `ui/src/document/chrome.tsx`: menu bar, context menu, file-name field, "Enregistrer sous" dialog, shortcuts, export bar
- `ui/src/document/pdfExport.ts`: editor JSON → A4 text PDF (lazy chunk, with fontkit)
- `ui/src/document/fonts.ts`, `fonts/`: Noto Sans (OFL, gzip, fetched on first PDF export)
- `ui/src/document/markdown.ts`: Markdown ⇄ editor HTML (markdown-it, turndown)
- `ui/src/document/pdfText.ts`: PDF text extraction (lines → paragraphs)
- `ui/src/document/pageSelection.ts`: Pages panel selection / reorder logic
- `ui/src/document/fileName.ts`, `draft.ts`: names / extensions, local draft
- `ui/src/document/pdfOps.ts`: pure pdf-lib operations
- `ui/src/document/pdfView.ts`: pdf.js loading and rendering (worker, hardening)
- `ui/src/document/handoff.ts`: Document ↔ Coffre-fort hand-off
- Unit tests (`*.test.ts`, run in CI): `pdfOps`, `pdfExport` (text, accents and styles checked with pdf.js), `markdown`, `pageSelection`, `pdfText`, `handoff`
- Playwright (CI job "Document tab"): `e2e/document.spec.ts` (PDF tools, Coffre-fort), `e2e/document-editor.spec.ts` (new document → format → save PDF / MD, Markdown open, find / replace, draft, Pages panel, PDF → MD / editable); `e2e/document-shots.spec.ts` takes screenshots when `DOC_SHOTS=<dir>` is set

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
| @tiptap/core, react, pm, starter-kit, extension-text-align, extension-image, extension-table, extension-hard-break, extensions | 3.34.0 | MIT | editor (ProseMirror based) |
| prosemirror-* (via @tiptap/pm) | 1.x | MIT | editor engine |
| fast-equals, use-sync-external-store | 5.x, 1.x | MIT | @tiptap/react dependencies |
| linkifyjs | 4.x | MIT | link extension |
| markdown-it (+ linkify-it, mdurl, uc.micro, punycode.js) | 14.x | MIT | Markdown import |
| entities | 6.x | BSD-2-Clause | markdown-it dependency |
| turndown | 7.2.5 | MIT | Markdown export |
| @mixmark-io/domino | 2.x | BSD-2-Clause | turndown dependency (Node only) |
| turndown-plugin-gfm | 1.0.2 | MIT | GFM tables / strike in Markdown export |
| @pdf-lib/fontkit | 1.1.1 | MIT | embedding TrueType fonts in pdf-lib |
| Noto Sans (font files, subset) | 2.x | SIL OFL 1.1 | text of exported PDFs (`fonts/OFL.txt`) |

No GPL / AGPL / LGPL code: everything above is MIT, Apache-2.0, BSD, 0BSD, Zlib or (fonts) OFL.

pdfjs-dist 5+/6 is not used yet: it requires Node ≥ 22.13 at install time and the
UI type-check CI job runs on Node 20.

## Security and deployment notes

- pdf.js runs with `isEvalSupported: false`, no XFA, no scripting/sandbox; the
  bytes are copied before being transferred to the worker.
- The worker is bundled by Vite (`?worker`) as a plain `.js` asset, so no `.mjs`
  MIME type is needed on the host. No WASM is involved.
- No CSP change is needed (the app has no global CSP). If one is added later it
  must allow `worker-src 'self'` and `img-src blob:` (overlay previews).
- The tab is a separate lazy chunk (~990 kB, ~350 kB gzip, plus the 1.3 MB
  worker): nothing is loaded until `#document` is opened. The editor is a further
  lazy chunk (~490 kB, ~155 kB gzip) loaded only for text documents; Markdown
  (~110 kB) and the PDF writer with fontkit (~635 kB, ~350 kB gzip) plus the fonts
  (4 × ~105 kB) are loaded only when used.
- Fonts are served as `.ttf.gz` and inflated in the browser (fflate); if the host
  already decodes them (`Content-Encoding`), the raw TTF is used as is.
- Markdown import does not render raw HTML; pasted / imported HTML only keeps the
  editor's schema (no scripts, no event attributes); links are limited to safe
  protocols, and links written to PDFs to `http(s):`, `mailto:` and `tel:`.

## Known limits

Text editor:

- The PDF is a new document laid out by our engine, not a pixel copy of the editor:
  line breaks may differ slightly; no headers / footers, footnotes, columns, text
  colours or font choice (Noto Sans only); tables have equal-width columns and a row
  taller than a page is clipped.
- Characters outside Latin / Greek / Cyrillic (emoji, CJK, Arabic, Hebrew…) become `?`
  in the PDF (they are kept in Markdown).
- Markdown has no underline, alignment or image size: they are dropped on export.
  Images are embedded as `data:` URLs, so Markdown files with images are large.
- Images referenced by URL (pasted HTML, Markdown) are loaded from that site by the
  browser; they are omitted from the PDF when the site does not allow it (CORS).
- The draft lives in `localStorage` (~5 MB): very large documents with images may
  not fit (the editor keeps working; the draft is just not updated).
- The menu's *Copier / Couper / Coller* use the browser clipboard API; when a browser
  refuses, the message points to `Ctrl+C` / `Ctrl+X` / `Ctrl+V`, which always work.
- "Convertir en document éditable" keeps the text only (see above).

PDF tools:

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
