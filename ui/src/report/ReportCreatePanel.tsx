import { useState } from "react";
import { useTranslation } from "react-i18next";
import { buildReportLink, exportKeyFile, fingerprint, generateMailboxKeys, sha256Hex, type KeyFile } from "./crypto";
import { b64urlDecode } from "../p2p/protocol";
import { createMailbox } from "./api";
import { CopyButton, KEY_STORAGE_PREFIX, errorText, saveFile } from "./common";

const MIN_PASSPHRASE = 12;

/** `#report-new`: the organisation creates its whistleblowing mailbox. */
export default function ReportCreatePanel() {
  const { t } = useTranslation();
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ link: string; fp: string; file: KeyFile; saved: boolean } | null>(null);

  const valid = pass.length >= MIN_PASSPHRASE && pass === pass2;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const keys = await generateMailboxKeys();
      const { id } = await createMailbox(keys.pub, await sha256Hex(b64urlDecode(keys.admin)));
      const file = await exportKeyFile(id, keys, pass);
      try {
        localStorage.setItem(KEY_STORAGE_PREFIX + id, JSON.stringify(file)); // encrypted; convenience only
      } catch {
        /* storage disabled: the key file is the only copy */
      }
      setDone({ link: buildReportLink(`${location.origin}${location.pathname}`, id, keys.pub), fp: await fingerprint(keys.pub), file, saved: false });
      setPass("");
      setPass2("");
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="v3-result rp" data-testid="report-created">
        <div className="v3-step">{t("report.create.doneTitle")}</div>
        <p className="v3-muted">{t("report.create.linkHelp")}</p>
        <div className="v3-link-row">
          <input readOnly data-testid="report-public-link" value={done.link} onFocus={(e) => e.currentTarget.select()} />
          <CopyButton value={done.link} />
        </div>
        <p className="rp-fp">{t("report.fingerprint")} <code data-testid="report-fingerprint">{done.fp}</code></p>
        <div className="rp-box rp-box--warn">
          <strong>{t("report.create.keyTitle")}</strong>
          <p>{t("report.create.keyHelp")}</p>
          <button type="button" className="v3-btn" data-testid="report-keyfile-download" onClick={() => {
            saveFile(`filenymous-signalement-${done.file.mailbox}.json`, JSON.stringify(done.file, null, 2), "application/json");
            setDone({ ...done, saved: true });
          }}>
            {t("report.create.download")}
          </button>
        </div>
        <a className={`v3-btn-ghost rp-block${done.saved ? "" : " is-muted"}`} href="#report-inbox" data-testid="report-open-inbox">{t("report.create.openInbox")}</a>
      </div>
    );
  }

  return (
    <form className="v3-result rp" data-testid="report-create" onSubmit={submit}>
      <div className="v3-step">{t("report.create.title")}</div>
      <p className="v3-muted">{t("report.create.intro")}</p>
      <ul className="rp-list">
        <li>{t("report.create.p1")}</li>
        <li>{t("report.create.p2")}</li>
        <li>{t("report.create.p3")}</li>
      </ul>
      <label className="v3-field">
        <span>{t("report.create.passphrase", { n: MIN_PASSPHRASE })}</span>
        <input type="password" data-testid="report-passphrase" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />
      </label>
      <label className="v3-field">
        <span>{t("report.create.passphrase2")}</span>
        <input type="password" data-testid="report-passphrase2" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} />
      </label>
      {pass2 && pass !== pass2 && <div className="v3-warn" role="alert">{t("report.create.mismatch")}</div>}
      {error && <div className="v3-warn" role="alert">{error}</div>}
      <button type="submit" className="v3-btn" data-testid="report-create-submit" disabled={busy || !valid}>
        {busy ? t("report.working") : t("report.create.submit")}
      </button>
      <p className="v3-footnote">{t("report.intent")}</p>
    </form>
  );
}
