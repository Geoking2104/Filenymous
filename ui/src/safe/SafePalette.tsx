import { createPortal } from "react-dom";
/** Cmd/Ctrl+K command palette: hybrid search (FTS5 + local MiniLM), copy, reveal, open. */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { copySecret } from "./clipboard";
import type { SafeEmbedder } from "./embed";
import { REVEAL_MS } from "./SafeItems";
import { CatIcon, Ring, overlayRoot, useSafe } from "./ui";
import type { ItemSummary } from "./types";

export function Palette({ items, onClose, onOpen, embedder, semanticReady, onToggleSemantic, semanticState }: {
  items: ItemSummary[];
  onClose: () => void;
  onOpen: (id: string) => void;
  embedder: SafeEmbedder | null;
  semanticReady: boolean;
  onToggleSemantic: () => void;
  semanticState: "off" | "loading" | "on" | "unavailable";
}) {
  const { t } = useTranslation();
  const { client, toast, status } = useSafe();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ id: string; score: number; cosine: number | null }[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [reveal, setReveal] = useState<{ id: string; value: string; until: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    const query = q.trim();
    if (!query) return setHits(null);
    let live = true;
    const tm = setTimeout(async () => {
      let vec: Float32Array | null = null;
      if (semanticReady && embedder) vec = (await embedder.embed([query]).catch(() => [null]))[0] ?? null;
      const r = await client.search(query, vec);
      if (live) {
        setHits(r);
        setIdx(0);
      }
    }, 90);
    return () => {
      live = false;
      clearTimeout(tm);
    };
  }, [q, client, embedder, semanticReady]);

  useEffect(() => {
    if (!reveal) return;
    const tm = setTimeout(() => setReveal(null), reveal.until - Date.now());
    return () => clearTimeout(tm);
  }, [reveal]);

  const rows: { it: ItemSummary; semantic: boolean }[] = hits ? hits.map((h) => ({ it: byId.get(h.id)!, semantic: h.cosine != null && h.cosine >= 0.3 })).filter((r) => r.it) : items.slice(0, 8).map((it) => ({ it, semantic: false }));
  const cur = rows[Math.min(idx, rows.length - 1)]?.it;

  const field = (it: ItemSummary): "password" | "apiKey" | "username" | null => (it.category === "login" ? (it.hasSecret ? "password" : "username") : it.category === "api_key" && it.hasSecret ? "apiKey" : null);

  const copy = async (it: ItemSummary, which?: "username") => {
    const f = which ?? field(it);
    if (!f) return onOpen(it.id);
    const v = await client.secret(it.id, f);
    if (!v) return toast(t("safe.palette.nothing"), "info");
    if (await copySecret(v, `${it.title} · ${t(`safe.f.${f}`)}`)) onClose();
    else toast(t("safe.clip.failed"), "err");
  };

  const doReveal = async (it: ItemSummary) => {
    const f = field(it);
    if (!f) return onOpen(it.id);
    setReveal({ id: it.id, value: await client.secret(it.id, f), until: Date.now() + REVEAL_MS });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      return onClose();
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(rows.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && cur) {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) onOpen(cur.id);
      else if (e.altKey) void doReveal(cur);
      else if (e.shiftKey) void copy(cur, "username");
      else void copy(cur);
    }
  };

  return createPortal(
    <div className="cf-pal-backdrop" onMouseDown={onClose} data-testid="cf-palette">
      <div className="cf-pal" role="dialog" aria-modal="true" aria-label={t("safe.palette.label")} onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="cf-pal-input">
          <span aria-hidden="true">⌕</span>
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("safe.palette.placeholder")} aria-label={t("safe.palette.placeholder")} spellCheck={false} autoComplete="off" data-testid="cf-pal-input" role="combobox" aria-expanded="true" aria-controls="cf-pal-list" aria-activedescendant={cur ? `cf-pal-${cur.id}` : undefined} />
          <kbd>Esc</kbd>
        </div>
        <ul className="cf-pal-list" id="cf-pal-list" role="listbox">
          {!hits && rows.length > 0 && <li className="cf-pal-section">{t("safe.palette.recent")}</li>}
          {rows.length === 0 && <li className="cf-pal-empty" data-testid="cf-pal-empty">{q ? t("safe.palette.noResult") : t("safe.list.empty")}</li>}
          {rows.map(({ it, semantic }, i) => (
            <li key={it.id} id={`cf-pal-${it.id}`} role="option" aria-selected={i === idx} className={i === idx ? "is-on" : ""} onMouseEnter={() => setIdx(i)} onClick={() => void copy(it)} data-testid="cf-pal-row" data-title={it.title}>
              <CatIcon c={it.category} />
              <span className="cf-row-main">
                <strong>{it.title}</strong>
                <small>{reveal?.id === it.id ? <code className="cf-pal-reveal" data-testid="cf-pal-reveal">{reveal.value}</code> : it.subtitle}</small>
              </span>
              {reveal?.id === it.id && <Ring until={reveal.until} total={REVEAL_MS} size={20} />}
              {semantic && <span className="cf-badge cf-badge--ai" title={t("safe.palette.semanticHit")}>≈</span>}
              <span className="cf-pal-acts">
                <button type="button" className="cf-chip-btn" onClick={(e) => { e.stopPropagation(); void doReveal(it); }} tabIndex={-1}>{t("safe.reveal")}</button>
                <button type="button" className="cf-chip-btn" onClick={(e) => { e.stopPropagation(); onOpen(it.id); }} tabIndex={-1}>{t("safe.open")}</button>
              </span>
            </li>
          ))}
        </ul>
        <div className="cf-pal-foot">
          <span><kbd>↵</kbd> {t("safe.palette.kCopy")}</span>
          <span><kbd>⇧↵</kbd> {t("safe.palette.kUser")}</span>
          <span><kbd>⌥↵</kbd> {t("safe.palette.kReveal")}</span>
          <span><kbd>⌘↵</kbd> {t("safe.palette.kOpen")}</span>
          <button type="button" className={`cf-ai-toggle is-${semanticState}`} onClick={onToggleSemantic} disabled={semanticState === "loading" || semanticState === "unavailable"} data-testid="cf-semantic" title={t("safe.palette.semanticHint")}>
            ✦ {t(`safe.palette.semantic.${semanticState}`)}
            {status.settings.semantic ? "" : ` · ${t("safe.palette.semanticSize")}`}
          </button>
        </div>
      </div>
    </div>,
    overlayRoot(),
  );
}
