/**
 * Document tab: view and edit PDFs entirely in the browser (pdf.js renders,
 * pdf-lib edits). Nothing is uploaded; the result can be downloaded, sent
 * with a Filenymous P2P transfer, or stored in the Coffre-fort.
 *
 * Model: `doc.bytes` is the committed PDF; page operations (reorder, rotate,
 * delete) are kept as a cheap `edits` list over it and only materialised
 * (pdf-lib) when another tool or an export needs real bytes. Every commit
 * pushes the previous state on an undo stack.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { zipSync } from "fflate";
import { formatBytes } from "../ux-v3/types";
import { useLeaveGuard } from "../home/confirmLeave";
import { handOff, takeHandoff } from "./handoff";
import {
  PdfOpError,
  addOverlays,
  applyPageEdits,
  chunkPages,
  displaySize,
  extractPages,
  fillForm,
  getInfo,
  listFormFields,
  looksLikePdf,
  mergePdfs,
  optimise,
  parseRanges,
  splitByRanges,
  type FormFieldInfo,
  type FormValues,
  type Overlay,
  type PageEdit,
  type PdfInfo,
} from "./pdfOps";
import { isPasswordError, openPdf, pageGeometry, renderPage, type PDFDocumentProxy } from "./pdfView";
import "./document.css";

type Tool = "pages" | "merge" | "split" | "form" | "annotate" | "optimise";
const TOOLS: Tool[] = ["pages", "merge", "split", "form", "annotate", "optimise"];

interface Doc {
  name: string;
  bytes: Uint8Array;
  pdf: PDFDocumentProxy;
  info: PdfInfo | null;
  /** Encrypted / unparsable by pdf-lib: viewing only. */
  readOnly: boolean;
}
interface UndoEntry {
  name: string;
  bytes: Uint8Array;
  edits: PageEdit[];
}
type UiOverlay = Overlay & { id: number; url?: string };
type NewOverlay = Overlay extends infer O ? (O extends Overlay ? Omit<O, "page"> & { url?: string } : never) : never;
type Msg = { kind: "ok" | "err" | "info"; text: string } | null;

const identity = (n: number): PageEdit[] => Array.from({ length: n }, (_, i) => ({ src: i, rotate: 0 }));
const isIdentity = (e: PageEdit[], n: number) => e.length === n && e.every((x, i) => x.src === i && x.rotate % 360 === 0);
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const MAX_PDF = 512 * 1024 * 1024;

