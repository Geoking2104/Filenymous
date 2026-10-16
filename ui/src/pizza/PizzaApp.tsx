/**
 * Single-page, file.pizza-style shell: drop a file → link + QR → the
 * recipient opens it and downloads. Minimal header, legal-only footer.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import P2PSendPanel from "../p2p/P2PSendPanel";
import P2PReceivePanel from "../p2p/P2PReceivePanel";
import { isP2PHash, parseShareInput } from "../p2p/protocol";
import { p2pSupported } from "../p2p/config";
import { formatBytes } from "../ux-v3/types";
import type { AppLanguage } from "../i18n";
import LegalFooter from "./LegalFooter";
import { openTerms } from "./TermsModal";
import "../ux-v3/styles/ux-v3.css";
import "./pizza.css";

function Logo() {
  return (
    <svg width="40" height="40" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="15" fill="#0f172a" />
      <ellipse cx="14.5" cy="17" rx="5.2" ry="4.2" transform="rotate(-8 14.5 17)" fill="white" />
      <circle cx="21" cy="12.8" r="3.4" fill="white" />
      <path d="M24 12.5 L27.5 13.8 L24 14.8 Z" fill="#f59e0b" />
      <circle cx="22.3" cy="12.2" r="1.1" fill="#0f172a" />
      <path d="M9 14 Q6 8 11 7.5 Q15 9 14 14" fill="#22d3ee" />
      <rect x="11.5" y="17.5" width="3.2" height="2.8" rx="0.6" fill="#fbbf24" />
      <path d="M9 19.5 L5 21.5 L6 23 L9.5 21.8 Z" fill="white" />
    </svg>
  );
}

function LangSwitch() {
  const { t, i18n } = useTranslation();
  const lng = (i18n.resolvedLanguage?.startsWith("en") ? "en" : "fr") as AppLanguage;
  return (
    <div className="pz-lang" role="group" aria-label={t("pz.language")}>
      {(["fr", "en"] as const).map((l) => (
        <button key={l} type="button" aria-pressed={lng === l} className={lng === l ? "on" : ""} onClick={() => void i18n.changeLanguage(l)}>
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

export default function PizzaApp({ hash }: { hash: string }) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<File[]>([]);
  const [sending, setSending] = useState<File[] | null>(null);
  const [drag, setDrag] = useState(false);
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const more = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState("");

  useEffect(() => {
    document.title = t("pz.docTitle");
  }, [t]);

  const add = useCallback((list: FileList | null) => {
    if (!list || list.length === 0) return;
    setPicked(Array.from(list));
    setErr("");
  }, []);

  const addMore = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setPicked((prev) => [...prev, ...Array.from(list)]);
  };

  const reset = () => {
    setSending(null);
    setPicked([]);
    setPassword("");
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  };

  const openCode = () => {
    const parsed = parseShareInput(code.includes("#") ? code.split("#").pop()! : code);
    if (!parsed) {
      setErr(t("pz.badCode"));
      return;
    }
    window.location.hash = `p2p:${parsed.code}${parsed.secret ? `/${parsed.secret}` : ""}`;
  };

  const receiving = isP2PHash(hash);
  const total = picked.reduce((n, f) => n + f.size, 0);

  let body: JSX.Element;
  if (receiving) {
    body = <P2PReceivePanel hash={hash} />;
  } else if (sending) {
    body = <P2PSendPanel files={sending} password={password} onStop={reset} />;
  } else if (picked.length > 0) {
    body = (
      <div className="pz-card" data-testid="review-step">
        <h2 className="pz-h2">
          {t("pw.reviewTitle", { count: picked.length })}{" "}
          <button type="button" className="pz-link" data-testid="add-files" onClick={() => more.current?.click()}>
            {t("pw.addFiles")}
          </button>
        </h2>
        <input ref={more} type="file" multiple hidden data-testid="add-files-input" onChange={(e) => { addMore(e.currentTarget.files); e.currentTarget.value = ""; }} />
        <ul className="pz-files" data-testid="review-files">
          {picked.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              <span className="pz-fmeta">
                <span className="pz-fname">{f.name}</span>
                <span className="pz-fmime">{f.type || t("pw.unknownType")}</span>
              </span>
              <span className="pz-fsize">{formatBytes(f.size)}</span>
              <button type="button" className="pz-remove" aria-label={t("pw.remove", { name: f.name })} title={t("pw.remove", { name: f.name })} onClick={() => setPicked(picked.filter((_, k) => k !== i))}>
                ✕
              </button>
            </li>
          ))}
        </ul>
        {picked.length > 1 && <p className="pz-muted">{t("pz.totalSize", { count: picked.length, size: formatBytes(total) })}</p>}
        <div className="pz-pw">
          <label htmlFor="pz-password">
            {t("pw.label")}{" "}
            <span className="pz-info" tabIndex={0} role="img" aria-label={t("pw.info")} title={t("pw.info")} aria-describedby="pz-pw-info">ⓘ</span>
          </label>
          <input id="pz-password" type="password" autoComplete="new-password" data-testid="send-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <span id="pz-pw-info" className="pz-pw-hint">{t("pw.info")}</span>
        </div>
        {!p2pSupported() && <div className="v3-warn">{t("p2p.unsupported")}</div>}
        <div className="pz-actions">
          <button type="button" className="pz-btn-ghost" onClick={() => { setPicked([]); setPassword(""); }}>
            {t("common.cancel")}
          </button>
          <button type="button" className="pz-btn" data-testid="start-send" disabled={!p2pSupported()} onClick={() => setSending(picked)}>
            {t("pw.start")}
          </button>
        </div>
        <p className="pz-terms-note" data-testid="terms-note">
          {t("terms.notePrefix")}{" "}
          <button type="button" className="pz-link" onClick={openTerms}>{t("terms.noteLink")}</button>
        </p>
      </div>
    );
  } else {
    body = (
      <>
        <label
          className={`pz-drop${drag ? " is-drag" : ""}`}
          data-testid="dropzone"
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            add(e.dataTransfer.files);
          }}
        >
          <input ref={input} type="file" multiple hidden onChange={(e) => add(e.currentTarget.files)} />
          <span className="pz-drop-title">{t("pz.dropTitle")}</span>
          <span className="pz-drop-sub">{t("pz.dropSub")}</span>
        </label>
        <form
          className="pz-code v3-receive-row"
          onSubmit={(e) => {
            e.preventDefault();
            openCode();
          }}
        >
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t("pz.codePlaceholder")} aria-label={t("pz.codeLabel")} autoComplete="off" />
          <button type="submit" className="pz-btn-ghost">{t("pz.codeOpen")}</button>
        </form>
        {err && <p className="pz-err">{err}</p>}
      </>
    );
  }

  return (
    <div className="pz-app">
      <header className="pz-header">
        <a
          className="pz-brand"
          href={location.pathname}
          onClick={(e) => {
            if (sending) return; // let the beforeunload guard ask
            e.preventDefault();
            reset();
          }}
        >
          <Logo />
          <span>
            <strong>Filenymous</strong>
            <small>{t("pz.tagline")}</small>
          </span>
        </a>
        <LangSwitch />
      </header>
      <main className="pz-main">{body}</main>
      <LegalFooter />
    </div>
  );
}
