/**
 * Text mode of the Document tab: a Word-like editor (TipTap / ProseMirror,
 * MIT) for documents created from scratch, opened from .md / .txt, or
 * converted from a PDF's text. Saved as a real text PDF (pdfExport) or as
 * Markdown. Loaded lazily: PDF-only users never download it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { Node as TNode } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import HardBreak from "@tiptap/extension-hard-break";
import { TextAlign } from "@tiptap/extension-text-align";
import { Image } from "@tiptap/extension-image";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions";
import { TextSelection } from "@tiptap/pm/state";
import { htmlToMd } from "./markdown";
import { MIME, withExt, type SaveFormat } from "./fileName";
import { ExportBar, MenuBar, NameField, SaveAsDialog, ToolButton, inField, mod, useShortcuts, type Menu, type MenuEntry, type SaveAction } from "./chrome";
import { useBookmarkMenu } from "./BookmarkBar";
import type { Draft } from "./draft";
import { draftGeneration, saveDraft } from "./draft";
import "./editor.css";

/** Word's Ctrl+Enter: a hard page break, kept in the PDF and as "\newpage" in Markdown. */
const PageBreak = TNode.create({
  name: "pageBreak",
  group: "block",
  atom: true,
  selectable: true,
  parseHTML: () => [{ tag: 'div[data-type="page-break"]' }],
  renderHTML: () => ["div", { "data-type": "page-break", class: "doc-pagebreak" }],
  addKeyboardShortcuts() {
    return { "Mod-Enter": () => this.editor.chain().insertContent([{ type: "pageBreak" }, { type: "paragraph" }]).run() };
  },
});

/** Shift+Enter only (Ctrl+Enter is the page break). */
const LineBreak = HardBreak.extend({
  addKeyboardShortcuts() {
    return { "Shift-Enter": () => this.editor.commands.setHardBreak() };
  },
});

const MAX_IMAGE = 8 * 1024 * 1024;

function readDataUrl(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });
}

/** Every occurrence of `q` (case-insensitive) inside text nodes. */
function findAll(editor: Editor, q: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  if (!q) return out;
  const needle = q.toLocaleLowerCase();
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const hay = node.text.toLocaleLowerCase();
    let i = hay.indexOf(needle);
    while (i >= 0) {
      out.push({ from: pos + i, to: pos + i + q.length });
      i = hay.indexOf(needle, i + Math.max(1, q.length));
    }
  });
  return out;
}

export interface TextEditorProps {
  initialHtml: string;
  stem: string;
  notice?: string;
  pendingDraft?: Draft | null;
  /** Reopened automatically from this browser's memory (shows "Close and forget"). */
  resumed?: { name: string; at: number } | null;
  onForget?: () => void;
  onRestoreDraft?: () => void;
  onDiscardDraft?: () => void;
  onRename: (s: string) => void;
  onDirty: (d: boolean) => void;
  onNew: () => void;
  onOpen: () => void;
  onClose: () => void;
  deliver: (file: File, action: SaveAction) => void;
}

type Msg = { kind: "ok" | "err" | "info"; text: string } | null;

