/** Onboarding (create + recovery phrase + check) and unlock / recovery screens. */
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { SafeClient } from "./client";
import { useLeaveGuard } from "../home/confirmLeave";
import { createPasskey, passkeyPrfSupported, passkeySecret } from "./passkey";
import { MASTER_MIN_BITS, estimateBits } from "./strength";
import { StrengthMeter, errKey } from "./ui";
import { requestPersistence } from "./persist";
import type { VaultStatus } from "./types";

function randomPositions(n = 3, total = 24): number[] {
  const out = new Set<number>();
  const b = new Uint32Array(16);
  while (out.size < n) {
    crypto.getRandomValues(b);
    for (const x of b) if (out.size < n) out.add(x % total);
  }
  return [...out].sort((a, z) => a - z);
}

export function NewPasswordFields({ onValid, autoFocus }: { onValid: (pw: string | null) => void; autoFocus?: boolean }) {
  const { t } = useTranslation();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [show, setShow] = useState(false);
  const bits = estimateBits(pw);
  const strong = bits >= MASTER_MIN_BITS;
  const same = pw === pw2;
  useEffect(() => onValid(strong && same && pw.length > 0 ? pw : null), [pw, pw2, strong, same, onValid]);
  return (
    <>
      <label className="v3-field sw-field">
        <span>{t("safe.onb.password")}</span>
        <div className="cf-pw">
          <input type={show ? "text" : "password"} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" autoFocus={autoFocus} data-testid="cf-master" spellCheck={false} />
          <button type="button" className="cf-icon-btn" onClick={() => setShow((s) => !s)} aria-label={t(show ? "safe.hide" : "safe.show")}>
            {show ? "🙈" : "👁"}
          </button>
        </div>
      </label>
      <StrengthMeter value={pw} testId="cf-master-strength" />
      {pw && !strong && <p className="sw-small cf-warn-text">{t("safe.onb.tooWeak", { bits: MASTER_MIN_BITS })}</p>}
      <label className="v3-field sw-field">
        <span>{t("safe.onb.confirm")}</span>
        <input type={show ? "text" : "password"} value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" data-testid="cf-master2" spellCheck={false} />
      </label>
      {pw2 && !same && <p className="sw-small cf-warn-text">{t("safe.onb.mismatch")}</p>}
      <p className="sw-small">{t("safe.onb.passwordHint")}</p>
    </>
  );
}

/* ── Onboarding ── */