function download(bytes: Uint8Array, name: string, type = "application/pdf") {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const baseName = (n: string) => n.replace(/\.pdf$/i, "") || "document";

export default function DocumentPanel({ onSend }: { onSend: (file: File) => void }) {
  const { t } = useTranslation();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [edits, setEdits] = useState<PageEdit[]>([]);
  const [undo, setUndo] = useState<UndoEntry[]>([]);
  const [cur, setCur] = useState(0);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [tool, setTool] = useState<Tool>("pages");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [dirty, setDirty] = useState(false);
  const [drag, setDrag] = useState(false);
  const [mergeQueue, setMergeQueue] = useState<{ name: string; bytes: Uint8Array }[]>([]);
  const [overlays, setOverlays] = useState<UiOverlay[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const overlaySeq = useRef(0);
  /**
   * Latest document / edits / overlays, readable synchronously inside async
   * actions that chain several commits (state only updates on next render).
   */
  const live = useRef<{ doc: Doc | null; edits: PageEdit[]; overlays: UiOverlay[] }>({ doc: null, edits: [], overlays: [] });
  const registerPlace = useCallback((fn: (x: number, y: number) => void) => {
    placeRef.current = fn;
  }, []);
  useLeaveGuard(dirty, { detail: "document.leaveDetail" });

  const errText = useCallback(
    (e: unknown) => {
      if (e instanceof PdfOpError) {
        if (e.code === "encrypted") return t("document.err.encrypted");
        if (e.code === "range") return t("document.err.range", { item: e.message });
        if (e.code === "empty") return t("document.err.empty");
        return t("document.err.invalid");
      }
      if (isPasswordError(e)) return t("document.err.password");
      return t("document.err.generic", { detail: (e as Error)?.message ?? String(e) });
    },
    [t],
  );

  /** Run an async action with the busy flag and error reporting. */
  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      setMsg(null);
      try {
        await fn();
      } catch (e) {
        setMsg({ kind: "err", text: errText(e) });
      } finally {
        setBusy(false);
      }
    },
    [errText],
  );

  // Free pdf.js resources of documents we no longer show.
  useEffect(() => {
    const pdf = doc?.pdf;
    return () => {
      void pdf?.destroy();
    };
  }, [doc?.pdf]);

  // Revoke overlay image URLs on unmount.
  useEffect(() => () => live.current.overlays.forEach((o) => o.url && URL.revokeObjectURL(o.url)), []);

  const setEditsLive = useCallback((e: PageEdit[]) => {
    live.current.edits = e;
    setEdits(e);
  }, []);
  const setOverlaysLive = useCallback((fn: (o: UiOverlay[]) => UiOverlay[]) => {
    live.current.overlays = fn(live.current.overlays);
    setOverlays(live.current.overlays);
  }, []);

  const show = useCallback(async (bytes: Uint8Array, name: string, keepPage = false) => {
    const pdf = await openPdf(bytes);
    let info: PdfInfo | null = null;
    let readOnly = false;
    try {
      info = await getInfo(bytes);
    } catch {
      readOnly = true;
    }
    const d = { name, bytes, pdf, info, readOnly };
    live.current.doc = d;
    setDoc(d);
    setEditsLive(identity(pdf.numPages));
    setSelected(new Set());
    setCur((c) => (keepPage ? Math.min(c, pdf.numPages - 1) : 0));
  }, [setEditsLive]);

  /** Replace the committed bytes (pushes the current state for undo). */
  const commit = useCallback(
    async (bytes: Uint8Array, name?: string) => {
      const { doc: d, edits: e } = live.current;
      if (d) setUndo((u) => [...u.slice(-19), { name: d.name, bytes: d.bytes, edits: e }]);
      await show(bytes, name ?? d?.name ?? "document.pdf", true);
      setDirty(true);
    },
    [show],
  );

  const pushEdits = (next: PageEdit[]) => {
    if (!doc) return;
    setUndo((u) => [...u.slice(-19), { name: doc.name, bytes: doc.bytes, edits }]);
    setEditsLive(next);
    setDirty(true);
  };

  const doUndo = () =>
    void run(async () => {
      const last = undo[undo.length - 1];
      if (!last || !doc) return;
      setUndo((u) => u.slice(0, -1));
      if (last.bytes !== doc.bytes) await show(last.bytes, last.name, true);
      setEditsLive(last.edits);
      setCur((c) => Math.min(c, last.edits.length - 1));
    });

  /** Committed bytes with pending page edits applied. */
  const materialize = useCallback(async (): Promise<Uint8Array> => {
    const { doc: d, edits: e } = live.current;
    if (!d) throw new PdfOpError("empty", "no document");
    if (isIdentity(e, d.pdf.numPages)) return d.bytes;
    const out = await applyPageEdits(d.bytes, e);
    await commit(out);
    return out;
  }, [commit]);

  const applyOverlays = useCallback(async (): Promise<Uint8Array> => {
    const base = await materialize();
    const list = live.current.overlays;
    if (list.length === 0) return base;
    const out = await addOverlays(base, list);
    list.forEach((o) => o.url && URL.revokeObjectURL(o.url));
    setOverlaysLive(() => []);
    await commit(out);
    return out;
  }, [commit, materialize, setOverlaysLive]);

  const openFiles = (list: FileList | File[] | null) => {
    const files = Array.from(list ?? []);
    if (files.length === 0) return;
    void run(async () => {
      const loaded: { name: string; bytes: Uint8Array }[] = [];
      for (const f of files) {
        if (f.size > MAX_PDF) throw new Error(t("document.err.tooBig", { name: f.name }));
        const bytes = new Uint8Array(await f.arrayBuffer());
        if (!looksLikePdf(bytes)) {
          setMsg({ kind: "err", text: t("document.err.notPdf", { name: f.name }) });
          continue;
        }
        loaded.push({ name: f.name, bytes });
      }
      if (loaded.length === 0) return;
      if (!live.current.doc) {
        const [first, ...rest] = loaded;
        await show(first.bytes, first.name);
        setUndo([]);
        setOverlaysLive(() => []);
        setDirty(false);
        if (rest.length) {
          setMergeQueue(rest);
          setTool("merge");
          setMsg({ kind: "info", text: t("document.merge.queued", { count: rest.length }) });
        } else setTool("pages");
      } else {
        setMergeQueue((q) => [...q, ...loaded]);
        setTool("merge");
      }
    });
  };

  // A PDF handed over by the Coffre-fort ("Open in Document").
  useEffect(() => {
    const f = takeHandoff("document");
    if (f) openFiles([f]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeDoc = () => {
    overlays.forEach((o) => o.url && URL.revokeObjectURL(o.url));
    live.current.doc = null;
    setDoc(null);
    setEditsLive([]);
    setUndo([]);
    setOverlaysLive(() => []);
    setMergeQueue([]);
    setDirty(false);
    setMsg(null);
  };

  const switchTool = (next: Tool) => {
    if (next === tool || !doc) return;
    void run(async () => {
      // Page-space tools need real bytes; annotations are baked when leaving.
      if (tool === "annotate" && live.current.overlays.length) await applyOverlays();
      if (next !== "pages") await materialize();
      setTool(next);
    });
  };

  const exportFile = async (): Promise<File> => {
    const bytes = await applyOverlays();
    const n = live.current.doc!.name;
    const name = /\.pdf$/i.test(n) ? n : `${n}.pdf`;
    return new File([bytes as Uint8Array<ArrayBuffer>], name, { type: "application/pdf" });
  };

  /* ── page operations (edit list) ── */
  const rotate = (i: number, by: number) => pushEdits(edits.map((e, k) => (k === i ? { ...e, rotate: (e.rotate + by + 360) % 360 } : e)));
  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= edits.length) return;
    const next = edits.slice();
    [next[i], next[j]] = [next[j], next[i]];
    pushEdits(next);
    setCur(j);
  };
  const remove = (idx: number[]) => {
    const drop = new Set(idx);
    const next = edits.filter((_, k) => !drop.has(k));
    if (next.length === 0) {
      setMsg({ kind: "err", text: t("document.err.lastPage") });
      return;
    }
    pushEdits(next);
    setSelected(new Set());
    setCur((c) => Math.min(c, next.length - 1));
  };
  const duplicate = (i: number) => pushEdits([...edits.slice(0, i + 1), { ...edits[i] }, ...edits.slice(i + 1)]);
  const rotateSelected = (by: number) => {
    const sel = selected.size ? selected : new Set(edits.map((_, i) => i));
    pushEdits(edits.map((e, k) => (sel.has(k) ? { ...e, rotate: (e.rotate + by + 360) % 360 } : e)));
  };
  const toggleSel = (i: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });

  if (!doc) {
    return (
      <section className="doc-panel doc-empty" data-testid="doc-panel">
        <p className="doc-lead">{t("document.lead")}</p>
        <label
          className={`pz-drop doc-drop${drag ? " is-drag" : ""}`}
          data-testid="doc-drop"
          tabIndex={0}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), fileInput.current?.click())}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            openFiles(e.dataTransfer.files);
          }}
        >
          <input ref={fileInput} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(e) => { openFiles(e.currentTarget.files); e.currentTarget.value = ""; }} data-testid="doc-file" />
          <span className="pz-drop-title">{t("document.dropTitle")}</span>
          <span className="pz-drop-btn" aria-hidden="true">＋ {t("document.choose")}</span>
          <span className="pz-drop-sub">{t("document.dropSub")}</span>
        </label>
        {busy && <p className="doc-status" role="status">{t("document.loading")}</p>}
        {msg && <p className={msg.kind === "err" ? "pz-err" : "doc-status"} role={msg.kind === "err" ? "alert" : "status"}>{msg.text}</p>}
        <p className="doc-privacy">🔒 {t("document.privacy")}</p>
      </section>
    );
  }

  const pageCount = edits.length;
  const curEdit = edits[Math.min(cur, pageCount - 1)] ?? edits[0];
  const editsPending = !isIdentity(edits, doc.pdf.numPages);
  const disabled = busy || doc.readOnly;

  return (
    <section className="doc-panel" data-testid="doc-panel" aria-busy={busy}>
      <div className="doc-bar">
        <div className="doc-file">
          <strong title={doc.name} data-testid="doc-name">📄 {doc.name}</strong>
          <small>
            {t("document.pages", { count: pageCount })} · {formatBytes(doc.bytes.length)}
            {editsPending ? ` · ${t("document.pendingEdits")}` : ""}
          </small>
        </div>
        <div className="doc-bar-actions">
          <button type="button" className="pz-btn-ghost" onClick={doUndo} disabled={busy || undo.length === 0} data-testid="doc-undo">
            ↶ {t("document.undo")}
          </button>
          <button type="button" className="pz-btn-ghost" onClick={closeDoc} disabled={busy} data-testid="doc-close">
            {t("document.close")}
          </button>
        </div>
      </div>
      {doc.readOnly && <p className="doc-note" role="note" data-testid="doc-readonly">{t("document.readOnly")}</p>}

      <div className="doc-tools" role="tablist" aria-label={t("document.toolsAria")}>
        {TOOLS.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            id={`doc-tab-${k}`}
            aria-selected={tool === k}
            aria-controls="doc-tool-panel"
            className={tool === k ? "on" : ""}
            disabled={busy || (doc.readOnly && k !== "pages")}
            onClick={() => switchTool(k)}
            data-testid={`doc-tool-${k}`}
          >
            {toolLabel(t, k)}
          </button>
        ))}
      </div>

      <div className="doc-work">
        <ol className="doc-thumbs" aria-label={t("document.thumbsAria")} data-testid="doc-thumbs">
          {edits.map((e, i) => (
            <li key={`${i}-${e.src}-${e.rotate}`} className={`doc-thumb${i === cur ? " is-current" : ""}${selected.has(i) ? " is-selected" : ""}`} data-testid="doc-thumb">
              <button type="button" className="doc-thumb-view" onClick={() => setCur(i)} aria-current={i === cur ? "page" : undefined} aria-label={t("document.goToPage", { n: i + 1 })}>
                <PageCanvas pdf={doc.pdf} src={e.src} rotate={e.rotate} fitWidth={104} lazy />
                <span className="doc-thumb-n">{i + 1}</span>
              </button>
              {tool === "pages" && !doc.readOnly && (
                <div className="doc-thumb-actions">
                  <label className="doc-check" title={t("document.select")}>
                    <input type="checkbox" checked={selected.has(i)} onChange={() => toggleSel(i)} aria-label={t("document.selectPage", { n: i + 1 })} data-testid="doc-select" />
                  </label>
                  <button type="button" onClick={() => move(i, -1)} disabled={busy || i === 0} aria-label={t("document.moveUp", { n: i + 1 })} title={t("document.moveUp", { n: i + 1 })}>↑</button>
                  <button type="button" onClick={() => move(i, 1)} disabled={busy || i === pageCount - 1} aria-label={t("document.moveDown", { n: i + 1 })} title={t("document.moveDown", { n: i + 1 })}>↓</button>
                  <button type="button" onClick={() => rotate(i, -90)} disabled={busy} aria-label={t("document.rotateLeft", { n: i + 1 })} title={t("document.rotateLeft", { n: i + 1 })}>⟲</button>
                  <button type="button" onClick={() => rotate(i, 90)} disabled={busy} aria-label={t("document.rotateRight", { n: i + 1 })} title={t("document.rotateRight", { n: i + 1 })} data-testid="doc-rotate">⟳</button>
                  <button type="button" onClick={() => duplicate(i)} disabled={busy} aria-label={t("document.duplicate", { n: i + 1 })} title={t("document.duplicate", { n: i + 1 })}><DuplicateIcon /></button>
                  <button type="button" className="doc-danger" onClick={() => remove([i])} disabled={busy || pageCount === 1} aria-label={t("document.deletePage", { n: i + 1 })} title={t("document.deletePage", { n: i + 1 })} data-testid="doc-delete">✕</button>
                </div>
              )}
            </li>
          ))}
        </ol>

        <div className="doc-viewer">
          <div className="doc-viewer-bar">
            <button type="button" className="pz-btn-ghost" onClick={() => setCur((c) => Math.max(0, c - 1))} disabled={cur === 0} aria-label={t("document.prev")}>‹</button>
            <span className="doc-pageno" data-testid="doc-pageno">{t("document.pageOf", { n: cur + 1, total: pageCount })}</span>
            <button type="button" className="pz-btn-ghost" onClick={() => setCur((c) => Math.min(pageCount - 1, c + 1))} disabled={cur >= pageCount - 1} aria-label={t("document.next")}>›</button>
            <span className="doc-spacer" />
            <button type="button" className="pz-btn-ghost" onClick={() => setZoom((z) => ZOOMS[Math.max(0, ZOOMS.indexOf(z === "fit" ? 1 : z) - 1)])} aria-label={t("document.zoomOut")}>−</button>
            <span className="doc-zoom" aria-live="polite">{zoom === "fit" ? t("document.fit") : `${Math.round(zoom * 100)} %`}</span>
            <button type="button" className="pz-btn-ghost" onClick={() => setZoom((z) => ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z === "fit" ? 1 : z) + 1)])} aria-label={t("document.zoomIn")}>+</button>
            <button type="button" className="pz-btn-ghost" onClick={() => setZoom("fit")} aria-pressed={zoom === "fit"} aria-label={t("document.fit")} title={t("document.fit")}>⤢</button>
          </div>
          <Viewer
            pdf={doc.pdf}
            edit={curEdit}
            index={cur}
            zoom={zoom}
            annotate={tool === "annotate"}
            overlays={overlays.filter((o) => o.page === cur)}
            onNavigate={(by) => setCur((c) => Math.min(pageCount - 1, Math.max(0, c + by)))}
            onPlace={(x, y) => placeRef.current?.(x, y)}
            onMove={(id, x, y) => setOverlaysLive((list) => list.map((o) => (o.id === id ? { ...o, x, y } : o)))}
            onRemove={(id) =>
              setOverlaysLive((list) => {
                const o = list.find((x) => x.id === id);
                if (o?.url) URL.revokeObjectURL(o.url);
                return list.filter((x) => x.id !== id);
              })
            }
          />
        </div>

        <div className="doc-side" id="doc-tool-panel" role="tabpanel" aria-labelledby={`doc-tab-${tool}`} data-testid="doc-side">
          {tool === "pages" && (
            <PagesTool
              selectedCount={selected.size}
              disabled={disabled}
              onRotateAll={rotateSelected}
              onDeleteSelected={() => remove([...selected])}
              onExtractSelected={() =>
                void run(async () => {
                  const order = [...selected].sort((a, b) => a - b);
                  const bytes = await applyPageEdits(doc.bytes, order.map((i) => edits[i]));
                  download(bytes, `${baseName(doc.name)}-${t("document.file.extract")}.pdf`);
                  setMsg({ kind: "ok", text: t("document.extracted", { count: order.length }) });
                })
              }
              onClearSelection={() => setSelected(new Set())}
              onSelectAll={() => setSelected(new Set(edits.map((_, i) => i)))}
            />
          )}
          {tool === "merge" && (
            <MergeTool
              current={doc.name}
              queue={mergeQueue}
              disabled={disabled}
              onAdd={(files) => openFiles(files)}
              onChange={setMergeQueue}
              onMerge={() =>
                void run(async () => {
                  const base = await applyOverlays();
                  const out = await mergePdfs([base, ...mergeQueue.map((q) => q.bytes)]);
                  const n = mergeQueue.length;
                  setMergeQueue([]);
                  await commit(out);
                  setMsg({ kind: "ok", text: t("document.merge.done", { count: n }) });
                })
              }
            />
          )}
          {tool === "split" && (
            <SplitTool
              pageCount={pageCount}
              disabled={disabled}
              onSplit={(groups) =>
                void run(async () => {
                  const bytes = await applyOverlays();
                  const parts = await splitByRanges(bytes, groups);
                  const b = baseName(doc.name);
                  if (parts.length === 1) download(parts[0], `${b}-${t("document.file.part")}-1.pdf`);
                  else {
                    const files: Record<string, Uint8Array> = {};
                    parts.forEach((p, i) => (files[`${b}-${t("document.file.part")}-${String(i + 1).padStart(2, "0")}.pdf`] = p));
                    download(zipSync(files, { level: 0 }), `${b}-${t("document.file.split")}.zip`, "application/zip");
                  }
                  setMsg({ kind: "ok", text: t("document.split.done", { count: parts.length }) });
                })
              }
              onKeep={(groups) =>
                void run(async () => {
                  const bytes = await applyOverlays();
                  await commit(await extractPages(bytes, groups.flat()));
                  setMsg({ kind: "ok", text: t("document.split.kept") });
                })
              }
              onError={(e) => setMsg({ kind: "err", text: errText(e) })}
            />
          )}
          {tool === "form" && (
            <FormTool
              key={doc.bytes.length + ":" + undo.length}
              bytes={doc.bytes}
              disabled={disabled}
              onApply={(values, flatten) =>
                void run(async () => {
                  await commit(await fillForm(doc.bytes, values, { flatten }));
                  setMsg({ kind: "ok", text: t("document.form.done") });
                })
              }
            />
          )}
          {tool === "annotate" && (
            <AnnotateTool
              disabled={disabled}
              count={overlays.length}
              registerPlace={registerPlace}
              onAdd={(o) => setOverlaysLive((list) => [...list, { ...o, id: ++overlaySeq.current, page: cur } as UiOverlay])}
              pageSize={() => pageGeometry(doc.pdf, curEdit.src).then((g) => displaySize({ ...g, rotation: g.rotation + curEdit.rotate }))}
              onApply={() =>
                void run(async () => {
                  const n = overlays.length;
                  await applyOverlays();
                  setMsg({ kind: "ok", text: t("document.annotate.done", { count: n }) });
                })
              }
              onClear={() => {
                overlays.forEach((o) => o.url && URL.revokeObjectURL(o.url));
                setOverlaysLive(() => []);
              }}
            />
          )}
          {tool === "optimise" && (
            <OptimiseTool
              info={doc.info}
              size={doc.bytes.length}
              disabled={disabled}
              onRun={(opts) =>
                void run(async () => {
                  const bytes = await applyOverlays();
                  const r = await optimise(bytes, opts);
                  await commit(r.bytes);
                  const pct = r.before ? Math.round(((r.before - r.after) / r.before) * 100) : 0;
                  setMsg({ kind: "ok", text: t("document.optimise.done", { before: formatBytes(r.before), after: formatBytes(r.after), pct }) });
                })
              }
            />
          )}
        </div>
      </div>

      {msg && (
        <p className={msg.kind === "err" ? "pz-err doc-msg" : "doc-status doc-msg"} role={msg.kind === "err" ? "alert" : "status"} data-testid="doc-msg">
          {msg.text}
        </p>
      )}

      <div className="doc-export" data-testid="doc-export">
        <button
          type="button"
          className="pz-btn"
          disabled={busy}
          data-testid="doc-download"
          onClick={() =>
            void run(async () => {
              const f = await exportFile();
              download(new Uint8Array(await f.arrayBuffer()), f.name);
              setDirty(false);
            })
          }
        >
          ⬇ {t("document.download")}
        </button>
        <button
          type="button"
          className="pz-btn"
          disabled={busy}
          data-testid="doc-send"
          onClick={() =>
            void run(async () => {
              const f = await exportFile();
              setDirty(false);
              onSend(f);
            })
          }
        >
          ↗ {t("document.send")}
        </button>
        <button
          type="button"
          className="pz-btn-ghost"
          disabled={busy}
          data-testid="doc-to-safe"
          onClick={() =>
            void run(async () => {
              const f = await exportFile();
              handOff("safe", f);
              setDirty(false);
              location.hash = "#safe";
            })
          }
        >
          🔐 {t("document.toSafe")}
        </button>
      </div>
      <p className="doc-privacy">🔒 {t("document.privacy")}</p>
    </section>
  );
}

function DuplicateIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </svg>
  );
}

// The annotate tool decides what a click on the page places.
const placeRef: { current: ((x: number, y: number) => void) | null } = { current: null };

function toolLabel(t: (k: string) => string, k: Tool): string {
  switch (k) {
    case "pages":
      return t("document.tool.pages");
    case "merge":
      return t("document.tool.merge");
    case "split":
      return t("document.tool.split");
    case "form":
      return t("document.tool.form");
    case "annotate":
      return t("document.tool.annotate");
    case "optimise":
      return t("document.tool.optimise");
  }
}

/* ── rendering ── */

function PageCanvas({ pdf, src, rotate, fitWidth, scale = 1, lazy, onRendered }: { pdf: PDFDocumentProxy; src: number; rotate: number; fitWidth?: number; scale?: number; lazy?: boolean; onRendered?: (r: { width: number; height: number; scale: number }) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(!lazy);
  const cb = useRef(onRendered);
  cb.current = onRendered;

  useEffect(() => {
    if (visible || !ref.current) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: "200px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible || !ref.current) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    void renderPage(pdf, src, ref.current, { scale, fitWidth, rotate })
      .then((r) => {
        if (cancelled) return r.task.cancel();
        task = r.task;
        return r.task.promise.then(() => !cancelled && cb.current?.(r));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, src, rotate, fitWidth, scale, visible]);

  return <canvas ref={ref} className="doc-canvas" aria-hidden="true" width={fitWidth ?? 100} height={Math.round((fitWidth ?? 100) * 1.3)} />;
}

function Viewer({
  pdf,
  edit,
  index,
  zoom,
  annotate,
  overlays,
  onNavigate,
  onPlace,
  onMove,
  onRemove,
}: {
  pdf: PDFDocumentProxy;
  edit: PageEdit;
  index: number;
  zoom: number | "fit";
  annotate: boolean;
  overlays: UiOverlay[];
  onNavigate: (by: number) => void;
  onPlace: (x: number, y: number) => void;
  onMove: (id: number, x: number, y: number) => void;
  onRemove: (id: number) => void;
}) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const [fitW, setFitW] = useState(600);
  const [scale, setScale] = useState(1);
  const dragging = useRef<{ id: number; dx: number; dy: number } | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setFitW(Math.max(200, Math.min(1400, el.clientWidth - 24)));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pt = (e: { clientX: number; clientY: number }, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "PageDown" || e.key === "ArrowRight") (e.preventDefault(), onNavigate(1));
    if (e.key === "PageUp" || e.key === "ArrowLeft") (e.preventDefault(), onNavigate(-1));
  };

  const overlayKey = (o: UiOverlay) => (e: ReactKeyboardEvent) => {
    const step = e.shiftKey ? 10 : 2;
    const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (d[e.key]) {
      e.preventDefault();
      onMove(o.id, o.x + d[e.key][0], o.y + d[e.key][1]);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onRemove(o.id);
    }
  };

  return (
    <div className="doc-stage" ref={box} tabIndex={0} onKeyDown={onKey} aria-label={t("document.viewerAria", { n: index + 1 })} data-testid="doc-viewer">
      <div
        className={`doc-page${annotate ? " is-annotate" : ""}`}
        onClick={(e) => {
          if (!annotate || e.target !== e.currentTarget.querySelector("canvas")) return;
          const p = pt(e, e.currentTarget);
          onPlace(p.x, p.y);
        }}
        onPointerMove={(e: ReactPointerEvent<HTMLDivElement>) => {
          const d = dragging.current;
          if (!d) return;
          const p = pt(e, e.currentTarget);
          onMove(d.id, p.x - d.dx, p.y - d.dy);
        }}
        onPointerUp={() => (dragging.current = null)}
        onPointerLeave={() => (dragging.current = null)}
        data-testid="doc-page"
      >
        <PageCanvas pdf={pdf} src={edit.src} rotate={edit.rotate} scale={zoom === "fit" ? 1 : zoom * 1.333} fitWidth={zoom === "fit" ? fitW : undefined} onRendered={(r) => setScale(r.scale)} />
        {overlays.map((o) => (
          <button
            key={o.id}
            type="button"
            className={`doc-ov doc-ov--${o.kind}`}
            style={{
              left: o.x * scale,
              top: o.y * scale,
              ...(o.kind === "text" ? { fontSize: o.size * scale, color: o.color } : { width: o.width * scale, height: o.height * scale }),
            }}
            aria-label={t("document.annotate.overlayAria", { text: o.kind === "text" ? o.text : t("document.annotate.image") })}
            onPointerDown={(e) => {
              if (!annotate) return;
              e.stopPropagation();
              (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
              const p = pt(e, e.currentTarget.parentElement!);
              dragging.current = { id: o.id, dx: p.x - o.x, dy: p.y - o.y };
            }}
            onKeyDown={overlayKey(o)}
            data-testid="doc-overlay"
          >
            {o.kind === "text" ? o.text : <img src={o.url} alt="" draggable={false} />}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── tools ── */

function PagesTool({ selectedCount, disabled, onRotateAll, onDeleteSelected, onExtractSelected, onClearSelection, onSelectAll }: { selectedCount: number; disabled: boolean; onRotateAll: (by: number) => void; onDeleteSelected: () => void; onExtractSelected: () => void; onClearSelection: () => void; onSelectAll: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="doc-tool">
      <h2>{t("document.tool.pages")}</h2>
      <p className="doc-hint">{t("document.pagesHint")}</p>
      <p className="doc-hint" aria-live="polite">{t("document.selectedCount", { count: selectedCount })}</p>
      <div className="doc-row">
        <button type="button" className="pz-btn-ghost" disabled={disabled} onClick={onSelectAll}>{t("document.selectAll")}</button>
        <button type="button" className="pz-btn-ghost" disabled={disabled || !selectedCount} onClick={onClearSelection}>{t("document.clearSelection")}</button>
      </div>
      <div className="doc-row">
        <button type="button" className="pz-btn-ghost" disabled={disabled} onClick={() => onRotateAll(-90)}>⟲ {selectedCount ? t("document.rotateSelLeft") : t("document.rotateAllLeft")}</button>
        <button type="button" className="pz-btn-ghost" disabled={disabled} onClick={() => onRotateAll(90)}>⟳ {selectedCount ? t("document.rotateSelRight") : t("document.rotateAllRight")}</button>
      </div>
      <div className="doc-row">
        <button type="button" className="pz-btn-ghost" disabled={disabled || !selectedCount} onClick={onExtractSelected} data-testid="doc-extract">{t("document.extractSelected")}</button>
        <button type="button" className="pz-btn-ghost doc-danger" disabled={disabled || !selectedCount} onClick={onDeleteSelected} data-testid="doc-delete-selected">{t("document.deleteSelected")}</button>
      </div>
    </div>
  );
}

function MergeTool({ current, queue, disabled, onAdd, onChange, onMerge }: { current: string; queue: { name: string; bytes: Uint8Array }[]; disabled: boolean; onAdd: (files: FileList | null) => void; onChange: (q: { name: string; bytes: Uint8Array }[]) => void; onMerge: () => void }) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= queue.length) return;
    const n = queue.slice();
    [n[i], n[j]] = [n[j], n[i]];
    onChange(n);
  };
  return (
    <div className="doc-tool">
      <h2>{t("document.tool.merge")}</h2>
      <p className="doc-hint">{t("document.merge.hint")}</p>
      <ol className="doc-list" data-testid="doc-merge-list">
        <li className="is-fixed">📄 {current} <small>{t("document.merge.current")}</small></li>
        {queue.map((q, i) => (
          <li key={`${q.name}-${i}`}>
            <span>📄 {q.name} <small>{formatBytes(q.bytes.length)}</small></span>
            <span className="doc-list-actions">
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={t("document.merge.up", { name: q.name })}>↑</button>
              <button type="button" onClick={() => move(i, 1)} disabled={i === queue.length - 1} aria-label={t("document.merge.down", { name: q.name })}>↓</button>
              <button type="button" className="doc-danger" onClick={() => onChange(queue.filter((_, k) => k !== i))} aria-label={t("document.merge.remove", { name: q.name })}>✕</button>
            </span>
          </li>
        ))}
      </ol>
      <input ref={input} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(e) => { onAdd(e.currentTarget.files); e.currentTarget.value = ""; }} data-testid="doc-merge-file" />
      <div className="doc-row">
        <button type="button" className="pz-btn-ghost" disabled={disabled} onClick={() => input.current?.click()}>＋ {t("document.merge.add")}</button>
        <button type="button" className="pz-btn" disabled={disabled || queue.length === 0} onClick={onMerge} data-testid="doc-merge">{t("document.merge.run", { count: queue.length + 1 })}</button>
      </div>
    </div>
  );
}

function SplitTool({ pageCount, disabled, onSplit, onKeep, onError }: { pageCount: number; disabled: boolean; onSplit: (groups: number[][]) => void; onKeep: (groups: number[][]) => void; onError: (e: unknown) => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"ranges" | "every">("ranges");
  const [spec, setSpec] = useState("");
  const [every, setEvery] = useState(1);
  const groups = (): number[][] | null => {
    try {
      return mode === "every" ? chunkPages(pageCount, every) : parseRanges(spec, pageCount);
    } catch (e) {
      onError(e);
      return null;
    }
  };
  return (
    <div className="doc-tool">
      <h2>{t("document.tool.split")}</h2>
      <fieldset className="doc-fieldset">
        <legend className="sr-only">{t("document.split.mode")}</legend>
        <label className="doc-radio"><input type="radio" name="doc-split" checked={mode === "ranges"} onChange={() => setMode("ranges")} /> {t("document.split.byRanges")}</label>
        <label className="doc-radio"><input type="radio" name="doc-split" checked={mode === "every"} onChange={() => setMode("every")} /> {t("document.split.byEvery")}</label>
      </fieldset>
      {mode === "ranges" ? (
        <label className="doc-field">
          <span>{t("document.split.ranges")}</span>
          <input value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="1-3, 5, 8-" data-testid="doc-ranges" />
          <small>{t("document.split.rangesHint", { total: pageCount })}</small>
        </label>
      ) : (
        <label className="doc-field">
          <span>{t("document.split.every")}</span>
          <input type="number" min={1} max={pageCount} value={every} onChange={(e) => setEvery(Math.max(1, Number(e.target.value) || 1))} />
        </label>
      )}
      <div className="doc-row">
        <button type="button" className="pz-btn" disabled={disabled} onClick={() => { const g = groups(); if (g) onSplit(g); }} data-testid="doc-split">{t("document.split.run")}</button>
        {mode === "ranges" && (
          <button type="button" className="pz-btn-ghost" disabled={disabled} onClick={() => { const g = groups(); if (g) onKeep(g); }} data-testid="doc-keep">{t("document.split.keep")}</button>
        )}
      </div>
    </div>
  );
}

function FormTool({ bytes, disabled, onApply }: { bytes: Uint8Array; disabled: boolean; onApply: (values: FormValues, flatten: boolean) => void }) {
  const { t } = useTranslation();
  const [fields, setFields] = useState<FormFieldInfo[] | null>(null);
  const [values, setValues] = useState<FormValues>({});
  const [flatten, setFlatten] = useState(false);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let live = true;
    listFormFields(bytes)
      .then((f) => {
        if (!live) return;
        setFields(f);
        setValues(Object.fromEntries(f.map((x) => [x.name, x.value])));
      })
      .catch(() => live && setErr(true));
    return () => {
      live = false;
    };
  }, [bytes]);
  if (err) return <div className="doc-tool"><p className="pz-err">{t("document.err.invalid")}</p></div>;
  if (!fields) return <div className="doc-tool"><p className="doc-hint">{t("document.loading")}</p></div>;
  const editable = fields.filter((f) => f.kind !== "other");
  return (
    <form
      className="doc-tool"
      onSubmit={(e) => {
        e.preventDefault();
        onApply(values, flatten);
      }}
      data-testid="doc-form"
    >
      <h2>{t("document.tool.form")}</h2>
      {editable.length === 0 ? (
        <p className="doc-hint" data-testid="doc-form-empty">{t("document.form.none")}</p>
      ) : (
        <>
          <p className="doc-hint">{t("document.form.hint", { count: editable.length })}</p>
          <div className="doc-form-fields">
            {editable.map((f) => {
              const v = values[f.name];
              const set = (x: string | boolean | string[]) => setValues((s) => ({ ...s, [f.name]: x }));
              if (f.kind === "checkbox")
                return (
                  <label key={f.name} className="doc-radio">
                    <input type="checkbox" checked={v === true} disabled={f.readOnly} onChange={(e) => set(e.target.checked)} /> {f.name}
                  </label>
                );
              return (
                <label key={f.name} className="doc-field">
                  <span>{f.name}{f.readOnly ? ` (${t("document.form.readOnly")})` : ""}</span>
                  {f.kind === "text" && (f.multiline ? <textarea rows={3} value={String(v ?? "")} disabled={f.readOnly} onChange={(e) => set(e.target.value)} /> : <input value={String(v ?? "")} disabled={f.readOnly} onChange={(e) => set(e.target.value)} data-testid="doc-form-text" />)}
                  {(f.kind === "dropdown" || f.kind === "radio") && (
                    <select value={String(v ?? "")} disabled={f.readOnly} onChange={(e) => set(e.target.value)}>
                      <option value="">—</option>
                      {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  )}
                  {f.kind === "optionlist" && (
                    <select multiple value={Array.isArray(v) ? v : []} disabled={f.readOnly} onChange={(e) => set(Array.from(e.target.selectedOptions, (o) => o.value))}>
                      {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  )}
                </label>
              );
            })}
          </div>
          <label className="doc-radio">
            <input type="checkbox" checked={flatten} onChange={(e) => setFlatten(e.target.checked)} /> {t("document.form.flatten")}
          </label>
          <small className="doc-hint">{t("document.form.fontNote")}</small>
          <button type="submit" className="pz-btn" disabled={disabled} data-testid="doc-form-apply">{t("document.form.apply")}</button>
        </>
      )}
    </form>
  );
}

function AnnotateTool({ disabled, count, registerPlace, onAdd, pageSize, onApply, onClear }: { disabled: boolean; count: number; registerPlace: (fn: (x: number, y: number) => void) => void; onAdd: (o: NewOverlay) => void; pageSize: () => Promise<{ width: number; height: number }>; onApply: () => void; onClear: () => void }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<"text" | "image">("text");
  const [text, setText] = useState("");
  const [size, setSize] = useState(14);
  const [color, setColor] = useState("#111827");
  const [image, setImage] = useState<{ bytes: Uint8Array; mime: "image/png" | "image/jpeg"; w: number; h: number } | null>(null);
  const [pad, setPad] = useState(false);
  const [err, setErr] = useState("");
  const imgInput = useRef<HTMLInputElement>(null);

  const place = useCallback(
    async (x: number, y: number) => {
      setErr("");
      if (kind === "text") {
        if (!text.trim()) return setErr(t("document.annotate.needText"));
        onAdd({ kind: "text", x, y, text, size, color });
      } else {
        if (!image) return setErr(t("document.annotate.needImage"));
        const page = await pageSize();
        const width = Math.min(160, page.width * 0.4);
        const height = (width * image.h) / image.w;
        const blobUrl = URL.createObjectURL(new Blob([image.bytes as Uint8Array<ArrayBuffer>], { type: image.mime }));
        onAdd({ kind: "image", x, y, width, height, bytes: image.bytes, mime: image.mime, url: blobUrl });
      }
    },
    [color, image, kind, onAdd, pageSize, size, t, text],
  );
  useEffect(() => registerPlace((x, y) => void place(x, y)), [place, registerPlace]);
  useEffect(() => () => registerPlace(() => undefined), [registerPlace]);

  const loadImage = async (bytes: Uint8Array, mime: string) => {
    if (mime !== "image/png" && mime !== "image/jpeg") return setErr(t("document.annotate.badImage"));
    const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      setImage({ bytes, mime, w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
      setKind("image");
      setErr("");
    } catch {
      setErr(t("document.annotate.badImage"));
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  return (
    <div className="doc-tool">
      <h2>{t("document.tool.annotate")}</h2>
      <p className="doc-hint">{t("document.annotate.hint")}</p>
      <fieldset className="doc-fieldset">
        <legend className="sr-only">{t("document.annotate.kind")}</legend>
        <label className="doc-radio"><input type="radio" name="doc-anno" checked={kind === "text"} onChange={() => setKind("text")} /> {t("document.annotate.text")}</label>
        <label className="doc-radio"><input type="radio" name="doc-anno" checked={kind === "image"} onChange={() => setKind("image")} /> {t("document.annotate.image")}</label>
      </fieldset>
      {kind === "text" ? (
        <>
          <label className="doc-field">
            <span>{t("document.annotate.textLabel")}</span>
            <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} data-testid="doc-anno-text" />
          </label>
          <div className="doc-row">
            <label className="doc-field doc-field--inline">
              <span>{t("document.annotate.size")}</span>
              <input type="number" min={6} max={96} value={size} onChange={(e) => setSize(Math.max(6, Math.min(96, Number(e.target.value) || 14)))} />
            </label>
            <label className="doc-field doc-field--inline">
              <span>{t("document.annotate.color")}</span>
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
            </label>
          </div>
        </>
      ) : (
        <>
          <input ref={imgInput} type="file" accept="image/png,image/jpeg" hidden onChange={async (e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (f) await loadImage(new Uint8Array(await f.arrayBuffer()), f.type); }} data-testid="doc-anno-image" />
          <div className="doc-row">
            <button type="button" className="pz-btn-ghost" onClick={() => imgInput.current?.click()}>{t("document.annotate.pickImage")}</button>
            <button type="button" className="pz-btn-ghost" onClick={() => setPad(true)} data-testid="doc-sign">✍ {t("document.annotate.draw")}</button>
          </div>
          {image && <p className="doc-hint" data-testid="doc-anno-ready">{t("document.annotate.imageReady")}</p>}
          {pad && (
            <SignaturePad
              onCancel={() => setPad(false)}
              onDone={async (png) => {
                setPad(false);
                await loadImage(png, "image/png");
              }}
            />
          )}
        </>
      )}
      {err && <p className="pz-err" role="alert">{err}</p>}
      <p className="doc-hint" aria-live="polite">{t("document.annotate.pending", { count })}</p>
      <small className="doc-hint">{t("document.annotate.flatNote")}</small>
      <div className="doc-row">
        <button type="button" className="pz-btn" disabled={disabled || count === 0} onClick={onApply} data-testid="doc-anno-apply">{t("document.annotate.apply")}</button>
        <button type="button" className="pz-btn-ghost" disabled={disabled || count === 0} onClick={onClear}>{t("document.annotate.clear")}</button>
      </div>
    </div>
  );
}

function SignaturePad({ onDone, onCancel }: { onDone: (png: Uint8Array) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);
  const ctx = () => {
    const c = ref.current!.getContext("2d")!;
    c.lineWidth = 4;
    c.lineCap = "round";
    c.lineJoin = "round";
    c.strokeStyle = "#0b1f4d";
    return c;
  };
  const pos = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [((e.clientX - r.left) * e.currentTarget.width) / r.width, ((e.clientY - r.top) * e.currentTarget.height) / r.height] as const;
  };
  return (
    <div className="doc-pad" data-testid="doc-pad">
      <canvas
        ref={ref}
        width={600}
        height={200}
        aria-label={t("document.annotate.padAria")}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          drawing.current = true;
          const c = ctx();
          c.beginPath();
          c.moveTo(...pos(e));
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const c = ctx();
          c.lineTo(...pos(e));
          c.stroke();
          setEmpty(false);
        }}
        onPointerUp={() => (drawing.current = false)}
      />
      <div className="doc-row">
        <button type="button" className="pz-btn-ghost" onClick={() => { ref.current!.getContext("2d")!.clearRect(0, 0, 600, 200); setEmpty(true); }}>{t("document.annotate.padClear")}</button>
        <button type="button" className="pz-btn-ghost" onClick={onCancel}>{t("document.annotate.padCancel")}</button>
        <button
          type="button"
          className="pz-btn"
          disabled={empty}
          onClick={() => ref.current!.toBlob((b) => b && void b.arrayBuffer().then((ab) => onDone(new Uint8Array(ab))), "image/png")}
          data-testid="doc-pad-use"
        >
          {t("document.annotate.padUse")}
        </button>
      </div>
    </div>
  );
}

function OptimiseTool({ info, size, disabled, onRun }: { info: PdfInfo | null; size: number; disabled: boolean; onRun: (o: { stripMetadata: boolean; compressStreams: boolean }) => void }) {
  const { t } = useTranslation();
  const [strip, setStrip] = useState(true);
  const [compress, setCompress] = useState(true);
  const meta = useMemo(() => [info?.title && `${t("document.optimise.title")}: ${info.title}`, info?.author && `${t("document.optimise.author")}: ${info.author}`, info?.producer && `${t("document.optimise.producer")}: ${info.producer}`].filter(Boolean) as string[], [info, t]);
  return (
    <div className="doc-tool">
      <h2>{t("document.tool.optimise")}</h2>
      <p className="doc-hint">{t("document.optimise.hint")}</p>
      <p className="doc-hint">{t("document.optimise.size", { size: formatBytes(size) })}</p>
      {meta.length > 0 ? (
        <ul className="doc-meta" data-testid="doc-meta">{meta.map((m) => <li key={m}>{m}</li>)}</ul>
      ) : (
        <p className="doc-hint">{t("document.optimise.noMeta")}</p>
      )}
      <label className="doc-radio"><input type="checkbox" checked={strip} onChange={(e) => setStrip(e.target.checked)} data-testid="doc-strip" /> {t("document.optimise.strip")}</label>
      <label className="doc-radio"><input type="checkbox" checked={compress} onChange={(e) => setCompress(e.target.checked)} /> {t("document.optimise.compress")}</label>
      <small className="doc-hint">{t("document.optimise.lossless")}</small>
      <button type="button" className="pz-btn" disabled={disabled} onClick={() => onRun({ stripMetadata: strip, compressStreams: compress })} data-testid="doc-optimise">{t("document.optimise.run")}</button>
    </div>
  );
}

