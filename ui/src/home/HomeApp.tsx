/**
 * Single-page shell. Home shows the three services (direct transfer,
 * Dropzone, Sharewall, Secrets Vault…), each with three benefits; every flow then renders
 * in the same shell (header, card, legal footer).
 */
import { Carousel } from "./Carousel";
import { mediaKind } from "../p2p/media";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import P2PSendPanel from "../p2p/P2PSendPanel";
import P2PReceivePanel from "../p2p/P2PReceivePanel";
import { isP2PHash, parseShareInput, shareFragment } from "../p2p/protocol";
import { expiryFromChoice, localInputValue, type ExpiryChoice } from "../p2p/expiry";
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
import { LineIconSvg, SERVICES, ServiceIcon, serviceForScreen, type ServiceId } from "./services";
import ReportCreatePanel from "../report/ReportCreatePanel";
import ReportSubmitPanel from "../report/ReportSubmitPanel";
import ReportInboxPanel from "../report/ReportInboxPanel";
import ReportFollowPanel from "../report/ReportFollowPanel";
import "../report/report.css";
import { WallHostPanel, WallPeerPanel } from "../wall/WallPanel";
import { unloadGuardActive } from "../p2p/unloadGuard";
import "./home.css";
import { dragHasFiles, mergeFiles, removeFileAt, totalBytes } from "./files";

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