export function Onboarding({ client, onDone, onImport }: { client: SafeClient; onDone: () => void; onImport: () => void }) {
  const { t } = useTranslation();
  const [step, setStep] = useState<"intro" | "method" | "phrase" | "check">("intro");
  const [method, setMethod] = useState<"password" | "passkey">("password");
  const [prfOk, setPrfOk] = useState(false);
  const [pw, setPw] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [phrase, setPhrase] = useState<string[]>([]);
  const [shown, setShown] = useState<Set<number>>(new Set());
  const [ack, setAck] = useState(false);
  const positions = useMemo(() => randomPositions(), [phrase]);
  const [answers, setAnswers] = useState<string[]>(["", "", ""]);
  const [checkErr, setCheckErr] = useState(false);

  useEffect(() => {
    void passkeyPrfSupported().then(setPrfOk);
  }, []);
  // The phrase is shown only once: leaving before it is checked loses it.
  useLeaveGuard(step === "phrase" || step === "check", { detail: "safe.leavePhrase" });

  // Never keep the phrase on screen longer than needed.
  useEffect(() => () => setPhrase([]), []);

  const create = async (e?: FormEvent) => {
    e?.preventDefault();
    setErr("");
    setBusy(true);
    try {
      let res: { phrase: string };
      if (method === "passkey") {
        const pk = await createPasskey(t("safe.onb.passkeyLabel"));
        res = await client.create({ passkey: pk });
      } else {
        if (!pw) return;
        res = await client.create({ password: pw });
      }
      // Ask right away for persistent storage, so the browser does not evict the new vault.
      void requestPersistence();
      setPhrase(res.phrase.split(" "));
      setStep("phrase");
    } catch (ex) {
      setErr(t(errKey(ex)));
    } finally {
      setBusy(false);
    }
  };

  const check = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await client.checkPhrase(positions.map((pos, i) => ({ pos, word: answers[i] ?? "" })));
    if (!ok) return setCheckErr(true);
    setPhrase([]);
    onDone();
  };

  if (step === "intro")
    return (
      <div className="v3-result sw cf-onb" data-testid="cf-onboarding">
        <div className="cf-hero">
          <div className="cf-hero-icon" aria-hidden="true">🔐</div>
          <div>
            <div className="v3-step">{t("safe.onb.title")}</div>
            <p className="v3-muted">{t("safe.onb.lead")}</p>
          </div>
        </div>
        <ul className="cf-points">
          {["local", "zero", "p2p", "search"].map((k) => (
            <li key={k}>
              <strong>{t(`safe.onb.points.${k}.t`)}</strong>
              <span>{t(`safe.onb.points.${k}.d`)}</span>
            </li>
          ))}
        </ul>
        <p className="v3-warn cf-callout">{t("safe.onb.localWarn")}</p>
        <div className="cf-row cf-row-end">
          <button type="button" className="pz-btn pz-btn-ghost" onClick={onImport} data-testid="cf-import-entry">
            {t("safe.onb.import")}
          </button>
          <button type="button" className="pz-btn" onClick={() => setStep("method")} data-testid="cf-start">
            {t("safe.onb.start")}
          </button>
        </div>
      </div>
    );

  if (step === "method")
    return (
      <form className="v3-result sw cf-onb" data-testid="cf-method" onSubmit={create}>
        <div className="v3-step">{t("safe.onb.methodTitle")}</div>
        {prfOk && (
          <div className="cf-seg" role="radiogroup" aria-label={t("safe.onb.methodTitle")}>
            <button type="button" role="radio" aria-checked={method === "password"} className={method === "password" ? "is-on" : ""} onClick={() => setMethod("password")}>
              {t("safe.onb.usePassword")}
            </button>
            <button type="button" role="radio" aria-checked={method === "passkey"} className={method === "passkey" ? "is-on" : ""} onClick={() => setMethod("passkey")} data-testid="cf-use-passkey">
              {t("safe.onb.usePasskey")}
            </button>
          </div>
        )}
        {method === "password" ? (
          <NewPasswordFields onValid={setPw} autoFocus />
        ) : (
          <p className="v3-muted">{t("safe.onb.passkeyLead")}</p>
        )}
        <p className="sw-small">🧮 {t("safe.onb.kdf")}</p>
        {err && <p className="pz-err" role="alert">{err}</p>}
        <div className="cf-row cf-row-end">
          <button type="button" className="pz-btn pz-btn-ghost" onClick={() => setStep("intro")}>
            {t("safe.back")}
          </button>
          <button type="submit" className="pz-btn" disabled={busy || (method === "password" && !pw)} data-testid="cf-create">
            {busy ? t("safe.onb.creating") : t("safe.onb.create")}
          </button>
        </div>
      </form>
    );

  if (step === "phrase")
    return (
      <div className="v3-result sw cf-onb" data-testid="cf-phrase">
        <div className="v3-step">{t("safe.onb.phraseTitle")}</div>
        <p className="v3-muted">{t("safe.onb.phraseLead")}</p>
        <div className="v3-warn cf-callout" data-testid="cf-noreset">⚠️ {t("safe.onb.noReset")}</div>
        <ol className="cf-words" data-testid="cf-words">
          {phrase.map((w, i) => (
            <li key={i}>
              <button type="button" className={shown.has(i) ? "is-shown" : ""} onClick={() => setShown((s) => new Set(s).add(i))} aria-label={shown.has(i) ? w : t("safe.onb.revealWord", { n: i + 1 })} data-testid={`cf-word-${i}`}>
                <small>{i + 1}</small>
                <span>{w}</span>
              </button>
            </li>
          ))}
        </ol>
        <div className="cf-row">
          <button type="button" className="pz-btn pz-btn-ghost" onClick={() => setShown(new Set(phrase.map((_, i) => i)))} data-testid="cf-reveal-all">
            {t("safe.onb.revealAll")}
          </button>
          <button type="button" className="pz-btn pz-btn-ghost" onClick={() => setShown(new Set())}>
            {t("safe.onb.hideAll")}
          </button>
        </div>
        <label className="sw-check">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="cf-phrase-ack" />
          <span>
            <strong>{t("safe.onb.ack")}</strong>
            <small>{t("safe.onb.ackHint")}</small>
          </span>
        </label>
        <div className="cf-row cf-row-end">
          <button type="button" className="pz-btn" disabled={!ack} onClick={() => setStep("check")} data-testid="cf-phrase-next">
            {t("safe.next")}
          </button>
        </div>
      </div>
    );

  return (
    <form className="v3-result sw cf-onb" data-testid="cf-check" onSubmit={check}>
      <div className="v3-step">{t("safe.onb.checkTitle")}</div>
      <p className="v3-muted">{t("safe.onb.checkLead")}</p>
      <div className="cf-check-grid">
        {positions.map((pos, i) => (
          <label key={pos} className="v3-field sw-field">
            <span>{t("safe.onb.wordN", { n: pos + 1 })}</span>
            <input value={answers[i]} onChange={(e) => { setCheckErr(false); setAnswers((a) => a.map((x, j) => (j === i ? e.target.value : x))); }} autoComplete="off" autoCapitalize="none" spellCheck={false} data-testid={`cf-check-${i}`} data-pos={pos} />
          </label>
        ))}
      </div>
      {checkErr && <p className="pz-err" role="alert" data-testid="cf-check-err">{t("safe.onb.checkErr")}</p>}
      <div className="cf-row cf-row-end">
        <button type="button" className="pz-btn pz-btn-ghost" onClick={() => setStep("phrase")}>
          {t("safe.onb.seeAgain")}
        </button>
        <button type="submit" className="pz-btn" disabled={answers.some((a) => !a.trim())} data-testid="cf-check-submit">
          {t("safe.onb.finish")}
        </button>
      </div>
    </form>
  );
}

