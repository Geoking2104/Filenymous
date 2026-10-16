import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { b64urlDecode } from "../p2p/protocol";
import { bytesText, decodePayload, open, parseKeyFile, symDecrypt, symEncrypt, textBytes, unlockKeyFile, fingerprint, type KeyFile, type MailboxKeys, type ReportPayload } from "./crypto";
import { listReports, openReport, replyReport, setStatus, type ReportSummary, type Status } from "./api";
import { KEY_STORAGE_PREFIX, MetaLine, StatusBadge, errorText, fmtDate, saveFile } from "./common";

const STATUSES: Status[] = ["recu", "en-cours", "clos"];

function storedKeys(): KeyFile[] {
  const out: KeyFile[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(KEY_STORAGE_PREFIX)) {
        const f = parseKeyFile(localStorage.getItem(k) || "");
        if (f) out.push(f);
      }
    }
  } catch {
    /* storage disabled */
  }
  return out;
}

interface Opened { id: string; status: Status; createdAt: number; payload: ReportPayload; thread: Array<{ from: "org" | "reporter"; at: number; text: string | null }> }

/** `#report-inbox`: the organisation unlocks its key and handles reports. */
export default function ReportInboxPanel() {
  const { t } = useTranslation();
  const stored = useMemo(storedKeys, []);
  const [file, setFile] = useState<KeyFile | null>(stored[0] ?? null);
  const [pass, setPass] = useState("");
  const [keys, setKeys] = useState<MailboxKeys | null>(null);
  const [fp, setFp] = useState("");
  const [list, setList] = useState<ReportSummary[]>([]);
  const [cur, setCur] = useState<Opened | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mailbox = file?.mailbox ?? "";

  const refresh = async (k: MailboxKeys) => setList((await listReports(mailbox, k.admin)).reports);

  const unlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const k = await unlockKeyFile(file, pass);
      await refresh(k);
      setKeys(k);
      setFp(await fingerprint(k.pub));
      setPass("");
    } catch (err) {
      setError(err instanceof Error && err.message === "bad-passphrase" ? t("report.inbox.badPassphrase") : errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  const show = async (id: string) => {
    if (!keys) return;
    setBusy(true);
    setError(null);
    try {
      const r = await openReport(mailbox, keys.admin, id);
      const payload = decodePayload(await open(keys.priv, keys.pub, r.sealed, `report:${mailbox}`));
      const replyKey = b64urlDecode(payload.reply);
      const thread = await Promise.all(r.thread.map(async (m) => {
        try {
          if (m.from === "org" && m.msg) return { from: m.from, at: m.at, text: bytesText(await symDecrypt(replyKey, m.msg, `reply:${id}`)) };
          if (m.from === "reporter" && m.sealed) return { from: m.from, at: m.at, text: bytesText(await open(keys.priv, keys.pub, m.sealed, `followup:${id}`)) };
        } catch {
          /* falls through */
        }
        return { from: m.from, at: m.at, text: null };
      }));
      setCur({ id, status: r.status, createdAt: r.createdAt, payload, thread });
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  const sendReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!keys || !cur || !reply.trim()) return;
    setBusy(true);
    try {
      await replyReport(mailbox, keys.admin, cur.id, await symEncrypt(b64urlDecode(cur.payload.reply), textBytes(reply.trim()), `reply:${cur.id}`));
      setReply("");
      await show(cur.id);
      await refresh(keys);
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async (s: Status) => {
    if (!keys || !cur) return;
    try {
      await setStatus(mailbox, keys.admin, cur.id, s);
      setCur({ ...cur, status: s });
      await refresh(keys);
    } catch (err) {
      setError(errorText(t, err));
    }
  };

  if (!keys) {
    return (
      <form className="v3-result rp" data-testid="report-inbox-lock" onSubmit={unlock}>
        <div className="v3-step">{t("report.inbox.title")}</div>
        <p className="v3-muted">{t("report.inbox.intro")}</p>
        {stored.length > 0 && (
          <label className="v3-field">
            <span>{t("report.inbox.stored")}</span>
            <select data-testid="report-key-select" value={file?.mailbox ?? ""} onChange={(e) => setFile(stored.find((s) => s.mailbox === e.target.value) ?? null)}>
              {stored.map((s) => <option key={s.mailbox} value={s.mailbox}>{s.mailbox.slice(0, 8)}…</option>)}
            </select>
          </label>
        )}
        <label className="v3-field">
          <span>{t("report.inbox.keyfile")}</span>
          <input type="file" accept="application/json,.json" data-testid="report-keyfile-input" onChange={async (e) => {
            const f = e.currentTarget.files?.[0];
            if (!f) return;
            const k = parseKeyFile(await f.text());
            if (k) { setFile(k); setError(null); } else setError(t("report.inbox.badFile"));
          }} />
        </label>
        <label className="v3-field">
          <span>{t("report.inbox.passphrase")}</span>
          <input type="password" data-testid="report-inbox-passphrase" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} />
        </label>
        {error && <div className="v3-warn" role="alert" data-testid="report-inbox-error">{error}</div>}
        <button type="submit" className="v3-btn" data-testid="report-inbox-unlock" disabled={busy || !file || !pass}>{busy ? t("report.working") : t("report.inbox.unlock")}</button>
        <p className="v3-footnote">{t("report.inbox.localNote")}</p>
      </form>
    );
  }

  return (
    <div className="v3-result rp rp-inbox" data-testid="report-inbox">
      <div className="v3-step">{t("report.inbox.title")}</div>
      <p className="rp-fp">{t("report.fingerprint")} <code>{fp}</code></p>
      {error && <div className="v3-warn" role="alert">{error}</div>}
      {!cur && (
        <>
          <button type="button" className="v3-btn-ghost" data-testid="report-refresh" onClick={() => void refresh(keys)}>{t("report.inbox.refresh")}</button>
          {list.length === 0 ? <p className="v3-muted" data-testid="report-empty">{t("report.inbox.empty")}</p> : (
            <ul className="rp-reports" data-testid="report-list">
              {list.map((r) => (
                <li key={r.id}>
                  <button type="button" className="rp-report-row" data-testid="report-row" onClick={() => void show(r.id)}>
                    <span>{fmtDate(r.createdAt)}</span>
                    <StatusBadge status={r.status} />
                    <small>{t("report.inbox.messages", { count: r.messages })}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {cur && (
        <div className="rp-open" data-testid="report-open">
          <button type="button" className="pz-link" onClick={() => setCur(null)}>← {t("report.inbox.back")}</button>
          <p className="v3-muted">{fmtDate(cur.createdAt)} <StatusBadge status={cur.status} /></p>
          <div className="rp-statuses" role="group" aria-label={t("report.inbox.setStatus")}>
            {STATUSES.map((s) => (
              <button key={s} type="button" aria-pressed={cur.status === s} className={cur.status === s ? "on" : ""} data-testid={`report-set-${s}`} onClick={() => void changeStatus(s)}>{t(`report.status.${s}`)}</button>
            ))}
          </div>
          <blockquote className="rp-text" data-testid="report-body">{cur.payload.text}</blockquote>
          {cur.payload.files.length > 0 && (
            <ul className="rp-metas">
              {cur.payload.files.map((f, i) => (
                <li key={i} className="rp-attach">
                  <button type="button" className="v3-copy-btn" data-testid="report-attachment" onClick={() => saveFile(f.name, f.data.slice().buffer as ArrayBuffer, f.type)}>⬇ {f.name}</button>
                  <ul><MetaLine meta={f.meta} name="" /></ul>
                </li>
              ))}
            </ul>
          )}
          <ol className="rp-thread">
            {cur.thread.map((m, i) => (
              <li key={i} className={`rp-msg rp-msg--${m.from}`} data-testid={`inbox-msg-${m.from}`}>
                <small>{m.from === "org" ? t("report.inbox.you") : t("report.inbox.reporter")} · {fmtDate(m.at)}</small>
                <p>{m.text ?? t("report.follow.undecryptable")}</p>
              </li>
            ))}
          </ol>
          <form onSubmit={sendReply}>
            <label className="v3-field">
              <span>{t("report.inbox.reply")}</span>
              <textarea data-testid="report-reply-text" rows={4} value={reply} onChange={(e) => setReply(e.target.value)} />
            </label>
            <button type="submit" className="v3-btn" data-testid="report-reply-send" disabled={busy || !reply.trim()}>{t("report.inbox.send")}</button>
          </form>
        </div>
      )}
      <button type="button" className="v3-btn-ghost" onClick={() => { setKeys(null); setCur(null); setList([]); }}>{t("report.inbox.lock")}</button>
    </div>
  );
}
