import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import { p2pSupported } from "../config";
import { formatBytes } from "../../ux-v3/types";
import { buildDropLink, buildOwnerLink, cleanProjectName, createDrop, isExpired, parseOwnerLink, type OwnerDropParams } from "./link";
import { DropOwner, type OwnerState } from "./owner";

interface Props {
  hash: string;
}

const EXPIRY_CHOICES: Array<{ key: string; ms: number }> = [
  { key: "none", ms: 0 },
  { key: "h1", ms: 3600_000 },
  { key: "d1", ms: 24 * 3600_000 },
  { key: "d7", ms: 7 * 24 * 3600_000 },
  { key: "d30", ms: 30 * 24 * 3600_000 },
];

function baseUrl(): string {
  return `${location.origin}${location.pathname}`;
}

/** `#drop-new` (creation form) and `#drop-owner:...` (live owner view, resumable after reload). */
export default function DropOwnerPanel({ hash }: Props) {
  const { t } = useTranslation();
  const [params, setParams] = useState<OwnerDropParams | null>(null);
  const [password, setPassword] = useState<string | undefined>(undefined);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    if (hash === "#drop-new") return;
    let alive = true;
    void parseOwnerLink(hash).then((p) => {
      if (!alive) return;
      if (p) setParams(p);
      else setInvalid(true);
    });
    return () => {
      alive = false;
    };
  }, [hash]);

  if (!p2pSupported()) return <div className="v3-warn">{t("p2p.unsupported")}</div>;
  if (invalid) return <div className="v3-warn">{t("dropzone.invalidLink")}</div>;
  if (!params) {
    if (hash !== "#drop-new") return null;
    return (
      <CreateForm
        onCreate={(p, pw) => {
          history.replaceState(null, "", buildOwnerLink(baseUrl(), p));
          setPassword(pw);
          setParams(p);
        }}
      />
    );
  }
  if (params.password && password === undefined) return <PasswordPrompt onSubmit={setPassword} />;
  return <OwnerView params={params} password={password} />;
}