export default function TextEditor({ initialHtml, stem, notice, pendingDraft, resumed, onForget, onRestoreDraft, onDiscardDraft, onRename, onDirty, onNew, onOpen, onClose, deliver }: TextEditorProps) {
  const { t, i18n } = useTranslation();
  const bookmark = useBookmarkMenu();
  const [msg, setMsg] = useState<Msg>(notice ? { kind: "info", text: notice } : null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirtyState] = useState(false);
  const [saveAs, setSaveAs] = useState<{ format: SaveFormat; intent: SaveAction } | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [draftAt, setDraftAt] = useState<number | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const draftTimer = useRef<number>();
  /** The save waiting for its debounce, run at once on pagehide / tab hidden / export. */
  const pendingSave = useRef<(() => void) | null>(null);
  const quotaShown = useRef(false);
  const stemRef = useRef(stem);
  stemRef.current = stem;

  const persist = useCallback(
    (html: string, name: string, gen: number) => {
      void saveDraft({ name, html }, gen).then((r) => {
        if (r.ok) {
          setDraftAt(r.at);
          if (quotaShown.current) {
            quotaShown.current = false;
            setMsg(null);
          }
        } else if (r.reason === "quota" && !quotaShown.current) {
          quotaShown.current = true;
          setDraftAt(null);
          setMsg({ kind: "err", text: t("document.editor.draftQuota") });
        } else if (r.reason === "unavailable") setDraftAt(null);
      });
    },
    [t],
  );

  const flushDraft = useCallback(() => {
    window.clearTimeout(draftTimer.current);
    const run = pendingSave.current;
    pendingSave.current = null;
    run?.();
  }, []);

  const setDirty = useCallback(
    (d: boolean) => {
      setDirtyState(d);
      onDirty(d);
    },
    [onDirty],
  );

  const insertImageFiles = useCallback(
    async (ed: Editor, files: File[], pos?: number) => {
      for (const f of files.filter((x) => x.type.startsWith("image/"))) {
        if (f.size > MAX_IMAGE) {
          setMsg({ kind: "err", text: t("document.editor.imageTooBig", { name: f.name }) });
          continue;
        }
        const src = await readDataUrl(f);
        const node = { type: "image", attrs: { src, alt: f.name.replace(/\.[^.]+$/, "") } };
        if (pos !== undefined) ed.chain().insertContentAt(pos, node).run();
        else ed.chain().focus().insertContent(node).run();
      }
    },
    [t],
  );

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        hardBreak: false,
        heading: { levels: [1, 2, 3, 4] },
        link: { openOnClick: false, autolink: true, defaultProtocol: "https", HTMLAttributes: { rel: "noopener noreferrer nofollow", target: null } },
      }),
      LineBreak,
      PageBreak,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Image.configure({ allowBase64: true, inline: false }),
      TableKit.configure({ table: { resizable: false } }),
      Placeholder.configure({ placeholder: t("document.editor.placeholder") }),
    ],
    content: initialHtml || "<p></p>",
    autofocus: "end",
    editorProps: {
      attributes: { class: "doc-prose", "aria-label": t("document.editor.aria"), "data-testid": "doc-editor", spellcheck: "true", lang: i18n.language },
      handleDrop: (view, event) => {
        const files = Array.from(event.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
        if (!files.length || !editorRef.current) return false;
        event.preventDefault();
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        void insertImageFiles(editorRef.current, files, pos);
        return true;
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
        if (!files.length || !editorRef.current) return false;
        void insertImageFiles(editorRef.current, files);
        return true;
      },
    },
    onUpdate: ({ editor: ed }) => {
      setDirty(true);
      window.clearTimeout(draftTimer.current);
      const gen = draftGeneration();
      pendingSave.current = () => persist(ed.getHTML(), stemRef.current, gen);
      draftTimer.current = window.setTimeout(flushDraft, 800);
    },
  });
  const editorRef = useRef<Editor | null>(null);
  editorRef.current = editor;
  // Closing the tab, switching app or locking the phone: write now, not in 800 ms.
  useEffect(() => {
    const onHide = () => flushDraft();
    const onVis = () => document.visibilityState === "hidden" && flushDraft();
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVis);
      // Leaving the editor inside the app (back to home…): keep the last keystrokes.
      flushDraft();
    };
  }, [flushDraft]);
  // A rename is part of the document: remember it once the text was touched.
  useEffect(() => {
    if (!dirty || !editor || editor.isDestroyed) return;
    const gen = draftGeneration();
    pendingSave.current = () => persist(editor.getHTML(), stem, gen);
    window.clearTimeout(draftTimer.current);
    draftTimer.current = window.setTimeout(flushDraft, 800);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stem]);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const id = window.requestAnimationFrame(() => editor.commands.focus("end"));
    return () => window.cancelAnimationFrame(id);
  }, [editor]);

  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e) return null;
      const block = e.isActive("heading", { level: 1 }) ? "h1" : e.isActive("heading", { level: 2 }) ? "h2" : e.isActive("heading", { level: 3 }) ? "h3" : e.isActive("heading", { level: 4 }) ? "h4" : e.isActive("blockquote") ? "quote" : e.isActive("codeBlock") ? "code" : "p";
      const text = e.state.doc.textContent;
      return {
        block,
        bold: e.isActive("bold"),
        italic: e.isActive("italic"),
        underline: e.isActive("underline"),
        strike: e.isActive("strike"),
        code: e.isActive("code"),
        bullet: e.isActive("bulletList"),
        ordered: e.isActive("orderedList"),
        link: e.isActive("link"),
        table: e.isActive("table"),
        align: (["left", "center", "right", "justify"] as const).find((a) => e.isActive({ textAlign: a })) ?? "left",
        canUndo: e.can().undo(),
        canRedo: e.can().redo(),
        empty: !e.state.selection.empty ? false : true,
        words: text.trim() ? text.trim().split(/\s+/).length : 0,
        chars: text.length,
        href: (e.getAttributes("link").href as string) ?? "",
      };
    },
  });

  const chain = () => editor!.chain().focus();

  const setBlock = (b: string) => {
    const c = chain();
    if (b === "p") c.setParagraph().run();
    else if (b === "quote") c.setParagraph().toggleBlockquote().run();
    else if (b === "code") c.toggleCodeBlock().run();
    else c.setHeading({ level: Number(b.slice(1)) as 1 | 2 | 3 | 4 }).run();
  };

  /* ── clipboard ── */
  const clip = async (kind: "cut" | "copy") => {
    if (!editor) return;
    editor.commands.focus();
    let ok = false;
    try {
      ok = document.execCommand(kind);
    } catch {
      ok = false;
    }
    if (!ok) {
      const { from, to } = editor.state.selection;
      const text = editor.state.doc.textBetween(from, to, "\n");
      try {
        await navigator.clipboard.writeText(text);
        if (kind === "cut") editor.commands.deleteSelection();
      } catch {
        setMsg({ kind: "info", text: t("document.editor.clipboardKeys") });
      }
    }
  };
  const paste = async () => {
    if (!editor) return;
    try {
      if (navigator.clipboard?.read) {
        const items = await navigator.clipboard.read();
        for (const it of items) {
          const img = it.types.find((x) => x.startsWith("image/"));
          if (img) {
            const b = await it.getType(img);
            await insertImageFiles(editor, [new File([b], "image", { type: img })]);
            return;
          }
          if (it.types.includes("text/html")) {
            chain().insertContent(await (await it.getType("text/html")).text()).run();
            return;
          }
        }
      }
      const text = await navigator.clipboard.readText();
      const paras = text.replace(/\r\n?/g, "\n").split(/\n\s*\n/).filter(Boolean);
      chain()
        .insertContent(paras.length > 1 ? paras.map((p) => ({ type: "paragraph", content: p ? [{ type: "text", text: p }] : [] })) : text)
        .run();
    } catch {
      setMsg({ kind: "info", text: t("document.editor.pasteKeys") });
    }
  };

  /* ── save / export ── */
  const toFile = useCallback(
    async (format: SaveFormat, s: string): Promise<File> => {
      if (!editor) throw new Error("no editor");
      if (format === "md") return new File([htmlToMd(editor.getHTML())], withExt(s, "md"), { type: MIME.md });
      const [{ exportPdf }, { loadFonts, imageToPng }] = await Promise.all([import("./pdfExport"), import("./fonts")]);
      const bytes = await exportPdf(editor.getJSON() as never, { fonts: await loadFonts(), title: s, lang: i18n.language, loadImage: imageToPng });
      return new File([bytes as Uint8Array<ArrayBuffer>], withExt(s, "pdf"), { type: MIME.pdf });
    },
    [editor, i18n.language],
  );

  const save = async (format: SaveFormat, action: SaveAction, s = stem) => {
    setBusy(true);
    setMsg(null);
    try {
      if (s !== stem) onRename(s);
      const f = await toFile(format, s);
      // The pending save lands before the export mark (writes are queued in order).
      if (dirty && editor) {
        window.clearTimeout(draftTimer.current);
        pendingSave.current = null;
        persist(editor.getHTML(), s, draftGeneration());
      }
      setDirty(false);
      deliver(f, action);
      if (action === "download") setMsg({ kind: "ok", text: t("document.editor.saved", { name: f.name }) });
    } catch (e) {
      setMsg({ kind: "err", text: t("document.err.generic", { detail: (e as Error)?.message ?? String(e) }) });
    } finally {
      setBusy(false);
    }
  };

  const insertTable = () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  const insertRule = () => chain().setHorizontalRule().run();
  const insertBreak = () => chain().insertContent([{ type: "pageBreak" }, { type: "paragraph" }]).run();

  /* ── shortcuts that the editor does not handle itself ── */
  useShortcuts((e) => {
    if (saveAs) return false;
    const k = e.key.toLowerCase();
    if (e.key === "F2") return nameRef.current?.focus(), nameRef.current?.select(), true;
    const altN = e.altKey && !mod(e) && (k === "n" || e.code === "KeyN");
    if (altN) return onNew(), true;
    if (!mod(e)) return false;
    if (inField(e.target) && !["s", "o"].includes(k)) return false;
    if (k === "s") return setSaveAs({ format: "pdf", intent: "download" }), true;
    if (k === "o") return onOpen(), true;
    if (k === "n" && e.altKey) return onNew(), true;
    if (k === "f" || k === "h") return setFindOpen(true), true;
    if (k === "k") return setLinkOpen(true), true;
    return false;
  });

  const fileMenu: MenuEntry[] = [
    { id: "new", label: t("document.ui.new"), shortcut: "Alt+N", onSelect: onNew },
    { id: "open", label: t("document.ui.open"), shortcut: "Ctrl+O", onSelect: onOpen },
    { id: "rename", label: t("document.ui.rename"), shortcut: "F2", onSelect: () => (nameRef.current?.focus(), nameRef.current?.select()) },
    { sep: true },
    { id: "saveas", label: t("document.ui.saveAs"), shortcut: "Ctrl+S", onSelect: () => setSaveAs({ format: "pdf", intent: "download" }) },
    { id: "save-pdf", label: t("document.ui.savePdf"), onSelect: () => void save("pdf", "download") },
    { id: "save-md", label: t("document.ui.saveMd"), onSelect: () => void save("md", "download") },
    { sep: true },
    { id: "send", label: t("document.ui.sendDots"), onSelect: () => setSaveAs({ format: "pdf", intent: "send" }) },
    { id: "safe", label: t("document.ui.safeDots"), onSelect: () => setSaveAs({ format: "pdf", intent: "safe" }) },
    { sep: true },
    bookmark.item,
    { sep: true },
    { id: "close", label: t("document.close"), onSelect: onClose },
  ];
  const menus: Menu[] = [
    { id: "file", label: t("document.ui.menuFile"), items: fileMenu },
    {
      id: "edit",
      label: t("document.ui.menuEdit"),
      items: [
        { id: "undo", label: t("document.undo"), shortcut: "Ctrl+Z", disabled: !st?.canUndo, onSelect: () => chain().undo().run() },
        { id: "redo", label: t("document.ui.redo"), shortcut: "Ctrl+Y", disabled: !st?.canRedo, onSelect: () => chain().redo().run() },
        { sep: true },
        { id: "cut", label: t("document.ui.cut"), shortcut: "Ctrl+X", onSelect: () => void clip("cut") },
        { id: "copy", label: t("document.ui.copy"), shortcut: "Ctrl+C", onSelect: () => void clip("copy") },
        { id: "paste", label: t("document.ui.paste"), shortcut: "Ctrl+V", onSelect: () => void paste() },
        { sep: true },
        { id: "selectall", label: t("document.selectAll"), shortcut: "Ctrl+A", onSelect: () => chain().selectAll().run() },
        { id: "find", label: t("document.editor.find"), shortcut: "Ctrl+F", onSelect: () => setFindOpen(true) },
      ],
    },
    {
      id: "insert",
      label: t("document.ui.menuInsert"),
      items: [
        { id: "image", label: t("document.editor.image"), onSelect: () => imageInput.current?.click() },
        { id: "table", label: t("document.editor.table"), onSelect: insertTable },
        { id: "link", label: t("document.editor.link"), shortcut: "Ctrl+K", onSelect: () => setLinkOpen(true) },
        { id: "hr", label: t("document.editor.hr"), onSelect: insertRule },
        { id: "pagebreak", label: t("document.editor.pageBreak"), shortcut: "Ctrl+Enter", onSelect: insertBreak },
      ],
    },
    {
      id: "format",
      label: t("document.ui.menuFormat"),
      items: [
        { id: "bold", label: t("document.editor.bold"), shortcut: "Ctrl+B", checked: !!st?.bold, onSelect: () => chain().toggleBold().run() },
        { id: "italic", label: t("document.editor.italic"), shortcut: "Ctrl+I", checked: !!st?.italic, onSelect: () => chain().toggleItalic().run() },
        { id: "underline", label: t("document.editor.underline"), shortcut: "Ctrl+U", checked: !!st?.underline, onSelect: () => chain().toggleUnderline().run() },
        { id: "strike", label: t("document.editor.strike"), shortcut: "Ctrl+Shift+S", checked: !!st?.strike, onSelect: () => chain().toggleStrike().run() },
        { id: "code", label: t("document.editor.inlineCode"), shortcut: "Ctrl+E", checked: !!st?.code, onSelect: () => chain().toggleCode().run() },
        { sep: true },
        { id: "bullet", label: t("document.editor.bulletList"), checked: !!st?.bullet, onSelect: () => chain().toggleBulletList().run() },
        { id: "ordered", label: t("document.editor.orderedList"), checked: !!st?.ordered, onSelect: () => chain().toggleOrderedList().run() },
        { sep: true },
        { id: "clear", label: t("document.editor.clearFormat"), onSelect: () => chain().unsetAllMarks().clearNodes().run() },
      ],
    },
  ];

  if (!editor || !st) return null;
  const ALIGN: { a: "left" | "center" | "right" | "justify"; label: string; icon: JSX.Element }[] = [
    { a: "left", label: t("document.editor.alignLeft"), icon: <AlignIcon lines={[16, 10, 14, 8]} /> },
    { a: "center", label: t("document.editor.alignCenter"), icon: <AlignIcon lines={[16, 10, 14, 8]} center /> },
    { a: "right", label: t("document.editor.alignRight"), icon: <AlignIcon lines={[16, 10, 14, 8]} right /> },
    { a: "justify", label: t("document.editor.alignJustify"), icon: <AlignIcon lines={[16, 16, 16, 10]} /> },
  ];

  return (
    <section className="doc-panel doc-panel--text" data-testid="doc-panel" data-mode="text" aria-busy={busy}>
      <div className="doc-bar">
        <div className="doc-file">
          <NameField stem={stem} onRename={onRename} inputRef={nameRef} />
          <small>
            {t("document.editor.stats", { words: st.words, chars: st.chars })}
            {dirty ? ` · ${t("document.ui.unsaved")}` : ""}
            {draftAt ? ` · ${t("document.editor.draftSaved", { time: new Date(draftAt).toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" }) })}` : ""}
          </small>
        </div>
        <div className="doc-bar-actions">
          <button type="button" className="pz-btn" onClick={() => setSaveAs({ format: "pdf", intent: "download" })} disabled={busy} data-testid="doc-saveas-open">
            💾 {t("document.ui.saveAs")}
          </button>
          <button type="button" className="pz-btn-ghost" onClick={onClose} disabled={busy} data-testid="doc-close">
            {t("document.close")}
          </button>
        </div>
      </div>
      {bookmark.dialog}
      {resumed && !dirty && (
        <div className="doc-draft doc-draft--live" data-testid="doc-resumed">
          <span>🕘 {t("document.ui.resumed", { name: resumed.name, time: new Date(resumed.at).toLocaleString(i18n.language) })}</span>
          {onForget && (
            <span className="doc-row">
              <button type="button" className="pz-btn-ghost" onClick={onForget} data-testid="doc-forget">{t("document.ui.forget")}</button>
            </span>
          )}
        </div>
      )}
      {pendingDraft && !dirty && onRestoreDraft && (
        <div className="doc-draft doc-draft--live" data-testid="doc-draft">
          <span>📝 {t("document.ui.draftFound", { name: pendingDraft.name, time: new Date(pendingDraft.at).toLocaleString() })}</span>
          <span className="doc-row">
            <button type="button" className="pz-btn" onClick={onRestoreDraft} data-testid="doc-draft-restore">{t("document.ui.draftRestore")}</button>
            {onDiscardDraft && <button type="button" className="pz-btn-ghost" onClick={onDiscardDraft} data-testid="doc-draft-discard">{t("document.ui.draftDiscard")}</button>}
          </span>
        </div>
      )}

      <div className="doc-ribbon">
        <MenuBar menus={menus} label={t("document.ui.menuAria")} />
        <div className="doc-toolbar" role="toolbar" aria-label={t("document.editor.toolbarAria")} data-testid="doc-toolbar">
          <div className="doc-tb-group">
            <ToolButton label={t("document.undo")} shortcut="Ctrl+Z" onClick={() => chain().undo().run()} disabled={!st.canUndo} testId="doc-ed-undo">↶</ToolButton>
            <ToolButton label={t("document.ui.redo")} shortcut="Ctrl+Y" onClick={() => chain().redo().run()} disabled={!st.canRedo} testId="doc-ed-redo">↷</ToolButton>
          </div>
          <div className="doc-tb-group">
            <select className="doc-tb-select" value={st.block} onChange={(e) => setBlock(e.target.value)} aria-label={t("document.editor.style")} data-testid="doc-style">
              <option value="p">{t("document.editor.paragraph")}</option>
              <option value="h1">{t("document.editor.heading", { n: 1 })}</option>
              <option value="h2">{t("document.editor.heading", { n: 2 })}</option>
              <option value="h3">{t("document.editor.heading", { n: 3 })}</option>
              <option value="h4">{t("document.editor.heading", { n: 4 })}</option>
              <option value="quote">{t("document.editor.quote")}</option>
              <option value="code">{t("document.editor.codeBlock")}</option>
            </select>
          </div>
          <div className="doc-tb-group">
            <ToolButton label={t("document.editor.bold")} shortcut="Ctrl+B" active={st.bold} onClick={() => chain().toggleBold().run()} testId="doc-fmt-bold"><b>{t("document.editor.boldGlyph")}</b></ToolButton>
            <ToolButton label={t("document.editor.italic")} shortcut="Ctrl+I" active={st.italic} onClick={() => chain().toggleItalic().run()} testId="doc-fmt-italic"><i>{t("document.editor.italicGlyph")}</i></ToolButton>
            <ToolButton label={t("document.editor.underline")} shortcut="Ctrl+U" active={st.underline} onClick={() => chain().toggleUnderline().run()} testId="doc-fmt-underline"><u>{t("document.editor.underlineGlyph")}</u></ToolButton>
            <ToolButton label={t("document.editor.strike")} shortcut="Ctrl+Shift+S" active={st.strike} onClick={() => chain().toggleStrike().run()} testId="doc-fmt-strike"><s>ab</s></ToolButton>
            <ToolButton label={t("document.editor.inlineCode")} shortcut="Ctrl+E" active={st.code} onClick={() => chain().toggleCode().run()} testId="doc-fmt-code"><code>{"</>"}</code></ToolButton>
          </div>
          <div className="doc-tb-group">
            <ToolButton label={t("document.editor.bulletList")} shortcut="Ctrl+Shift+8" active={st.bullet} onClick={() => chain().toggleBulletList().run()} testId="doc-fmt-bullet"><ListIcon /></ToolButton>
            <ToolButton label={t("document.editor.orderedList")} shortcut="Ctrl+Shift+7" active={st.ordered} onClick={() => chain().toggleOrderedList().run()} testId="doc-fmt-ordered"><ListIcon ordered /></ToolButton>
            <ToolButton label={t("document.editor.outdent")} shortcut="Shift+Tab" disabled={!editor.can().liftListItem("listItem")} onClick={() => chain().liftListItem("listItem").run()}>⇤</ToolButton>
            <ToolButton label={t("document.editor.indent")} shortcut="Tab" disabled={!editor.can().sinkListItem("listItem")} onClick={() => chain().sinkListItem("listItem").run()}>⇥</ToolButton>
          </div>
          <div className="doc-tb-group">
            {ALIGN.map((x) => (
              <ToolButton key={x.a} label={x.label} active={st.align === x.a} onClick={() => chain().setTextAlign(x.a).run()} testId={`doc-align-${x.a}`}>{x.icon}</ToolButton>
            ))}
          </div>
          <div className="doc-tb-group">
            <ToolButton label={t("document.editor.link")} shortcut="Ctrl+K" active={st.link} onClick={() => setLinkOpen((o) => !o)} testId="doc-ins-link">🔗</ToolButton>
            <ToolButton label={t("document.editor.image")} onClick={() => imageInput.current?.click()} testId="doc-ins-image">🖼</ToolButton>
            <ToolButton label={t("document.editor.table")} onClick={insertTable} testId="doc-ins-table">▦</ToolButton>
            <ToolButton label={t("document.editor.hr")} onClick={insertRule} testId="doc-ins-hr">―</ToolButton>
            <ToolButton label={t("document.editor.pageBreak")} shortcut="Ctrl+Enter" onClick={insertBreak} testId="doc-ins-break">⤓</ToolButton>
          </div>
          <div className="doc-tb-group">
            <ToolButton label={t("document.ui.cut")} shortcut="Ctrl+X" onClick={() => void clip("cut")} testId="doc-ed-cut">✂</ToolButton>
            <ToolButton label={t("document.ui.copy")} shortcut="Ctrl+C" onClick={() => void clip("copy")} testId="doc-ed-copy">⧉</ToolButton>
            <ToolButton label={t("document.ui.paste")} shortcut="Ctrl+V" onClick={() => void paste()} testId="doc-ed-paste">📋</ToolButton>
            <ToolButton label={t("document.selectAll")} shortcut="Ctrl+A" onClick={() => chain().selectAll().run()} testId="doc-ed-selectall">⬚</ToolButton>
            <ToolButton label={t("document.editor.find")} shortcut="Ctrl+F" active={findOpen} onClick={() => setFindOpen((o) => !o)} testId="doc-ed-find">🔍</ToolButton>
            <ToolButton label={t("document.editor.clearFormat")} onClick={() => chain().unsetAllMarks().clearNodes().run()} testId="doc-ed-clear">⌫</ToolButton>
          </div>
          {st.table && (
            <div className="doc-tb-group doc-tb-table" data-testid="doc-table-tools">
              <ToolButton label={t("document.editor.addRow")} onClick={() => chain().addRowAfter().run()}>+≡</ToolButton>
              <ToolButton label={t("document.editor.addCol")} onClick={() => chain().addColumnAfter().run()}>+⫼</ToolButton>
              <ToolButton label={t("document.editor.delRow")} onClick={() => chain().deleteRow().run()}>−≡</ToolButton>
              <ToolButton label={t("document.editor.delCol")} onClick={() => chain().deleteColumn().run()}>−⫼</ToolButton>
              <ToolButton label={t("document.editor.delTable")} className="doc-danger" onClick={() => chain().deleteTable().run()}>✕▦</ToolButton>
            </div>
          )}
        </div>
        {linkOpen && <LinkBar href={st.href} onClose={() => (setLinkOpen(false), editor.commands.focus())} onApply={(href) => {
          if (!href) chain().extendMarkRange("link").unsetLink().run();
          else if (editor.state.selection.empty && !st.link) chain().insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).run();
          else chain().extendMarkRange("link").setLink({ href }).run();
          setLinkOpen(false);
        }} />}
        {findOpen && <FindBar editor={editor} onClose={() => (setFindOpen(false), editor.commands.focus())} />}
      </div>
      <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => { void insertImageFiles(editor, Array.from(e.currentTarget.files ?? [])); e.currentTarget.value = ""; }} data-testid="doc-image-file" />

      {msg && (
        <p className={msg.kind === "err" ? "pz-err doc-msg" : "doc-status doc-msg"} role={msg.kind === "err" ? "alert" : "status"} data-testid="doc-msg">
          {msg.text}
        </p>
      )}

      <div className="doc-sheet-wrap" onMouseDown={(e) => e.target === e.currentTarget && editor.commands.focus("end")}>
        <div className="doc-sheet">
          <EditorContent editor={editor} />
        </div>
      </div>

      <ExportBar busy={busy} onRun={(format, action) => (action === "download" ? void save(format, action) : setSaveAs({ format, intent: action }))} />
      <p className="doc-privacy">🔒 {t("document.editor.privacy")}</p>

      {saveAs && (
        <SaveAsDialog
          stem={stem}
          format={saveAs.format}
          intent={saveAs.intent}
          mdNote={t("document.editor.mdNote")}
          onCancel={() => setSaveAs(null)}
          onConfirm={(s, f, a) => {
            setSaveAs(null);
            void save(f, a, s);
          }}
        />
      )}
    </section>
  );
}