function Benefits({ prefix }: { prefix: string }) {
  const { t } = useTranslation();
  return (
    <ul className="pz-benefits">
      {[1, 2, 3].map((n) => (
        <li key={n}>
          <span className="pz-check"><LineIconSvg name="check" /></span>
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
  const [reviewDrag, setReviewDrag] = useState(false);
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const more = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState("");
  const [stream, setStream] = useState(false);
  const [expiryChoice, setExpiryChoice] = useState<ExpiryChoice>("none");
  const [expiryCustom, setExpiryCustom] = useState(() => localInputValue(Date.now() + 2 * 86_400_000));
  const [expires, setExpires] = useState<number | undefined>(undefined);
  const mediaInput = useRef<HTMLInputElement>(null);
  /** Card that opened the current screen, when several cards share a screen (Pro → Dropzone). */
  const [via, setVia] = useState<ServiceId | null>(null);
  const [rxStream, setRxStream] = useState(false);

  useEffect(() => {
    document.title = t("pz.docTitle");
  }, [t]);

  const add = useCallback((list: FileList | null) => {
    if (!list || list.length === 0) return;
    setPicked(mergeFiles([], list));
    setErr("");
  }, []);

  const addMore = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    // Copy now: the input's live FileList is emptied right after (value = "").
    const incoming = Array.from(list);
    setPicked((prev) => mergeFiles(prev, incoming));
  };

  const reset = () => {
    // In-app navigation bypasses beforeunload: ask the same question ourselves.
    if (unloadGuardActive() && !window.confirm(t("home.leaveConfirm"))) return;
    setSending(null);
    setPicked([]);
    setPassword("");
    setStream(false);
    setExpiryChoice("none");
    setExpires(undefined);
    setVia(null);
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
    window.location.hash = shareFragment(parsed);
  };

  const receiving = isP2PHash(hash);
  const route = serviceRoute(hash);
  const total = totalBytes(picked);

  let body: JSX.Element;
  if (route === "drop-contrib") {
    body = <DropContributorPanel hash={hash} />;
  } else if (route === "drop-owner") {
    body = <DropOwnerPanel hash={hash} />;
  } else if (route === "wall-host") {
    body = <WallHostPanel hash={hash} />;
  } else if (route === "wall-peer") {
    body = <WallPeerPanel hash={hash} />;
  } else if (route === "secret-reveal") {
    body = <VaultRevealPanel hash={hash} />;
  } else if (route === "secret-new") {
    body = <VaultCreatePanel />;
  } else if (route === "report-new") {
    body = <ReportCreatePanel />;
  } else if (route === "report-submit") {
    body = <ReportSubmitPanel hash={hash} />;
  } else if (route === "report-inbox") {
    body = <ReportInboxPanel />;
  } else if (route === "report-follow") {
    body = <ReportFollowPanel />;
  } else if (receiving) {
    body = <P2PReceivePanel hash={hash} onStreamable={setRxStream} />;
  } else if (sending) {
    body = <P2PSendPanel files={sending} password={password} stream={stream} expires={expires} onStop={reset} />;
  } else if (picked.length > 0) {
    body = (
      <div
        className={`pz-card pz-review${reviewDrag ? " is-drag" : ""}`}
        data-testid="review-step"
        onDragOver={(e) => {
          if (!dragHasFiles(e.dataTransfer)) return;
          e.preventDefault();
          setReviewDrag(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setReviewDrag(false);
        }}
        onDrop={(e) => {
          if (!dragHasFiles(e.dataTransfer)) return;
          e.preventDefault();
          setReviewDrag(false);
          addMore(e.dataTransfer.files);
        }}
      >
        <div className="pz-review-head">
          <h2 className="pz-h2">{t("pw.reviewTitle", { count: picked.length })}</h2>
          <button type="button" className="pz-btn-ghost pz-add-files" data-testid="add-files" onClick={() => more.current?.click()}>
            <span aria-hidden="true">＋</span> {t("pw.addFiles")}
          </button>
        </div>
        <p className="pz-files-summary" data-testid="files-summary" aria-live="polite">
          {t("pz.filesSummary", { count: picked.length, size: formatBytes(total) })}
        </p>
        <input ref={more} type="file" multiple hidden data-testid="add-files-input" onChange={(e) => { addMore(e.currentTarget.files); e.currentTarget.value = ""; }} />
        <ul className="pz-files" data-testid="review-files">
          {picked.map((f, i) => (
            <li key={`${f.name}-${f.size}-${f.lastModified}`}>
              <span className="pz-fmeta">
                <span className="pz-fname">{f.name}</span>
                <span className="pz-fmime">{f.type || t("pw.unknownType")}</span>
              </span>
              <span className="pz-fsize">{formatBytes(f.size)}</span>
              <button type="button" className="pz-remove" aria-label={t("pw.remove", { name: f.name })} title={t("pw.remove", { name: f.name })} onClick={() => setPicked(removeFileAt(picked, i))}>
                ✕
              </button>
            </li>
          ))}
        </ul>
        <p className="pz-review-drop-hint" aria-hidden="true">{reviewDrag ? t("pz.dropMoreActive") : t("pz.dropMore")}</p>
        {picked.some((f) => mediaKind(f.name, f.type)) && (
          <label className="pz-stream-opt">
            <input type="checkbox" data-testid="send-stream" checked={stream} onChange={(e) => setStream(e.target.checked)} />
            <span>
              <strong>🎥 {t("stream.senderOption")}</strong>
              <small>{t("stream.senderOptionHint")}</small>
            </span>
          </label>
        )}
        {stream ? (
          <fieldset className="pz-protect" data-testid="stream-protect">
            <legend>🔒 {t("protect.title")}</legend>
            <p className="pz-protect-lead">{t("protect.lead")}</p>
            <label htmlFor="pz-password">{t("protect.password")}</label>
            <input id="pz-password" type="password" autoComplete="new-password" data-testid="send-password" placeholder={t("protect.passwordPlaceholder")} value={password} onChange={(e) => setPassword(e.target.value)} />
            <span className="pz-pw-hint">{t("pw.info")}</span>
            <label htmlFor="pz-expiry">{t("protect.expiry")}</label>
            <div className="pz-expiry-choices" role="radiogroup" aria-label={t("protect.expiry")}>
              {(["none", "1h", "24h", "7d", "custom"] as const).map((c) => (
                <button key={c} type="button" role="radio" aria-checked={expiryChoice === c} className={expiryChoice === c ? "on" : ""} data-testid={`expiry-${c}`} onClick={() => setExpiryChoice(c)}>
                  {t(`protect.choice.${c}`)}
                </button>
              ))}
            </div>
            {expiryChoice === "custom" && (
              <input id="pz-expiry" type="datetime-local" data-testid="expiry-custom" value={expiryCustom} min={localInputValue(Date.now() + 60_000)} onChange={(e) => setExpiryCustom(e.target.value)} />
            )}
            {expiryChoice !== "none" && !expiryFromChoice(expiryChoice, expiryCustom) && <p className="pz-err" role="alert">{t("protect.badDate")}</p>}
          </fieldset>
        ) : (
          <div className="pz-pw">
          <label htmlFor="pz-password">
            {t("pw.label")}{" "}
            <span className="pz-info" tabIndex={0} role="img" aria-label={t("pw.info")} title={t("pw.info")} aria-describedby="pz-pw-info">ⓘ</span>
          </label>
          <input id="pz-password" type="password" autoComplete="new-password" data-testid="send-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <span id="pz-pw-info" className="pz-pw-hint">{t("pw.info")}</span>
        </div>
        )}

        {!p2pSupported() && <div className="v3-warn">{t("p2p.unsupported")}</div>}
        <div className="pz-actions">
          <button type="button" className="pz-btn-ghost" onClick={() => { setPicked([]); setPassword(""); setStream(false); setExpiryChoice("none"); }}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="pz-btn"
            data-testid="start-send"
            disabled={!p2pSupported() || (stream && expiryChoice !== "none" && !expiryFromChoice(expiryChoice, expiryCustom))}
            onClick={() => {
              // Durations count from now; tests may force a short expiry.
              const testS = Number((window as { __FILENYMOUS_TEST_EXPIRY_S__?: number }).__FILENYMOUS_TEST_EXPIRY_S__) || 0;
              setExpires(stream ? (testS ? Math.floor(Date.now() / 1000) + testS : expiryFromChoice(expiryChoice, expiryCustom)) : undefined);
              setSending(picked);
            }}
          >
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
          <article className="pz-service pz-service--send" data-service="send" aria-labelledby="svc-send">
            <div className="pz-service-head">
              <ServiceIcon service="send" />
              <h2 id="svc-send">{t("home.send.title")}</h2>
            </div>
            <p className="pz-service-lead">{t("home.send.lead")}</p>
            <Benefits prefix="home.send" />
            <p className="pz-drop-cue" data-testid="drop-cue">
              <span>{t("pz.dropCue")}</span>
              <svg className="pz-drop-arrow" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
                <path d="M12 4v14m0 0-5.5-5.5M12 18l5.5-5.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </p>
            <label
              className={`pz-drop${drag ? " is-drag" : ""}`}
              data-testid="dropzone"
              tabIndex={0}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), input.current?.click())}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                add(e.dataTransfer.files);
              }}
            >
              <input ref={input} type="file" multiple hidden onChange={(e) => add(e.currentTarget.files)} />
              <span className="pz-drop-title">{t("pz.dropTitle")}</span>
              <span className="pz-drop-btn" aria-hidden="true">＋ {t("pw.addFiles")}</span>
              <span className="pz-drop-sub">{t("pz.dropSub")}</span>
            </label>
          </article>
          <article className="pz-service pz-service--drop" data-service="drop" aria-labelledby="svc-drop">
            <div className="pz-service-head">
              <ServiceIcon service="drop" />
              <h2 id="svc-drop">{t("home.drop.title")}</h2>
            </div>
            <p className="pz-service-lead">{t("home.drop.lead")}</p>
            <Benefits prefix="home.drop" />
            <a className="pz-btn pz-btn-block" href="#drop-new" data-testid="dropzone-entry" onClick={() => setVia(null)}>{t("home.drop.cta")}</a>
          </article>
          <article className="pz-service pz-service--wall" data-service="wall" aria-labelledby="svc-wall" data-testid="wall-card">
            <span className="pz-badge pz-badge--new">{t("home.badgeNew")}</span>
            <div className="pz-service-head">
              <ServiceIcon service="wall" />
              <h2 id="svc-wall">{t("home.wall.title")}</h2>
            </div>
            <p className="pz-service-lead">{t("home.wall.lead")}</p>
            <Benefits prefix="home.wall" />
            <a className="pz-btn pz-btn-block" href="#wall-new" data-testid="wall-entry">{t("home.wall.cta")}</a>
          </article>
          <article className="pz-service pz-service--secret" data-service="secret" aria-labelledby="svc-secret">
            <div className="pz-service-head">
              <ServiceIcon service="secret" />
              <h2 id="svc-secret">{t("home.secret.title")}</h2>
            </div>
            <p className="pz-service-lead">{t("home.secret.lead")}</p>
            <Benefits prefix="home.secret" />
            <a className="pz-btn pz-btn-block" href="#secret-new" data-testid="vault-entry">{t("home.secret.cta")}</a>
          </article>
          <article className="pz-service pz-service--whistle" data-service="report" aria-labelledby="svc-whistle" data-testid="whistle-card">
            <span className="pz-badge pz-badge--new">{t("home.badgeNew")}</span>
            <div className="pz-service-head">
              <ServiceIcon service="report" />
              <h2 id="svc-whistle">{t("home.whistle.title")}</h2>
            </div>
            <p className="pz-service-lead">{t("home.whistle.lead")}</p>
            <Benefits prefix="home.whistle" />
            <p className="pz-teaser">{t("home.whistle.teaser")}</p>
            <a className="pz-btn pz-btn-block" href="#report-new" data-testid="report-entry">{t("home.whistle.cta")}</a>
            <a className="pz-link pz-service-sub" href="#report-follow" data-testid="report-follow-entry">{t("home.whistle.follow")}</a>
          </article>
          <article className="pz-service pz-service--cli" data-service="cli" aria-labelledby="svc-cli">
            <span className="pz-badge pz-badge--new">{t("home.badgeNew")}</span>
            <div className="pz-service-head">
              <ServiceIcon service="cli" />
              <h2 id="svc-cli">{t("home.cli.title")}</h2>
            </div>
            <p className="pz-service-lead">{t("home.cli.lead")}</p>
            <Benefits prefix="home.cli" />
            <a className="pz-btn pz-btn-block" href={CLI_DOCS_URL} target="_blank" rel="noopener noreferrer" data-testid="cli-docs">{t("home.cli.cta")}</a>
          </article>
          <article className="pz-service pz-service--pro" data-service="pro" aria-labelledby="svc-pro">
            <span className="pz-badge pz-badge--pro">{t("home.badgePro")}</span>
            <div className="pz-service-head">
              <ServiceIcon service="pro" />
              <h2 id="svc-pro">{t("home.pro.title")}</h2>
            </div>
            <p className="pz-service-lead">{t("home.pro.lead")}</p>
            <Benefits prefix="home.pro" />
            <a className="pz-btn pz-btn-block" href="#drop-new" data-testid="pro-entry" onClick={() => setVia("pro")}>{t("home.pro.cta")}</a>
          </article>
          <article className="pz-service pz-service--stream" data-service="stream" aria-labelledby="svc-stream">
            <span className="pz-badge pz-badge--new">{t("home.badgeNew")}</span>
            <div className="pz-service-head">
              <ServiceIcon service="stream" />
              <h2 id="svc-stream">{t("home.stream.title")}</h2>
            </div>
            <p className="pz-service-lead">{t("home.stream.lead")}</p>
            <Benefits prefix="home.stream" />
            <input ref={mediaInput} type="file" accept="video/*,audio/*" multiple hidden data-testid="stream-input" onChange={(e) => { if (e.currentTarget.files?.length) setStream(true); add(e.currentTarget.files); e.currentTarget.value = ""; }} />
            <button type="button" className="pz-btn pz-btn-block" data-testid="stream-entry" onClick={() => mediaInput.current?.click()}>{t("home.stream.cta")}</button>
          </article>
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
  const screenService = serviceForScreen(route, { receiving, stream: receiving ? rxStream : stream, via: route === "drop-owner" ? via : null });
  const screenKey = isHome ? "home" : `${route}:${receiving}:${!!sending}:${picked.length > 0}`;
  // A new screen starts at the top, so its header (icon + title) is visible
  // even when the card's button was tapped far down the home page (mobile).
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [screenKey]);

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
      <main className={`pz-main${isHome || route === "wall-host" || route === "wall-peer" ? " is-wide" : ""}`} key={isHome ? "home" : route}>
        {!isHome && !sending && (
          <a className="pz-back" href={location.pathname} onClick={(e) => { e.preventDefault(); reset(); }} data-testid="back-home">
            ← {t("home.back")}
          </a>
        )}
        {!isHome && (
          <div className="pz-screen-head" data-testid="service-head" data-service={screenService}>
            <ServiceIcon service={screenService} />
            <h1>{t(receiving && route === "home" && screenService === "send" ? "receive.title" : SERVICES[screenService].titleKey)}</h1>
          </div>
        )}
        {body}
      </main>
      <LegalFooter />
    </div>
  );
}