function CreateForm({ onCreate }: { onCreate: (p: OwnerDropParams, password?: string) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("d1");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const ms = EXPIRY_CHOICES.find((c) => c.key === expiry)?.ms ?? 0;
    const p = await createDrop({ name: cleanProjectName(name), password: pw.length > 0, ...(ms ? { expiresAt: Date.now() + ms } : {}) });
    onCreate(p, pw || undefined);
  };

  return (
    <form className="v3-result" data-testid="drop-create" onSubmit={submit}>
      <div className="v3-step">{t("dropzone.createTitle")}</div>
      <p className="v3-muted">{t("dropzone.createIntro")}</p>
      <label className="v3-field">
        <span>{t("dropzone.projectName")}</span>
        <input data-testid="drop-name" value={name} maxLength={80} placeholder={t("dropzone.projectNamePlaceholder")} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="v3-field">
        <span>{t("dropzone.expiry")}</span>
        <select data-testid="drop-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
          {EXPIRY_CHOICES.map((c) => (
            <option key={c.key} value={c.key}>
              {t(`dropzone.expiryChoice.${c.key}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="v3-field">
        <span>{t("dropzone.passwordOptional")}</span>
        <input data-testid="drop-password" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </label>
      <button type="submit" className="v3-btn" data-testid="drop-create-submit" disabled={busy}>
        {t("dropzone.createButton")}
      </button>
    </form>
  );
}

export function PasswordPrompt({ onSubmit, error }: { onSubmit: (pw: string) => void; error?: boolean }) {
  const { t } = useTranslation();
  const [pw, setPw] = useState("");
  return (
    <form
      className="v3-result"
      data-testid="drop-password-gate"
      onSubmit={(e) => {
        e.preventDefault();
        if (pw) onSubmit(pw);
      }}
    >
      <div className="v3-step">{t("dropzone.passwordRequired")}</div>
      {error && <div className="v3-warn" role="alert">{t("dropzone.badPassword")}</div>}
      <input data-testid="drop-password-input" type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
      <button type="submit" className="v3-btn" data-testid="drop-password-submit">
        {t("dropzone.passwordContinue")}
      </button>
    </form>
  );
}

function OwnerView({ params, password }: { params: OwnerDropParams; password?: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<OwnerState>({ status: "starting", contributions: [], active: 0 });
  const [copied, setCopied] = useState(false);
  const ownerRef = useRef<DropOwner | null>(null);
  const link = useMemo(() => buildDropLink(baseUrl(), params), [params]);

  useEffect(() => {
    const o = new DropOwner(params, password, setState);
    ownerRef.current = o;
    void o.start();
    return () => o.stop();
  }, [params, password]);

  // Anti tab-close: DropOwner holds one guard per in-flight contribution, until
  // the contributor acknowledged the receipt (remote side fully completed).

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  const statusText = (() => {
    switch (state.status) {
      case "starting":
        return t("dropzone.ownerStarting");
      case "online":
        return state.active > 0 ? t("dropzone.ownerReceiving", { count: state.active }) : t("dropzone.ownerWaiting");
      case "reconnecting":
        return t("p2p.reconnecting");
      case "expired":
        return t("dropzone.expired");
      case "error":
        return t("p2p.errorSignal", { message: state.error ?? "" });
      case "stopped":
        return t("dropzone.stopped");
      default:
        return "";
    }
  })();

  return (
    <div className="v3-result" data-testid="drop-owner-panel">
      <div className="v3-step">{params.name ? t("dropzone.ownerTitleNamed", { name: params.name }) : t("dropzone.ownerTitle")}</div>
      <div className="v3-warn" role="alert" data-testid="drop-keep-open" style={{ marginBottom: ".8rem" }}>
        ⚠ {t("dropzone.keepTabOpen")}
      </div>
      <div className="v3-qr-wrap">
        <div className="v3-qr">
          <QRCodeSVG value={link} size={180} level="M" marginSize={2} bgColor="#ffffff" fgColor="#0f172a" title={t("dropzone.qrTitle")} />
        </div>
      </div>
      <div className="v3-link-row">
        <input readOnly data-testid="drop-link" value={link} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="v3-copy-btn" onClick={copy}>
          {copied ? `✓ ${t("common.copied")}` : t("common.copy")}
        </button>
      </div>
      <p className="v3-muted" style={{ fontSize: ".75rem" }}>
        {params.expiresAt ? t("dropzone.expiresAt", { date: new Date(params.expiresAt).toLocaleString() }) : t("dropzone.noExpiry")}
        {params.password ? ` · ${t("dropzone.passwordProtected")}` : ""}
      </p>
      <div className="v3-status" data-testid="drop-owner-status" data-status={state.status} data-active={state.active} style={{ margin: ".6rem 0" }}>
        <span className="v3-pulse" />
        {statusText}
      </div>
      {state.contributions.length > 0 && (
        <ul className="v3-muted" data-testid="drop-contributions" style={{ fontSize: ".8rem", textAlign: "left", paddingLeft: "1.1rem" }}>
          {state.contributions.map((c) => {
            const pct = c.totalBytes ? Math.min(100, Math.round((c.receivedBytes / c.totalBytes) * 100)) : 0;
            return (
              <li key={c.id} data-testid="drop-contribution" data-status={c.status}>
                {t(`dropzone.contribution.${c.status}`)} · {c.files.map((f) => f.name).join(", ") || "…"} · {formatBytes(c.totalBytes)}
                {c.status === "receiving" && <progress max={100} value={pct} style={{ width: "100%" }} aria-label={t("p2p.progress")} />}
              </li>
            );
          })}
        </ul>
      )}
      <p className="v3-footnote">{t("dropzone.ownerPrivateLink")}</p>
      <p className="v3-footnote">{t("dropzone.securityNote")}</p>
      {!isExpired(params) && state.status !== "stopped" && (
        <button type="button" className="v3-btn-ghost" data-testid="drop-stop" onClick={() => ownerRef.current?.stop()}>
          {t("dropzone.stop")}
        </button>
      )}
    </div>
  );
}