/* ── Unlock / recovery ── */

export function Unlock({ client, status, onUnlocked, onImport, onDestroy }: { client: SafeClient; status: VaultStatus; onUnlocked: () => void; onImport: () => void; onDestroy: () => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"pw" | "phrase">("pw");
  const [pw, setPw] = useState("");
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [hasPw, setHasPw] = useState(true);
  const [prfOk, setPrfOk] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void client.hasPassword().then(setHasPw);
    void passkeyPrfSupported().then(setPrfOk);
  }, [client]);

  const run = async (fn: () => Promise<boolean>, badKey: string) => {
    setBusy(true);
    setErr("");
    try {
      if (await fn()) onUnlocked();
      else {
        setErr(t(badKey));
        input.current?.select();
      }
    } catch (ex) {
      setErr(t(errKey(ex)));
    } finally {
      setBusy(false);
    }
  };

  const passkey = () =>
    run(async () => {
      const prf = await passkeySecret(status.passkey!.credId, status.passkey!.salt);
      return client.unlockPasskey(prf);
    }, "safe.unlock.badPasskey");

  return (
    <div className="v3-result sw cf-unlock" data-testid="cf-unlock">
      <div className="cf-lock-icon" aria-hidden="true">🔒</div>
      <div className="v3-step">{t("safe.unlock.title")}</div>
      {mode === "pw" ? (
        <>
          {hasPw && (
            <form onSubmit={(e) => { e.preventDefault(); void run(() => client.unlockPassword(pw), "safe.unlock.badPassword"); }}>
              <label className="v3-field sw-field">
                <span>{t("safe.unlock.password")}</span>
                <input ref={input} type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete="current-password" data-testid="cf-unlock-pw" />
              </label>
              <button type="submit" className="pz-btn pz-btn-block" disabled={busy || !pw} data-testid="cf-unlock-submit">
                {busy ? t("safe.unlock.deriving") : t("safe.unlock.cta")}
              </button>
            </form>
          )}
          {status.passkey && prfOk && (
            <button type="button" className="pz-btn pz-btn-ghost pz-btn-block cf-mt" onClick={() => void passkey()} disabled={busy} data-testid="cf-unlock-passkey">
              🔑 {t("safe.unlock.passkey")}
            </button>
          )}
          {status.passkey && !prfOk && !hasPw && <p className="v3-warn">{t("safe.unlock.passkeyUnsupported")}</p>}
          <button type="button" className="cf-link cf-mt" onClick={() => setMode("phrase")} data-testid="cf-forgot">
            {t("safe.unlock.forgot")}
          </button>
        </>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void run(() => client.unlockPhrase(phrase), "safe.unlock.badPhrase"); }}>
          <p className="v3-muted">{t("safe.unlock.phraseLead")}</p>
          <label className="v3-field sw-field">
            <span>{t("safe.unlock.phrase")}</span>
            <textarea className="cf-textarea" rows={4} value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} data-testid="cf-phrase-input" />
          </label>
          <small className="sw-small">{t("safe.unlock.words", { n: phrase.trim() ? phrase.trim().split(/\s+/).length : 0 })}</small>
          <div className="cf-row cf-row-end">
            <button type="button" className="pz-btn pz-btn-ghost" onClick={() => setMode("pw")}>
              {t("safe.back")}
            </button>
            <button type="submit" className="pz-btn" disabled={busy} data-testid="cf-phrase-submit">
              {t("safe.unlock.recover")}
            </button>
          </div>
        </form>
      )}
      {err && <p className="pz-err" role="alert" data-testid="cf-unlock-err">{err}</p>}
      <details className="sw-privacy cf-mt">
        <summary>{t("safe.unlock.other")}</summary>
        <div className="cf-row">
          <button type="button" className="pz-btn pz-btn-ghost" onClick={onImport}>{t("safe.backup.import")}</button>
          <button type="button" className="cf-link cf-danger-link" onClick={onDestroy} data-testid="cf-destroy">{t("safe.settings.destroy")}</button>
        </div>
      </details>
    </div>
  );
}

export function SetNewPassword({ client, onDone }: { client: SafeClient; onDone: () => void }) {
  const { t } = useTranslation();
  const [pw, setPw] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="v3-result sw cf-onb"
      data-testid="cf-newpw"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!pw) return;
        setBusy(true);
        try {
          await client.setPassword(pw);
          onDone();
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="v3-step">{t("safe.recovered.title")}</div>
      <p className="v3-muted">{t("safe.recovered.lead")}</p>
      <NewPasswordFields onValid={setPw} autoFocus />
      <button type="submit" className="pz-btn pz-btn-block" disabled={!pw || busy} data-testid="cf-newpw-submit">
        {t("safe.recovered.cta")}
      </button>
    </form>
  );
}
