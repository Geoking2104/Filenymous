import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { openSecret, parseSecretLink, revealToken } from "./crypto";
import { VaultError, getSecretMeta, revealSecret, vaultBase, type SecretMeta } from "./api";

interface Props {
  hash: string;
}

type View =
  | { kind: "loading" }
  | { kind: "ready"; meta: SecretMeta }
  | { kind: "gone" }
  | { kind: "invalid" }
  | { kind: "revealed"; text: string; burned: boolean }
  | { kind: "error"; message: string };

/**
 * Tightens the page while a secret is on screen: no plugins, no <base>, no
 * form posts, network limited to this origin and the Vault API, no referrer.
 * (frame-ancestors can't be set from a meta tag: see docs/DEPLOYMENT.md.)
 */
function useStrictPagePolicy() {
  useEffect(() => {
    let apiOrigin = "";
    try {
      apiOrigin = new URL(vaultBase()).origin;
    } catch {
      /* relative or invalid: 'self' only */
    }
    const csp = document.createElement("meta");
    csp.httpEquiv = "Content-Security-Policy";
    csp.content = `object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'self' ${apiOrigin}`.trim();
    const ref = document.createElement("meta");
    ref.name = "referrer";
    ref.content = "no-referrer";
    document.head.append(csp, ref);
    return () => ref.remove(); // a CSP, once applied, stays for the page's lifetime
  }, []);
}

/** `#s:<id>/<key>`: explicit "Afficher le secret" click before the burning read. */
export default function VaultRevealPanel({ hash }: Props) {
  const { t } = useTranslation();
  useStrictPagePolicy();
  const parsed = parseSecretLink(hash);
  const [view, setView] = useState<View>({ kind: "loading" });
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [pwError, setPwError] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!parsed) {
      setView({ kind: "invalid" });
      return;
    }
    let alive = true;
    getSecretMeta(parsed.id)
      .then((meta) => alive && setView(parsed.key ? { kind: "ready", meta } : { kind: "invalid" }))
      .catch((e) => alive && setView(e instanceof VaultError && e.code === "gone" ? { kind: "gone" } : { kind: "error", message: t("vault.error.network") }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash]);

  const reveal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (view.kind !== "ready" || !parsed?.key) return;
    setBusy(true);
    setPwError(false);
    try {
      const { token, encKey } = await revealToken(parsed.key, view.meta.pw ? password : undefined, view.meta.salt);
      const data = await revealSecret(parsed.id, token);
      const text = await openSecret(encKey, data.ct, data.iv);
      // Drop the key from the address bar and history entry.
      history.replaceState(null, "", `${location.pathname}${location.search}#s:${parsed.id}`);
      setView({ kind: "revealed", text, burned: data.burned });
    } catch (err) {
      if (err instanceof VaultError && err.code === "denied") {
        if (view.meta.pw) setPwError(true);
        else setView({ kind: "invalid" });
      } else if (err instanceof VaultError && err.code === "gone") setView({ kind: "gone" });
      else if (err instanceof VaultError) setView({ kind: "error", message: t(`vault.error.${err.code}`) });
      else setView({ kind: "invalid" });
    } finally {
      setBusy(false);
    }
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="v3-result" data-testid="vault-reveal" data-state={view.kind}>
      <div className="v3-step">{t("vault.revealTitle")}</div>
      {view.kind === "loading" && <p className="v3-muted">{t("vault.loading")}</p>}
      {view.kind === "gone" && (
        <div className="v3-warn" role="alert" data-testid="vault-gone">
          {t("vault.gone")}
        </div>
      )}
      {view.kind === "invalid" && <div className="v3-warn" role="alert">{t("vault.invalid")}</div>}
      {view.kind === "error" && <div className="v3-warn" role="alert">{view.message}</div>}
      {view.kind === "ready" && (
        <form onSubmit={reveal}>
          <p className="v3-muted">{view.meta.reads === 1 ? t("vault.revealOnceWarning") : t("vault.revealTtlInfo", { date: new Date(view.meta.expiresAt).toLocaleString() })}</p>
          {view.meta.pw && (
            <label className="v3-field">
              <span>{t("vault.passwordRequired")}</span>
              <input type="password" data-testid="vault-reveal-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
          )}
          {pwError && (
            <div className="v3-warn" role="alert" data-testid="vault-bad-password">
              {t("vault.badPassword")}
            </div>
          )}
          <button type="submit" className="v3-btn" data-testid="vault-show" disabled={busy || (view.meta.pw && !password)}>
            {t("vault.show")}
          </button>
        </form>
      )}
      {view.kind === "revealed" && (
        <>
          <pre
            data-testid="vault-secret"
            style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", padding: "1rem", border: "1px solid currentColor", borderRadius: 8, userSelect: "all", maxHeight: "50vh", overflow: "auto", textAlign: "left" }}
          >
            {view.text}
          </pre>
          <button type="button" className="v3-copy-btn" data-testid="vault-copy" onClick={() => copy(view.text)}>
            {copied ? `✓ ${t("common.copied")}` : t("vault.copy")}
          </button>
          <p className="v3-muted">{view.burned ? t("vault.burned") : t("vault.notBurned")}</p>
        </>
      )}
      <p className="v3-footnote">{t("vault.securityNote")}</p>
    </div>
  );
}
