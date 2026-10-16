/**
 * Single-page shell. Home shows the three services (direct transfer,
 * Dropzone, Secrets Vault), each with three benefits; every flow then renders
 * in the same shell (header, card, legal footer).
 */
import { Carousel } from "./Carousel";
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
import DropOwnerPanel from "../p2p/dropzone/DropOwnerPanel";
import DropContributorPanel from "../p2p/dropzone/DropContributorPanel";
import VaultCreatePanel from "../vault/VaultCreatePanel";
import VaultRevealPanel from "../vault/VaultRevealPanel";
import { serviceRoute } from "./routes";
import { unloadGuardActive } from "../p2p/unloadGuard";
import "./home.css";

function Logo() {
  return (
    <svg width="40" height="40" viewBox="0 0 32 32" aria-hidden="true" className="pz-logo">
      <defs>
        <linearGradient id="fy-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--fy-accent)" />
          <stop offset="1" stopColor="var(--fy-accent-2)" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#fy-logo)" />
      <ellipse cx="14.5" cy="17" rx="5.2" ry="4.2" transform="rotate(-8 14.5 17)" fill="white" />
      <circle cx="21" cy="12.8" r="3.4" fill="white" />
      <path d="M24 12.5 L27.5 13.8 L24 14.8 Z" fill="#fbbf24" />
      <circle cx="22.3" cy="12.2" r="1.1" fill="#0f172a" />
      <path d="M9 14 Q6 8 11 7.5 Q15 9 14 14" fill="rgba(255,255,255,.75)" />
      <rect x="11.5" y="17.5" width="3.2" height="2.8" rx="0.6" fill="#fbbf24" />
    </svg>
  );
}

type IconName = "send" | "inbox" | "key" | "check";
function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, JSX.Element> = {
    send: <path d="M12 16V4m0 0L7 9m5-5 5 5M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" />,
    inbox: <path d="M12 4v11m0 0-4-4m4 4 4-4M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />,
    key: <path d="M14.5 9.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Zm-1 2.5L20 18.5M17 15.5l2-2M15 13.5l2-2" />,
    check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  };
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function Benefits({ prefix }: { prefix: string }) {
  const { t } = useTranslation();
  return (
    <ul className="pz-benefits">
      {[1, 2, 3].map((n) => (
        <li key={n}>
          <span className="pz-check"><Icon name="check" /></span>
          <span>
            <strong>{t(`${prefix}.b${n}`)}</strong>
            <small>{t(`${prefix}.b${n}d`)}</small>
          </span>
        </li>
      ))}
    </ul>
  );
}

const CLI_DOCS_URL = "https://github.com/Geoking2104/Filenymous/tree/main/cli#readme";

