import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useLeaveGuard } from "../home/confirmLeave";
import { MAX_SECRET_BYTES, buildSecretLink, sealSecret } from "./crypto";
import { VaultError, createSecret } from "./api";

const ONE_READ_TTL_S = 7 * 24 * 3600;

function baseUrl(): string {
  return `${location.origin}${location.pathname}`;
}

/** `#secret-new`: paste a secret, choose 1 read (default) or a duration, optional password. */
export default function VaultCreatePanel() {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"once" | "ttl">("once");
  const [hours, setHours] = useState(24);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // A typed secret, or a link shown only once, would be lost by closing.
  useLeaveGuard(!!link || text.length > 0);
  const bytes = new TextEncoder().encode(text).byteLength;

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard denied: the link stays selectable */
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!text || bytes > MAX_SECRET_BYTES) return;
    setBusy(true);
    try {
      const sealed = await sealSecret(text, password || undefined);
      const ttl = mode === "once" ? ONE_READ_TTL_S : Math.max(1, Math.min(168, Math.round(hours))) * 3600;
      const { id } = await createSecret(sealed, { ttlSeconds: ttl, reads: mode === "once" ? 1 : 0 });
      const url = buildSecretLink(baseUrl(), id, sealed.key);
      setLink(url);
      setText("");
      setPassword("");
      void copy(url);
    } catch (err) {
      setError(err instanceof VaultError ? t(`vault.error.${err.code}`) : t("vault.error.network"));
    } finally {
      setBusy(false);
    }
  };

  if (link) {
    return (
      <div className="v3-result" data-testid="vault-created">
        <div className="v3-step">{t("vault.createdTitle")}</div>
        <div className="v3-link-row">
          <input readOnly data-testid="vault-link" value={link} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="v3-copy-btn" onClick={() => copy(link)}>
            {copied ? `✓ ${t("common.copied")}` : t("vault.copy")}
          </button>
        </div>
        <p className="v3-muted">{mode === "once" ? t("vault.createdOnce") : t("vault.createdTtl", { count: hours })}</p>
        <p className="v3-footnote">{t("vault.securityNote")}</p>
        <button type="button" className="v3-btn-ghost" onClick={() => setLink(null)}>
          {t("vault.another")}
        </button>
      </div>
    );
  }

  return (
    <form className="v3-result" data-testid="vault-create" onSubmit={submit}>
      <div className="v3-step">{t("vault.createTitle")}</div>
      <p className="v3-muted">{t("vault.createIntro")}</p>
      <textarea
        data-testid="vault-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        spellCheck={false}
        autoComplete="off"
        placeholder={t("vault.placeholder")}
        style={{ width: "100%", fontFamily: "monospace" }}
      />
      {bytes > MAX_SECRET_BYTES && <div className="v3-warn" role="alert">{t("vault.error.too-large")}</div>}
      <fieldset style={{ border: 0, padding: 0, margin: ".6rem 0" }}>
        <label>
          <input type="radio" name="vault-mode" data-testid="vault-mode-once" checked={mode === "once"} onChange={() => setMode("once")} /> {t("vault.modeOnce")}
        </label>{" "}
        <label>
          <input type="radio" name="vault-mode" data-testid="vault-mode-ttl" checked={mode === "ttl"} onChange={() => setMode("ttl")} /> {t("vault.modeTtl")}
        </label>
        {mode === "ttl" && (
          <label style={{ display: "block", marginTop: ".4rem" }}>
            {t("vault.hours")}{" "}
            <input type="number" min={1} max={168} data-testid="vault-hours" value={hours} onChange={(e) => setHours(Number(e.target.value) || 1)} style={{ width: "5rem" }} />
          </label>
        )}
      </fieldset>
      <label className="v3-field">
        <span>{t("vault.passwordOptional")}</span>
        <input type="password" data-testid="vault-password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error && <div className="v3-warn" role="alert">{error}</div>}
      <button type="submit" className="v3-btn" data-testid="vault-submit" disabled={busy || !text || bytes > MAX_SECRET_BYTES}>
        {t("vault.generate")}
      </button>
      <p className="v3-footnote">{t("vault.securityNote")}</p>
    </form>
  );
}
