import { useState } from "react";
import { useTranslation } from "react-i18next";
import { bytesText, deriveFollow, fingerprint, parseFollowKey, seal, symDecrypt, textBytes, type FollowKeys } from "./crypto";
import { reporterFollowup, reporterThread, type Status } from "./api";
import { StatusBadge, errorText, fmtDate } from "./common";

interface View { status: Status; createdAt: number; expiresAt: number; pub: string | null; fp: string; items: Array<{ from: "org" | "reporter"; at: number; text: string | null }> }

/** `#report-follow`: the reporter checks status, reads replies, follows up. */
export default function ReportFollowPanel() {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const [keys, setKeys] = useState<FollowKeys | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (k: FollowKeys) => {
    const r = await reporterThread(k.id, k.token);
    const items = await Promise.all(r.thread.map(async (m) => {
      if (m.from === "org" && m.msg) {
        try {
          return { from: m.from, at: m.at, text: bytesText(await symDecrypt(k.reply, m.msg, `reply:${k.id}`)) };
        } catch {
          return { from: m.from, at: m.at, text: null };
        }
      }
      return { from: m.from, at: m.at, text: null }; // sealed to the organisation only
    }));
    setView({ status: r.status, createdAt: r.createdAt, expiresAt: r.expiresAt, pub: r.pub, fp: r.pub ? await fingerprint(r.pub) : "", items });
  };

  const unlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const f = parseFollowKey(input);
    if (!f) return setError(t("report.follow.badFormat"));
    setBusy(true);
    try {
      const k = await deriveFollow(f);
      await load(k);
      setKeys(k);
      setInput("");
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!keys || !view?.pub || !reply.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await reporterFollowup(keys.id, keys.token, await seal(view.pub, textBytes(reply.trim()), `followup:${keys.id}`));
      setReply("");
      await load(keys);
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  if (!keys || !view) {
    return (
      <form className="v3-result rp" data-testid="report-follow" onSubmit={unlock}>
        <div className="v3-step">{t("report.follow.title")}</div>
        <p className="v3-muted">{t("report.follow.intro")}</p>
        <label className="v3-field">
          <span>{t("report.follow.key")}</span>
          <input data-testid="report-follow-input" autoComplete="off" spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} placeholder="ABCD-EFGH-…" />
        </label>
        {error && <div className="v3-warn" role="alert" data-testid="report-follow-error">{error}</div>}
        <button type="submit" className="v3-btn" data-testid="report-follow-open" disabled={busy || !input.trim()}>{busy ? t("report.working") : t("report.follow.open")}</button>
        <p className="v3-footnote">{t("report.guide.tor")}</p>
      </form>
    );
  }

  return (
    <div className="v3-result rp" data-testid="report-follow-view">
      <div className="v3-step">{t("report.follow.viewTitle")} <StatusBadge status={view.status} /></div>
      <p className="v3-muted">{t("report.follow.dates", { created: fmtDate(view.createdAt), expires: fmtDate(view.expiresAt) })}</p>
      <ol className="rp-thread" data-testid="report-thread">
        {view.items.length === 0 && <li className="v3-muted">{t("report.follow.noReply")}</li>}
        {view.items.map((m, i) => (
          <li key={i} className={`rp-msg rp-msg--${m.from}`} data-testid={`report-msg-${m.from}`}>
            <small>{m.from === "org" ? t("report.follow.fromOrg") : t("report.follow.fromYou")} · {fmtDate(m.at)}</small>
            <p>{m.text ?? (m.from === "reporter" ? t("report.follow.sealedMine") : t("report.follow.undecryptable"))}</p>
          </li>
        ))}
      </ol>
      {view.status !== "clos" && view.pub && (
        <form onSubmit={send}>
          <label className="v3-field">
            <span>{t("report.follow.reply")}</span>
            <textarea data-testid="report-followup-text" rows={4} value={reply} onChange={(e) => setReply(e.target.value)} />
          </label>
          <p className="rp-fp">{t("report.fingerprint")} <code>{view.fp}</code></p>
          <button type="submit" className="v3-btn" data-testid="report-followup-send" disabled={busy || !reply.trim()}>{t("report.follow.send")}</button>
        </form>
      )}
      {error && <div className="v3-warn" role="alert">{error}</div>}
      <button type="button" className="v3-btn-ghost" onClick={() => { setKeys(null); setView(null); }}>{t("report.follow.close")}</button>
    </div>
  );
}