function SoonCard({ id, emoji }: { id: string; emoji: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <article className={`pz-service pz-service--${id} is-soon`} aria-labelledby={`svc-${id}`} data-testid={`soon-${id}`}>
      <span className="pz-badge">{t("home.soon")}</span>
      <div className="pz-service-head">
        <span className="pz-service-icon" aria-hidden="true">{emoji}</span>
        <h2 id={`svc-${id}`}>{t(`home.${id}.title`)}</h2>
      </div>
      <p className="pz-service-lead">{t(`home.${id}.lead`)}</p>
      <Benefits prefix={`home.${id}`} />
      {open && <p className="pz-teaser" id={`teaser-${id}`}>{t(`home.${id}.teaser`)}</p>}
      <button type="button" className="pz-btn-ghost pz-btn-block" aria-expanded={open} aria-controls={`teaser-${id}`} onClick={() => setOpen((o) => !o)}>
        {open ? t("home.teaserClose") : t("home.teaser")}
      </button>
    </article>
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

export default function HomeApp({ hash }: { hash: string }) {
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
    // In-app navigation bypasses beforeunload: ask the same question ourselves.
    if (unloadGuardActive() && !window.confirm(t("home.leaveConfirm"))) return;
    setSending(null);
    setPicked([]);
    setPassword("");
    if (location.hash) {
      history.replaceState(null, "", location.pathname + location.search);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }
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
  const route = serviceRoute(hash);
  const total = picked.reduce((n, f) => n + f.size, 0);

  let body: JSX.Element;
  if (route === "drop-contrib") {
    body = <DropContributorPanel hash={hash} />;
  } else if (route === "drop-owner") {
    body = <DropOwnerPanel hash={hash} />;
  } else if (route === "secret-reveal") {
    body = <VaultRevealPanel hash={hash} />;
  } else if (route === "secret-new") {
    body = <VaultCreatePanel />;
  } else if (receiving) {
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
        <section className="pz-hero">
          <h1>{t("home.title")}</h1>
          <p>{t("home.subtitle")}</p>
        </section>
        <Carousel label={t("home.carousel.label")}>
          <article className="pz-service pz-service--send" aria-labelledby="svc-send">
            <div className="pz-service-head">
              <span className="pz-service-icon"><Icon name="send" /></span>
              <h2 id="svc-send">{t("home.send.title")}</h2>
            </div>
            <p className="pz-service-lead">{t("home.send.lead")}</p>
            <Benefits prefix="home.send" />
            <label
              className={`pz-drop${drag ? " is-drag" : ""}`}
              data-testid="dropzone"
              tabIndex={0}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), input.current?.click())}
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
          </article>
          <article className="pz-service pz-service--drop" aria-labelledby="svc-drop">
            <div className="pz-service-head">
              <span className="pz-service-icon"><Icon name="inbox" /></span>
              <h2 id="svc-drop">{t("home.drop.title")}</h2>
            </div>
            <p className="pz-service-lead">{t("home.drop.lead")}</p>
            <Benefits prefix="home.drop" />
            <a className="pz-btn pz-btn-block" href="#drop-new" data-testid="dropzone-entry">{t("home.drop.cta")}</a>
          </article>
          <article className="pz-service pz-service--secret" aria-labelledby="svc-secret">
            <div className="pz-service-head">
              <span className="pz-service-icon"><Icon name="key" /></span>
              <h2 id="svc-secret">{t("home.secret.title")}</h2>
            </div>
            <p className="pz-service-lead">{t("home.secret.lead")}</p>
            <Benefits prefix="home.secret" />
            <a className="pz-btn pz-btn-block" href="#secret-new" data-testid="vault-entry">{t("home.secret.cta")}</a>
          </article>
          <SoonCard id="whistle" emoji="🛡️" />
          <article className="pz-service pz-service--cli" aria-labelledby="svc-cli">
            <span className="pz-badge pz-badge--new">{t("home.badgeNew")}</span>
            <div className="pz-service-head">
              <span className="pz-service-icon" aria-hidden="true">🤖</span>
              <h2 id="svc-cli">{t("home.cli.title")}</h2>
            </div>
            <p className="pz-service-lead">{t("home.cli.lead")}</p>
            <Benefits prefix="home.cli" />
            <a className="pz-btn pz-btn-block" href={CLI_DOCS_URL} target="_blank" rel="noopener noreferrer" data-testid="cli-docs">{t("home.cli.cta")}</a>
          </article>
          <article className="pz-service pz-service--pro" aria-labelledby="svc-pro">
            <span className="pz-badge pz-badge--pro">{t("home.badgePro")}</span>
            <div className="pz-service-head">
              <span className="pz-service-icon" aria-hidden="true">💼</span>
              <h2 id="svc-pro">{t("home.pro.title")}</h2>
            </div>
            <p className="pz-service-lead">{t("home.pro.lead")}</p>
            <Benefits prefix="home.pro" />
            <a className="pz-btn pz-btn-block" href="#drop-new" data-testid="pro-entry">{t("home.pro.cta")}</a>
          </article>
          <SoonCard id="stream" emoji="🎥" />
        </Carousel>
        <form
          className="pz-code v3-receive-row"
          onSubmit={(e) => {
            e.preventDefault();
            openCode();
          }}
        >
          <span className="pz-code-label">{t("home.codeLabel")}</span>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t("home.codePlaceholder")} aria-label={t("pz.codeLabel")} autoComplete="off" />
          <button type="submit" className="pz-btn-ghost">{t("pz.codeOpen")}</button>
        </form>
        {err && <p className="pz-err" role="alert">{err}</p>}
      </>
    );
  }

  const isHome = route === "home" && !receiving && !sending && picked.length === 0;

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
      <main className={`pz-main${isHome ? " is-wide" : ""}`} key={isHome ? "home" : route}>
        {!isHome && !sending && (
          <a className="pz-back" href={location.pathname} onClick={(e) => { e.preventDefault(); reset(); }} data-testid="back-home">
            ← {t("home.back")}
          </a>
        )}
        {body}
      </main>
      <LegalFooter />
    </div>
  );
}
