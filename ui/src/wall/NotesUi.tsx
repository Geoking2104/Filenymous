/**
 * Shared notes UI: list (side panel / mobile drawer), editor (main column),
 * search hits. Rendering is text-only via Markup (no HTML).
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { confirmDialog } from "../home/confirmLeave";
import { Hl, Markup } from "./Markup";
import type { MentionTarget } from "./markup";
import { NOTE_MAX_BYTES, NOTE_TITLE_MAX, utf8Bytes, type NoteLock, type SharedNote } from "./notes";
import { matchSnippet } from "./search-annotations";

export interface NotesApi {
  createNote(title: string, text?: string): void | Promise<void>;
  editNote(id: string, base: number, patch: { title?: string; text?: string }): void | Promise<void>;
  deleteNote(id: string): void | Promise<void>;
  lockNote(id: string, on: boolean): void;
  pinNote?(id: string, on: boolean): void;
}

const SEND_DEBOUNCE_MS = 700;
const LOCK_REFRESH_MS = 4000;

const hhmm = (at: number, lang: string) => new Date(at).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
export const liveLock = (l: NoteLock | undefined, now: number) => (l && l.until > now ? l : undefined);

export function NotesList({ notes, locks, self, now, nameOf, openId, onOpen, onCreate }: {
  notes: SharedNote[];
  locks: Record<string, NoteLock>;
  self?: string;
  now: number;
  nameOf: (label: string) => string;
  openId: string | null;
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  const { t, i18n } = useTranslation();
  return (
    <section className="sw2-section sw2-notes" data-testid="notes-panel">
      <button type="button" className="v3-btn-ghost sw2-note-new" data-testid="note-new" onClick={onCreate}>
        ＋ {t("wall.notes.new")}
      </button>
      {notes.length === 0 ? (
        <p className="sw-small" data-testid="notes-empty">{t("wall.notes.empty")}</p>
      ) : (
        <ul className="sw2-note-list">
          {notes.map((n) => {
            const l = liveLock(locks[n.id], now);
            return (
              <li key={n.id}>
                <button
                  type="button"
                  className={`sw2-note-row${openId === n.id ? " is-open" : ""}`}
                  data-testid="note-row"
                  data-id={n.id}
                  data-title={n.title}
                  aria-current={openId === n.id}
                  onClick={() => onOpen(n.id)}
                >
                  <span className="sw2-note-row-title">
                    {n.pinned && <span data-testid="note-pinned" title={t("wall.notes.pinned")}>📌 </span>}
                    {n.title || t("wall.notes.untitled")}
                  </span>
                  <span className="sw-small">{t("wall.notes.lastEdit", { name: n.editedBy === self ? t("wall.you") : nameOf(n.editedBy), time: hhmm(n.editedAt, i18n.language) })}</span>
                  {l && l.label !== self && <span className="sw2-note-writing" data-testid="note-row-writing">✍️ {t("wall.notes.writing", { name: nameOf(l.label) })}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function NoteSearchHits({ notes, query, onOpen }: { notes: SharedNote[]; query: string; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  if (!notes.length) return null;
  return (
    <div className="sw2-note-hits" data-testid="wall-search-notes">
      <p className="sw2-h">📝 {t("wall.notes.searchHeading", { count: notes.length })}</p>
      {notes.map((n) => (
        <button key={n.id} type="button" className="sw2-note-hit" data-testid="wall-search-note" data-id={n.id} onClick={() => onOpen(n.id)}>
          <strong><Hl text={n.title || t("wall.notes.untitled")} q={query} /></strong>
          <span className="sw-small"><Hl text={matchSnippet(n.text, query)} q={query} /></span>
        </button>
      ))}
    </div>
  );
}

export function NoteEditor({ note, lock, self, isHost, now, nameOf, members, api, onClose }: {
  note: SharedNote;
  lock?: NoteLock;
  self?: string;
  isHost: boolean;
  now: number;
  nameOf: (label: string) => string;
  members: MentionTarget[];
  api: NotesApi;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [title, setTitle] = useState(note.title);
  const [text, setText] = useState(note.text);
  const [preview, setPreview] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  /** Last host version this editor has taken into account. */
  const base = useRef(note.v);
  const sent = useRef({ title: note.title, text: note.text });
  const draft = useRef({ title, text });
  draft.current = { title, text };
  const lastLock = useRef(0);
  const dirty = title !== sent.current.title || text !== sent.current.text;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const bytes = utf8Bytes(text);
  const tooLarge = bytes > NOTE_MAX_BYTES;

  // Remote versions: adopt them unless we are in the middle of an edit.
  useEffect(() => {
    if (note.editedBy === self) {
      base.current = Math.max(base.current, note.v);
      return;
    }
    if (note.v <= base.current) return;
    if (dirtyRef.current) {
      // Keep the draft; sending it will replace their version (they get told).
      setConflict(nameOf(note.editedBy));
      return;
    }
    base.current = note.v;
    sent.current = { title: note.title, text: note.text };
    setTitle(note.title);
    setText(note.text);
    setConflict(null);
  }, [note, self, nameOf]);

  const flush = () => {
    const d = draft.current;
    if (utf8Bytes(d.text) > NOTE_MAX_BYTES) return;
    const patch: { title?: string; text?: string } = {};
    if (d.title !== sent.current.title) patch.title = d.title;
    if (d.text !== sent.current.text) patch.text = d.text;
    if (patch.title === undefined && patch.text === undefined) return;
    sent.current = { ...d };
    setConflict(null);
    void Promise.resolve(api.editNote(note.id, base.current, patch)).catch(() => undefined);
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(() => {
    if (!dirty || tooLarge) return;
    const id = setTimeout(() => flushRef.current(), SEND_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [title, text, dirty, tooLarge]);

  // Release the soft lock and send the last keystrokes when the editor closes.
  useEffect(
    () => () => {
      flushRef.current();
      if (lastLock.current) api.lockNote(note.id, false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [note.id],
  );

  const touch = () => {
    const t0 = Date.now();
    if (t0 - lastLock.current < LOCK_REFRESH_MS) return;
    lastLock.current = t0;
    api.lockNote(note.id, true);
  };

  const other = lock && lock.until > now && lock.label !== self ? lock : undefined;
  const canDelete = isHost || note.by === self;

  return (
    <section className="sw2-note-editor" data-testid="note-editor" data-id={note.id} data-v={note.v} aria-label={t("wall.notes.editorLabel")}>
      <div className="sw2-note-editor-head">
        <input
          className="v3-input"
          data-testid="note-title"
          value={title}
          maxLength={NOTE_TITLE_MAX}
          placeholder={t("wall.notes.titlePlaceholder")}
          aria-label={t("wall.notes.titlePlaceholder")}
          onChange={(e) => (setTitle(e.target.value), touch())}
        />
        <div className="sw2-note-tools">
          <button type="button" className="sw2-chip" data-testid="note-preview-toggle" aria-pressed={preview} onClick={() => setPreview((p) => !p)}>
            {preview ? `✏️ ${t("wall.notes.edit")}` : `👁 ${t("wall.notes.preview")}`}
          </button>
          {isHost && api.pinNote && (
            <button type="button" className="sw2-chip" data-testid="note-pin" aria-pressed={note.pinned} onClick={() => api.pinNote!(note.id, !note.pinned)}>
              📌 {note.pinned ? t("wall.notes.unpin") : t("wall.notes.pin")}
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              className="sw2-chip is-danger"
              data-testid="note-delete"
              onClick={() =>
                void confirmDialog({ title: t("wall.notes.delete"), message: t("wall.notes.deleteConfirm", { title: note.title || t("wall.notes.untitled") }), confirmLabel: t("wall.notes.delete"), cancelLabel: t("leave.cancel"), danger: true }).then(
                  (ok) => ok && (void Promise.resolve(api.deleteNote(note.id)).catch(() => undefined), onClose()),
                )
              }
            >
              🗑 {t("wall.notes.delete")}
            </button>
          )}
          <button type="button" className="sw-x" data-testid="note-close" aria-label={t("wall.notes.close")} title={t("wall.notes.close")} onClick={onClose}>
            ✕
          </button>
        </div>
      </div>
      <p className="sw-small" data-testid="note-meta">
        {t("wall.notes.lastEdit", { name: note.editedBy === self ? t("wall.you") : nameOf(note.editedBy), time: hhmm(note.editedAt, i18n.language) })}
        {other && (
          <span className="sw2-note-writing" data-testid="note-writing"> · ✍️ {t("wall.notes.writing", { name: nameOf(other.label) })}</span>
        )}
      </p>
      {conflict && <p className="sw2-banner is-warn" role="status" data-testid="note-conflict">⚠ {t("wall.notes.conflict", { name: conflict })}</p>}
      {preview ? (
        <div className="sw2-note-preview" data-testid="note-preview">
          {text ? <Markup text={text} members={members} self={self} /> : <p className="sw-small">{t("wall.notes.emptyNote")}</p>}
        </div>
      ) : (
        <textarea
          className="v3-input sw2-note-text"
          data-testid="note-text"
          value={text}
          placeholder={t("wall.notes.textPlaceholder")}
          aria-label={t("wall.notes.textPlaceholder")}
          onChange={(e) => (setText(e.target.value), touch())}
          onBlur={() => flushRef.current()}
          rows={12}
        />
      )}
      <p className={`sw-small sw2-note-size${tooLarge ? " is-over" : ""}`} data-testid="note-size">
        {tooLarge ? t("wall.notes.tooLarge", { max: Math.round(NOTE_MAX_BYTES / 1024) }) : `${Math.ceil(bytes / 1024)} / ${Math.round(NOTE_MAX_BYTES / 1024)} Ko`}
        {dirty && !tooLarge && <span data-testid="note-saving"> · {t("wall.notes.saving")}</span>}
      </p>
    </section>
  );
}
