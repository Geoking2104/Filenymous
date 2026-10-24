/** Concurrent edits (vector clocks): side-by-side diff, keep A / keep B / manual merge. */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { errKey, fmtDate, useSafe } from "./ui";
import type { ConflictInfo, ItemData, ItemFields } from "./types";

const FIELDS = ["title", "username", "password", "url", "service", "apiKey", "notes", "tags"] as const;
type F = (typeof FIELDS)[number];
const SECRET: F[] = ["password", "apiKey"];

const val = (d: ItemData, f: F): string => (f === "tags" ? (d.tags ?? []).join(", ") : String(d[f] ?? ""));

export function ConflictView({ id, onDone }: { id: string; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const { client, refresh, toast } = useSafe();
  const [mine, setMine] = useState<ItemData | null>(null);
  const [list, setList] = useState<ConflictInfo[]>([]);
  const [which, setWhich] = useState(0);
  const [reveal, setReveal] = useState(false);
  const [manual, setManual] = useState(false);
  const [pick, setPick] = useState<Record<string, "a" | "b">>({});

  useEffect(() => {
    void Promise.all([client.get(id), client.conflicts(id)]).then(([m, c]) => {
      setMine(m);
      setList(c);
    });
  }, [client, id]);

  useEffect(() => {
    if (!reveal) return;
    const tm = setTimeout(() => setReveal(false), 10_000);
    return () => clearTimeout(tm);
  }, [reveal]);

  if (!mine) return <div className="cf-detail cf-detail--loading" />;
  const theirs = list[which];
  if (!theirs) {
    return (
      <div className="cf-detail">
        <p>{t("safe.conflict.none")}</p>
        <button type="button" className="pz-btn" onClick={onDone}>{t("safe.close")}</button>
      </div>
    );
  }
  const b = theirs.data;
  const rows = FIELDS.filter((f) => val(mine, f) || val(b, f));
  const diff = (f: F) => val(mine, f) !== val(b, f);

  const finish = async (choice: Parameters<typeof client.resolve>[1]) => {
    try {
      await client.resolve(id, choice);
      toast(t("safe.conflict.resolved"), "ok");
      await refresh();
      onDone();
    } catch (ex) {
      toast(t(errKey(ex)), "err");
    }
  };

  const merged = (): ItemFields => {
    const out: ItemFields = { category: mine.category, title: mine.title, tags: mine.tags };
    for (const f of FIELDS) {
      const src = (pick[f] ?? "a") === "a" ? mine : b;
      if (f === "tags") out.tags = src.tags ?? [];
      else if (src[f] !== undefined) (out as unknown as Record<string, unknown>)[f] = src[f];
    }
    out.title ||= mine.title;
    return out;
  };

  const show = (d: ItemData, f: F) => (SECRET.includes(f) && !reveal && val(d, f) ? "••••••••" : val(d, f) || "—");

  return (
    <div className="cf-detail cf-conflict" data-testid="cf-conflict-view">
      <div className="cf-conflict-head">
        <h2>⚠️ {t("safe.conflict.title", { count: list.length + 1 })}</h2>
        <p className="v3-muted">{t("safe.conflict.lead")}</p>
        {list.length > 1 && (
          <select className="cf-select" value={which} onChange={(e) => setWhich(Number(e.target.value))}>
            {list.map((c, i) => (
              <option key={c.conflictId} value={i}>{c.authorAlias ?? c.author}</option>
            ))}
          </select>
        )}
      </div>
      <table className="cf-diff" data-testid="cf-diff">
        <thead>
          <tr>
            <th />
            <th>A · {t("safe.conflict.mine")}</th>
            <th>B · {theirs.authorAlias ?? theirs.author} <small>· {fmtDate(theirs.at, i18n.language)}</small></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr key={f} className={diff(f) ? "is-diff" : ""}>
              <th>{t(`safe.f.${f}`)}</th>
              {(["a", "b"] as const).map((side) => (
                <td key={side} className={manual && diff(f) && (pick[f] ?? "a") === side ? "is-picked" : ""}>
                  {manual && diff(f) ? (
                    <label className="cf-pick">
                      <input type="radio" name={`pick-${f}`} checked={(pick[f] ?? "a") === side} onChange={() => setPick((p) => ({ ...p, [f]: side }))} data-testid={`cf-pick-${f}-${side}`} />
                      <span className={f === "notes" ? "cf-notes" : ""}>{show(side === "a" ? mine : b, f)}</span>
                    </label>
                  ) : (
                    <span className={f === "notes" ? "cf-notes" : ""}>{show(side === "a" ? mine : b, f)}</span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.some((f) => SECRET.includes(f)) && (
        <button type="button" className="cf-link" onClick={() => setReveal((r) => !r)}>{reveal ? t("safe.hide") : t("safe.conflict.revealSecrets")}</button>
      )}
      <div className="cf-detail-actions">
        {manual ? (
          <>
            <button type="button" className="pz-btn" onClick={() => void finish({ keep: "manual", fields: merged() })} data-testid="cf-merge-save">{t("safe.conflict.saveMerge")}</button>
            <button type="button" className="pz-btn pz-btn-ghost" onClick={() => setManual(false)}>{t("safe.cancel")}</button>
          </>
        ) : (
          <>
            <button type="button" className="pz-btn" onClick={() => void finish({ keep: "local" })} data-testid="cf-keep-a">{t("safe.conflict.keepA")}</button>
            <button type="button" className="pz-btn" onClick={() => void finish({ keep: "remote", conflictId: theirs.conflictId })} data-testid="cf-keep-b">{t("safe.conflict.keepB")}</button>
            <button type="button" className="pz-btn pz-btn-ghost" onClick={() => setManual(true)} data-testid="cf-merge">{t("safe.conflict.manual")}</button>
            <button type="button" className="cf-link" onClick={onDone}>{t("safe.later")}</button>
          </>
        )}
      </div>
    </div>
  );
}
