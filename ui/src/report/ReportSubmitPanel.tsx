import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLeaveGuard } from "../home/confirmLeave";
import { b64urlEncode } from "../p2p/protocol";
import { deriveFollow, encodePayload, fingerprint, formatFollowKey, newFollowSecret, parseReportHash, seal, type ReportFile } from "./crypto";
import { stripMetadata } from "./metadata";
import { getMailbox, submitReport } from "./api";
import { CopyButton, MAX_FILES_BYTES, MetaLine, errorText } from "./common";

function ext(name: string): string {
  const m = name.match(/\.([A-Za-z0-9]{1,8})$/);
  return m ? `.${m[1].toLowerCase()}` : "";
}

/** `#report:<mailbox>/<pub>`: a reporter submits, sealed to the org's key. */
export default function ReportSubmitPanel({ hash }: { hash: string }) {
  const { t } = useTranslation();
  const target = parseReportHash(hash);
  const [state, setState] = useState<"loading" | "ready" | "gone" | "mismatch">("loading");
  const [fp, setFp] = useState("");
  const [text, setText] = useState("");
  const [files, setFiles] = useState<ReportFile[]>([]);
  const [rename, setRename] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [followKey, setFollowKey] = useState<string | null>(null);
  const [noted, setNoted] = useState(false);
  // An unsent report, or a follow-up key shown only once, would be lost.
  useLeaveGuard(followKey ? !noted : state === "ready" && (text.trim().length > 0 || files.length > 0));

  useEffect(() => {
    if (!target) return setState("gone");
    let live = true;
    void (async () => {
      try {
        const mb = await getMailbox(target.mailbox);
        if (!live) return;
        // The key in the link is authoritative: a server that swapped it is detected.
        if (mb.pub !== target.pub) return setState("mismatch");
        setFp(await fingerprint(target.pub));
        setState("ready");
      } catch {
        if (live) setState("gone");
      }
    })();
    return () => { live = false; };
  }, [target?.mailbox, target?.pub]);

  const pick = async (list: FileList | null) => {
    if (!list) return;
    const out: ReportFile[] = [];
    for (const f of Array.from(list)) {
      const { data, meta } = stripMetadata(new Uint8Array(await f.arrayBuffer()));
      out.push({ name: f.name, type: f.type || "application/octet-stream", size: data.length, meta, data });
    }
    setFiles((cur) => [...cur, ...out]);
  };
  const total = files.reduce((n, f) => n + f.data.length, 0);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!target || !text.trim() || total > MAX_FILES_BYTES) return;
    setBusy(true);
    setError(null);
    try {
      const secret = newFollowSecret();
      const keys = await deriveFollow(secret);
      const named = files.map((f, i) => (rename ? { ...f, name: `piece-${i + 1}${ext(f.name)}` } : f));
      const sealed = await seal(target.pub, encodePayload({ v: 1, text: text.trim(), reply: b64urlEncode(keys.reply), files: named }), `report:${target.mailbox}`);
      await submitReport(target.mailbox, keys.id, keys.auth, sealed);
      setFollowKey(formatFollowKey(secret));
      setText("");
      setFiles([]);
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  if (state === "loading") return <div className="v3-result rp"><p className="v3-muted">{t("report.working")}</p></div>;
  if (state !== "ready") {
    return (
      <div className="v3-result rp" data-testid="report-unavailable">
        <div className="v3-warn" role="alert">{t(state === "mismatch" ? "report.submit.mismatch" : "report.submit.gone")}</div>
      </div>
    );
  }

  if (followKey) {
    return (
      <div className="v3-result rp" data-testid="report-sent">
        <div className="v3-step">{t("report.submit.sentTitle")}</div>
        <p className="v3-muted">{t("report.submit.sentHelp")}</p>
        <div className="rp-key" data-testid="report-follow-key">{followKey}</div>
        <CopyButton value={followKey} />
        <div className="rp-box rp-box--warn"><p>{t("report.submit.keyWarn")}</p></div>
        <label className="rp-check">
          <input type="checkbox" data-testid="report-key-noted" checked={noted} onChange={(e) => setNoted(e.target.checked)} /> {t("report.submit.noted")}
        </label>
        {noted && <a className="v3-btn" href="#report-follow" data-testid="report-go-follow" onClick={() => setFollowKey(null)}>{t("report.submit.follow")}</a>}
      </div>
    );
  }

  return (
    <form className="v3-result rp" data-testid="report-submit" onSubmit={submit}>
      <div className="v3-step">{t("report.submit.title")}</div>
      <div className="rp-box" data-testid="report-guidance">
        <strong>{t("report.guide.title")}</strong>
        <ul className="rp-list">
          <li>{t("report.guide.device")}</li>
          <li>{t("report.guide.tor")}</li>
          <li>{t("report.guide.identity")}</li>
          <li>{t("report.guide.files")}</li>
        </ul>
      </div>
      <p className="rp-fp">{t("report.fingerprint")} <code data-testid="report-fingerprint">{fp}</code></p>
      <label className="v3-field">
        <span>{t("report.submit.message")}</span>
        <textarea data-testid="report-text" rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("report.submit.placeholder")} />
      </label>
      <label className="v3-field">
        <span>{t("report.submit.files")}</span>
        <input type="file" multiple data-testid="report-files" onChange={(e) => { void pick(e.currentTarget.files); e.currentTarget.value = ""; }} />
      </label>
      {files.length > 0 && (
        <ul className="rp-metas">
          {files.map((f, i) => <MetaLine key={i} meta={f.meta} name={f.name} />)}
        </ul>
      )}
      {total > MAX_FILES_BYTES && <div className="v3-warn" role="alert">{t("report.submit.tooBig")}</div>}
      <label className="rp-check">
        <input type="checkbox" data-testid="report-rename" checked={rename} onChange={(e) => setRename(e.target.checked)} /> {t("report.submit.rename")}
      </label>
      {error && <div className="v3-warn" role="alert">{error}</div>}
      <button type="submit" className="v3-btn" data-testid="report-send" disabled={busy || !text.trim() || total > MAX_FILES_BYTES}>
        {busy ? t("report.working") : t("report.submit.send")}
      </button>
      <p className="v3-footnote">{t("report.submit.footnote")}</p>
    </form>
  );
}