function LinkBar({ href, onApply, onClose }: { href: string; onApply: (href: string) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState(href);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <form className="doc-subbar" onSubmit={(e) => (e.preventDefault(), onApply(v.trim()))} onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), onClose())} data-testid="doc-linkbar">
      <label className="doc-subbar-field">
        <span>{t("document.editor.linkUrl")}</span>
        <input ref={ref} type="url" value={v} placeholder="https://" onChange={(e) => setV(e.target.value)} data-testid="doc-link-url" />
      </label>
      <button type="submit" className="pz-btn" data-testid="doc-link-apply">{t("document.editor.apply")}</button>
      {href && <button type="button" className="pz-btn-ghost" onClick={() => onApply("")}>{t("document.editor.unlink")}</button>}
      <button type="button" className="pz-btn-ghost" onClick={onClose} aria-label={t("document.ui.cancel")}>✕</button>
    </form>
  );
}

function FindBar({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [r, setR] = useState("");
  const [idx, setIdx] = useState(-1);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const matches = useMemo(() => findAll(editor, q), [editor, q, editor.state.doc]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = (by: number) => {
    if (!matches.length) return;
    const i = (idx + by + matches.length) % matches.length;
    setIdx(i);
    const m = matches[i];
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, m.from, m.to)).scrollIntoView());
  };
  const replaceOne = () => {
    const m = matches[idx];
    if (!m) return go(1);
    editor.chain().insertContentAt({ from: m.from, to: m.to }, r).run();
    setIdx(idx - 1);
  };
  const replaceAll = () => {
    if (!matches.length) return;
    let tr = editor.state.tr;
    for (const m of [...matches].reverse()) tr = r ? tr.insertText(r, m.from, m.to) : tr.delete(m.from, m.to);
    editor.view.dispatch(tr);
    setIdx(-1);
  };
  return (
    <div className="doc-subbar" role="search" onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), onClose())} data-testid="doc-findbar">
      <label className="doc-subbar-field">
        <span>{t("document.editor.find")}</span>
        <input ref={ref} value={q} onChange={(e) => (setQ(e.target.value), setIdx(-1))} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), go(e.shiftKey ? -1 : 1))} data-testid="doc-find-q" />
      </label>
      <span className="doc-hint" aria-live="polite" data-testid="doc-find-count">{q ? t("document.editor.matches", { n: idx >= 0 ? idx + 1 : 0, total: matches.length }) : ""}</span>
      <button type="button" className="pz-btn-ghost" onClick={() => go(-1)} disabled={!matches.length} aria-label={t("document.editor.findPrev")}>↑</button>
      <button type="button" className="pz-btn-ghost" onClick={() => go(1)} disabled={!matches.length} aria-label={t("document.editor.findNext")} data-testid="doc-find-next">↓</button>
      <label className="doc-subbar-field">
        <span>{t("document.editor.replaceWith")}</span>
        <input value={r} onChange={(e) => setR(e.target.value)} data-testid="doc-find-r" />
      </label>
      <button type="button" className="pz-btn-ghost" onClick={replaceOne} disabled={!matches.length}>{t("document.editor.replace")}</button>
      <button type="button" className="pz-btn-ghost" onClick={replaceAll} disabled={!matches.length} data-testid="doc-find-replace-all">{t("document.editor.replaceAll")}</button>
      <button type="button" className="pz-btn-ghost" onClick={onClose} aria-label={t("document.ui.cancel")}>✕</button>
    </div>
  );
}

function AlignIcon({ lines, center, right }: { lines: number[]; center?: boolean; right?: boolean }) {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      {lines.map((w, i) => {
        const x = center ? 10 - w / 2 : right ? 18 - w : 2;
        return <line key={i} x1={x} x2={x + w} y1={4 + i * 4} y2={4 + i * 4} />;
      })}
    </svg>
  );
}

function ListIcon({ ordered }: { ordered?: boolean }) {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="currentColor">
      {[5, 10, 15].map((y, i) =>
        ordered ? (
          <text key={y} x="1" y={y + 2.5} fontSize="6" stroke="none" fontFamily="sans-serif">{i + 1}</text>
        ) : (
          <circle key={y} cx="3.5" cy={y} r="1.4" stroke="none" />
        ),
      )}
      {[5, 10, 15].map((y) => (
        <line key={`l${y}`} x1="8" x2="18" y1={y} y2={y} fill="none" />
      ))}
    </svg>
  );
}
