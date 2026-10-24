/** Item list, detail view, editor and version history. */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { confirmDialog, useLeaveGuard } from "../home/confirmLeave";
import { copySecret } from "./clipboard";
import { generatePassword } from "./strength";
import { CatIcon, Ring, StrengthMeter, errKey, fmtDate, fmtRelative, useSafe } from "./ui";
import { CATEGORIES, type Category, type ItemData, type ItemFields, type ItemSummary, type VersionInfo } from "./types";

export const REVEAL_MS = 10_000;
const MAX_FILE = 64 * 1024 * 1024;

function fmtSize(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

/* ── List ── */

export function ItemList({ items, selected, onSelect, filter, setFilter }: { items: ItemSummary[]; selected: string | null; onSelect: (id: string) => void; filter: Category | "all" | "shared"; setFilter: (f: Category | "all" | "shared") => void }) {
  const { t, i18n } = useTranslation();
  const shown = items.filter((i) => (filter === "all" ? true : filter === "shared" ? i.received || i.grants > 0 : i.category === filter));
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items.length, shared: items.filter((i) => i.received || i.grants > 0).length };
    for (const k of CATEGORIES) c[k] = items.filter((i) => i.category === k).length;
    return c;
  }, [items]);
  return (
    <div className="cf-list-wrap">
      <div className="cf-filters" role="tablist" aria-label={t("safe.list.filter")}>
        {(["all", ...CATEGORIES, "shared"] as const).map((f) => (
          <button key={f} type="button" role="tab" aria-selected={filter === f} className={filter === f ? "is-on" : ""} onClick={() => setFilter(f)} data-testid={`cf-filter-${f}`}>
            {t(`safe.cat.${f}`)} <span>{counts[f]}</span>
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <div className="sw-empty" data-testid="cf-empty">{items.length ? t("safe.list.noneInFilter") : t("safe.list.empty")}</div>
      ) : (
        <ul className="cf-list" data-testid="cf-list">
          {shown.map((it) => (
            <li key={it.id}>
              <button type="button" className={`cf-row-item${selected === it.id ? " is-on" : ""}`} onClick={() => onSelect(it.id)} data-testid="cf-item" data-title={it.title}>
                <CatIcon c={it.category} />
                <span className="cf-row-main">
                  <strong>{it.title}</strong>
                  <small>{it.subtitle || t(`safe.cat.${it.category}`)}</small>
                </span>
                <span className="cf-row-badges">
                  {it.hasConflict && <span className="cf-badge cf-badge--warn" data-testid="cf-conflict-badge">⚠︎ {(it.conflicts || 1) + 1}</span>}
                  {it.received && <span className="cf-badge" title={t("safe.badge.received")}>↘︎ {t(`safe.role.${it.received.role}`)}</span>}
                  {it.grants > 0 && <span className="cf-badge" title={t("safe.badge.shared")}>↗︎ {it.grants}</span>}
                  <time className="cf-row-time">{fmtRelative(it.updatedAt, i18n.language)}</time>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── Secret field with copy + timed reveal ── */

function SecretField({ id, field, label, mono = true }: { id: string; field: "password" | "apiKey"; label: string; mono?: boolean }) {
  const { t } = useTranslation();
  const { client, toast } = useSafe();
  const [shown, setShown] = useState<{ value: string; until: number } | null>(null);
  useEffect(() => {
    if (!shown) return;
    const tm = setTimeout(() => setShown(null), shown.until - Date.now());
    return () => clearTimeout(tm);
  }, [shown]);
  useEffect(() => () => setShown(null), [id]);
  const copy = async () => {
    const v = await client.secret(id, field);
    if (!(await copySecret(v, label))) toast(t("safe.clip.failed"), "err");
  };
  return (
    <div className="cf-field">
      <span className="cf-field-label">{label}</span>
      <code className={`cf-field-value${mono ? " is-mono" : ""}${shown ? "" : " is-masked"}`} data-testid={`cf-val-${field}`}>
        {shown ? shown.value : "••••••••••••"}
      </code>
      <span className="cf-field-actions">
        {shown ? (
          <button type="button" className="cf-chip-btn" onClick={() => setShown(null)} data-testid={`cf-hide-${field}`}>
            <Ring until={shown.until} total={REVEAL_MS} size={18} /> {t("safe.hide")}
          </button>
        ) : (
          <button type="button" className="cf-chip-btn" onClick={async () => setShown({ value: await client.secret(id, field), until: Date.now() + REVEAL_MS })} data-testid={`cf-reveal-${field}`}>
            {t("safe.reveal")}
          </button>
        )}
        <button type="button" className="cf-chip-btn" onClick={() => void copy()} data-testid={`cf-copy-${field}`}>
          {t("safe.copy")}
        </button>
      </span>
    </div>
  );
}

function PlainField({ label, value, copyable, href, testId }: { label: string; value?: string; copyable?: boolean; href?: string; testId?: string }) {
  const { t } = useTranslation();
  const { toast } = useSafe();
  if (!value) return null;
  return (
    <div className="cf-field">
      <span className="cf-field-label">{label}</span>
      <span className="cf-field-value" data-testid={testId}>
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer nofollow">
            {value}
          </a>
        ) : (
          value
        )}
      </span>
      {copyable && (
        <span className="cf-field-actions">
          <button type="button" className="cf-chip-btn" onClick={async () => { if (!(await copySecret(value, label))) toast(t("safe.clip.failed"), "err"); }}>
            {t("safe.copy")}
          </button>
        </span>
      )}
    </div>
  );
}

function safeHref(url?: string): string | undefined {
  if (!url) return undefined;
  const u = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
  return /^https?:\/\//i.test(u) ? u : undefined;
}

/* ── Detail ── */

export function ItemDetail({ id, summary, onEdit, onShare, onConflicts, onDeleted, syncState, onRetrySync }: { id: string; summary: ItemSummary; onEdit: () => void; onShare: () => void; onConflicts: () => void; onDeleted: () => void; syncState?: { failed: string[] }; onRetrySync: () => void }) {
  const { t, i18n } = useTranslation();
  const { client, toast, refresh, peers } = useSafe();
  const [d, setD] = useState<ItemData | null>(null);
  const [history, setHistory] = useState(false);
  useEffect(() => {
    let live = true;
    setD(null);
    void client.get(id).then((x) => live && setD(x)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, id, summary.version, summary.updatedAt, summary.grants]);
  if (!d) return <div className="cf-detail cf-detail--loading" />;
  const alias = (h: string) => peers.find((p) => p.peerId === h)?.alias ?? h;
  const readOnly = d.received?.role === "reader";
  const canShare = !d.received || d.received.role === "admin";

  const del = async () => {
    const ok = await confirmDialog({ title: t("safe.del.title"), message: t("safe.del.message", { title: d.title }), detail: d.grants?.length ? t("safe.del.sharedNote") : undefined, confirmLabel: t("safe.del.confirm"), cancelLabel: t("safe.cancel"), danger: true });
    if (!ok) return;
    await client.remove(id);
    toast(t("safe.del.done"), "info");
    onDeleted();
    await refresh();
  };

  const download = async () => {
    try {
      const f = await client.readFile(id);
      const url = URL.createObjectURL(new Blob([f.bytes as Uint8Array<ArrayBuffer>], { type: f.type }));
      const a = document.createElement("a");
      a.href = url;
      a.download = f.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (ex) {
      toast(t(errKey(ex)), "err");
    }
  };

  return (
    <div className="cf-detail" data-testid="cf-detail" data-id={id}>
      <div className="cf-detail-head">
        <CatIcon c={d.category} />
        <div className="cf-detail-title">
          <h2 data-testid="cf-detail-title">{d.title}</h2>
          <small>
            {t(`safe.cat.${d.category}`)} · v{summary.version} · {fmtDate(summary.updatedAt, i18n.language)}
          </small>
        </div>
      </div>
      {summary.hasConflict && (
        <button type="button" className="cf-conflict-banner" onClick={onConflicts} data-testid="cf-conflict-open">
          ⚠️ {t("safe.conflict.banner", { count: summary.conflicts + 1 })} <span>{t("safe.conflict.resolve")} →</span>
        </button>
      )}
      {d.received && (
        <p className="cf-note" data-testid="cf-received-note">
          ↘︎ {t("safe.badge.receivedFrom", { who: alias(d.received.from), role: t(`safe.role.${d.received.role}`) })}
          {d.received.expiresAt ? ` · ${t("safe.share.expiresOn", { date: fmtDate(d.received.expiresAt, i18n.language) })}` : ""}
        </p>
      )}
      {syncState && syncState.failed.length > 0 && (
        <p className="cf-note cf-note--warn" data-testid="cf-sync-failed">
          {t("safe.sync.failed", { who: syncState.failed.map(alias).join(", ") })}{" "}
          <button type="button" className="cf-link" onClick={onRetrySync}>{t("safe.sync.retry")}</button>
        </p>
      )}
      <div className="cf-fields">
        {d.category === "login" && (
          <>
            <PlainField label={t("safe.f.username")} value={d.username} copyable testId="cf-val-username" />
            {d.password && <SecretField id={id} field="password" label={t("safe.f.password")} />}
            <PlainField label={t("safe.f.url")} value={d.url} href={safeHref(d.url)} />
          </>
        )}
        {d.category === "api_key" && (
          <>
            <PlainField label={t("safe.f.service")} value={d.service} />
            {d.apiKey && <SecretField id={id} field="apiKey" label={t("safe.f.apiKey")} />}
          </>
        )}
        {d.category === "file" && d.file && (
          <div className="cf-field">
            <span className="cf-field-label">{t("safe.f.file")}</span>
            <span className="cf-field-value">
              📎 {d.file.name} · {fmtSize(d.file.size)}
              <small className="cf-merkle" title={t("safe.f.merkleHint")}>
                {t("safe.f.merkle")} {d.file.root.slice(0, 16)}…
              </small>
            </span>
            <span className="cf-field-actions">
              <button type="button" className="cf-chip-btn" onClick={() => void download()} data-testid="cf-download">
                {t("safe.f.download")}
              </button>
            </span>
          </div>
        )}
        {d.notes && (
          <div className="cf-field cf-field--notes">
            <span className="cf-field-label">{t("safe.f.notes")}</span>
            <p className="cf-notes" data-testid="cf-val-notes">{d.notes}</p>
          </div>
        )}
        {d.tags.length > 0 && (
          <div className="cf-tags">
            {d.tags.map((x) => (
              <span key={x} className="sw-chip">#{x}</span>
            ))}
          </div>
        )}
        {d.grants && d.grants.length > 0 && (
          <div className="cf-field">
            <span className="cf-field-label">{t("safe.share.sharedWith")}</span>
            <span className="cf-field-value cf-grants">
              {d.grants.map((g) => (
                <span key={g.peerId} className="sw-chip" title={g.peerId}>
                  {alias(g.peerId)} · {t(`safe.role.${g.role}`)}
                  {g.expiresAt ? ` · ⏳ ${fmtDate(g.expiresAt, i18n.language)}` : ""}
                </span>
              ))}
            </span>
          </div>
        )}
      </div>
      <div className="cf-detail-actions">
        <button type="button" className="pz-btn" onClick={onEdit} disabled={readOnly} title={readOnly ? t("safe.err.read-only") : undefined} data-testid="cf-edit">
          {t("safe.edit")}
        </button>
        <button type="button" className="pz-btn pz-btn-ghost" onClick={onShare} disabled={!canShare} data-testid="cf-share">
          ↗︎ {t("safe.share.cta")}
        </button>
        <button type="button" className="pz-btn pz-btn-ghost" onClick={() => setHistory((h) => !h)} data-testid="cf-history">
          🕓 {t("safe.history.title")}
        </button>
        <button type="button" className="cf-link cf-danger-link" onClick={() => void del()} data-testid="cf-delete">
          {t("safe.del.cta")}
        </button>
      </div>
      {history && <History id={id} readOnly={readOnly} />}
    </div>
  );
}

function History({ id, readOnly }: { id: string; readOnly: boolean }) {
  const { t, i18n } = useTranslation();
  const { client, refresh, toast } = useSafe();
  const [list, setList] = useState<VersionInfo[]>([]);
  const [view, setView] = useState<{ v: number; d: ItemData } | null>(null);
  useEffect(() => {
    void client.versions(id).then(setList);
  }, [client, id]);
  return (
    <div className="cf-history" data-testid="cf-history-panel">
      <ul>
        {list.map((v) => (
          <li key={v.version}>
            <span>
              v{v.version} · {fmtDate(v.at, i18n.language)} {v.current && <em>({t("safe.history.current")})</em>}
            </span>
            {!v.current && (
              <span className="cf-row">
                <button type="button" className="cf-chip-btn" onClick={async () => setView({ v: v.version, d: await client.getVersion(id, v.version) })}>
                  {t("safe.history.view")}
                </button>
                {!readOnly && (
                  <button
                    type="button"
                    className="cf-chip-btn"
                    onClick={async () => {
                      await client.restoreVersion(id, v.version);
                      toast(t("safe.history.restored", { v: v.version }), "ok");
                      setView(null);
                      setList(await client.versions(id));
                      await refresh();
                    }}
                  >
                    {t("safe.history.restore")}
                  </button>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
      {view && (
        <div className="cf-history-view">
          <strong>v{view.v} — {view.d.title}</strong>
          <dl>
            {view.d.username && (<><dt>{t("safe.f.username")}</dt><dd>{view.d.username}</dd></>)}
            {view.d.password && (<><dt>{t("safe.f.password")}</dt><dd>{"•".repeat(10)} <small>({t("safe.history.masked")})</small></dd></>)}
            {view.d.url && (<><dt>{t("safe.f.url")}</dt><dd>{view.d.url}</dd></>)}
            {view.d.service && (<><dt>{t("safe.f.service")}</dt><dd>{view.d.service}</dd></>)}
            {view.d.notes && (<><dt>{t("safe.f.notes")}</dt><dd className="cf-notes">{view.d.notes}</dd></>)}
          </dl>
        </div>
      )}
    </div>
  );
}

/* ── Editor ── */

export function ItemEditor({ id, category, onSaved, onCancel }: { id: string | null; category: Category; onSaved: (id: string) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const { client, toast } = useSafe();
  const [f, setF] = useState<ItemFields>({ category, title: "", tags: [] });
  const [tags, setTags] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [loaded, setLoaded] = useState(!id);
  useLeaveGuard(dirty, { detail: "safe.leaveEditor" });

  useEffect(() => {
    if (!id) return;
    void client.get(id).then((d) => {
      const { clock: _c, grants: _g, received: _r, file: _f, ...rest } = d;
      setF(rest);
      setTags(d.tags.join(", "));
      setLoaded(true);
    });
  }, [client, id]);

  const set = (k: keyof ItemFields, v: string) => {
    setDirty(true);
    setF((x) => ({ ...x, [k]: v }));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const fields: ItemFields = { ...f, tags: tags.split(/[,\s]+/).map((x) => x.replace(/^#/, "")).filter(Boolean) };
      let payload: { name: string; type: string; bytes: Uint8Array } | undefined;
      if (!id && category === "file") {
        if (!file) return;
        payload = { name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) };
        if (!fields.title.trim()) fields.title = file.name;
      }
      const newId = await client.put(id, fields, payload);
      setDirty(false);
      onSaved(newId);
    } catch (ex) {
      toast(t(errKey(ex)), "err");
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) return <div className="cf-detail cf-detail--loading" />;
  const c = f.category;
  return (
    <form className="cf-detail cf-editor" onSubmit={submit} data-testid="cf-editor">
      <div className="cf-detail-head">
        <CatIcon c={c} />
        <div className="cf-detail-title">
          <h2>{id ? t("safe.editor.edit") : t(`safe.editor.new.${c}`)}</h2>
        </div>
      </div>
      <label className="v3-field sw-field">
        <span>{t("safe.f.title")}</span>
        <input value={f.title} onChange={(e) => set("title", e.target.value)} autoFocus required={c !== "file"} maxLength={200} data-testid="cf-f-title" />
      </label>
      {c === "login" && (
        <>
          <label className="v3-field sw-field">
            <span>{t("safe.f.username")}</span>
            <input value={f.username ?? ""} onChange={(e) => set("username", e.target.value)} autoComplete="off" data-testid="cf-f-username" />
          </label>
          <label className="v3-field sw-field">
            <span>{t("safe.f.password")}</span>
            <div className="cf-pw">
              <input type={show ? "text" : "password"} value={f.password ?? ""} onChange={(e) => set("password", e.target.value)} autoComplete="new-password" spellCheck={false} data-testid="cf-f-password" />
              <button type="button" className="cf-icon-btn" onClick={() => setShow((s) => !s)} aria-label={t(show ? "safe.hide" : "safe.show")}>{show ? "🙈" : "👁"}</button>
              <button type="button" className="cf-icon-btn" onClick={() => { set("password", generatePassword(20)); setShow(true); }} title={t("safe.editor.generate")} data-testid="cf-generate">🎲</button>
            </div>
          </label>
          <StrengthMeter value={f.password ?? ""} />
          <label className="v3-field sw-field">
            <span>{t("safe.f.url")}</span>
            <input value={f.url ?? ""} onChange={(e) => set("url", e.target.value)} inputMode="url" placeholder="https://" data-testid="cf-f-url" />
          </label>
        </>
      )}
      {c === "api_key" && (
        <>
          <label className="v3-field sw-field">
            <span>{t("safe.f.service")}</span>
            <input value={f.service ?? ""} onChange={(e) => set("service", e.target.value)} data-testid="cf-f-service" />
          </label>
          <label className="v3-field sw-field">
            <span>{t("safe.f.apiKey")}</span>
            <input type={show ? "text" : "password"} value={f.apiKey ?? ""} onChange={(e) => set("apiKey", e.target.value)} autoComplete="off" spellCheck={false} data-testid="cf-f-apikey" />
          </label>
        </>
      )}
      {c === "file" && !id && (
        <label className="v3-field sw-field">
          <span>{t("safe.f.file")}</span>
          <input type="file" onChange={(e) => { const x = e.target.files?.[0] ?? null; if (x && x.size > MAX_FILE) { toast(t("safe.editor.tooBig"), "err"); e.target.value = ""; return; } setFile(x); setDirty(true); }} data-testid="cf-f-file" />
          <small className="sw-small">{t("safe.editor.fileHint")}</small>
        </label>
      )}
      <label className="v3-field sw-field">
        <span>{t("safe.f.notes")}</span>
        <textarea className="cf-textarea" rows={c === "note" ? 8 : 3} value={f.notes ?? ""} onChange={(e) => set("notes", e.target.value)} data-testid="cf-f-notes" />
      </label>
      <label className="v3-field sw-field">
        <span>{t("safe.f.tags")}</span>
        <input value={tags} onChange={(e) => { setTags(e.target.value); setDirty(true); }} placeholder={t("safe.f.tagsHint")} data-testid="cf-f-tags" />
      </label>
      <div className="cf-detail-actions">
        <button type="submit" className="pz-btn" disabled={busy || (c === "file" && !id && !file)} data-testid="cf-save">
          {busy ? t("safe.saving") : t("safe.save")}
        </button>
        <button type="button" className="pz-btn pz-btn-ghost" onClick={async () => { if (dirty && !(await confirmDialog({ title: t("safe.discard.title"), message: t("safe.discard.message"), confirmLabel: t("safe.discard.confirm"), cancelLabel: t("safe.cancel"), danger: true }))) return; setDirty(false); onCancel(); }}>
          {t("safe.cancel")}
        </button>
      </div>
    </form>
  );
}
