/** Settings: auto-lock, local AI search, passkey, master password, encrypted backup, storage persistence. */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { confirmDialog } from "../home/confirmLeave";
import type { SafeClient } from "./client";
import { createPasskey, passkeyPrfSupported } from "./passkey";
import { NewPasswordFields } from "./SafeGate";
import { errKey, useSafe } from "./ui";

const LOCK_CHOICES = [1, 5, 15, 30, 60];

export async function exportBackupFile(client: SafeClient): Promise<void> {
  const bytes = await client.exportBackup();
  const stamp = new Date().toISOString().slice(0, 10);
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `filenymous-coffre-${stamp}.fnyvault`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** File picker + confirmation; replaces the local vault with the backup. */
export function ImportBackup({ client, hasVault, onDone, label }: { client: SafeClient; hasVault: boolean; onDone: () => void; label?: string }) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState("");
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".fnyvault,application/octet-stream"
        hidden
        data-testid="cf-import-file"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          setErr("");
          if (hasVault && !(await confirmDialog({ title: t("safe.backup.replaceTitle"), message: t("safe.backup.replaceMsg"), confirmLabel: t("safe.backup.replace"), cancelLabel: t("safe.cancel"), danger: true }))) return;
          try {
            await client.importBackup(new Uint8Array(await f.arrayBuffer()));
            onDone();
          } catch (ex) {
            setErr(t(errKey(ex)));
          }
        }}
      />
      <button type="button" className="pz-btn pz-btn-ghost" onClick={() => input.current?.click()} data-testid="cf-import">
        {label ?? t("safe.backup.import")}
      </button>
      {err && <p className="pz-err" role="alert">{err}</p>}
    </>
  );
}

export function Settings({ onReset }: { onReset: () => void }) {
  const { t } = useTranslation();
  const { client, status, refresh, toast, lock } = useSafe();
  const [prfOk, setPrfOk] = useState(false);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [estimate, setEstimate] = useState<{ usage?: number; quota?: number } | null>(null);
  const [changing, setChanging] = useState(false);
  const [newPw, setNewPw] = useState<string | null>(null);
  const [hasPw, setHasPw] = useState(true);

  useEffect(() => {
    void passkeyPrfSupported().then(setPrfOk);
    void navigator.storage?.persisted?.().then(setPersisted);
    void navigator.storage?.estimate?.().then(setEstimate);
    void client.hasPassword().then(setHasPw);
  }, [client]);

  const persist = async () => {
    const ok = (await navigator.storage?.persist?.()) ?? false;
    setPersisted(ok);
    toast(ok ? t("safe.backup.persistOk") : t("safe.backup.persistNo"), ok ? "ok" : "warn");
  };

  return (
    <div className="cf-pane cf-settings" data-testid="cf-settings">
      <section className="cf-sec">
        <h3 className="cf-h3">{t("safe.settings.lockTitle")}</h3>
        <label className="v3-field sw-field">
          <span>{t("safe.settings.autoLock")}</span>
          <select className="cf-select" value={status.settings.autoLockMin} onChange={async (e) => { await client.setSettings({ autoLockMin: Number(e.target.value) }); await refresh(); }} data-testid="cf-autolock">
            {LOCK_CHOICES.map((m) => (
              <option key={m} value={m}>{t("safe.settings.minutes", { n: m })}</option>
            ))}
          </select>
        </label>
        <p className="sw-small">{t("safe.settings.memoryNote")}</p>
        <button type="button" className="pz-btn pz-btn-ghost" onClick={lock}>🔒 {t("safe.lockNow")}</button>
      </section>

      <section className="cf-sec">
        <h3 className="cf-h3">{t("safe.settings.unlockTitle")}</h3>
        {hasPw && !changing && <button type="button" className="pz-btn pz-btn-ghost" onClick={() => setChanging(true)}>{t("safe.settings.changePw")}</button>}
        {changing && (
          <form onSubmit={async (e) => { e.preventDefault(); if (!newPw) return; await client.setPassword(newPw); setChanging(false); setHasPw(true); toast(t("safe.settings.pwChanged"), "ok"); }}>
            <NewPasswordFields onValid={setNewPw} />
            <div className="cf-row">
              <button type="submit" className="pz-btn" disabled={!newPw}>{t("safe.save")}</button>
              <button type="button" className="pz-btn pz-btn-ghost" onClick={() => setChanging(false)}>{t("safe.cancel")}</button>
            </div>
          </form>
        )}
        {prfOk ? (
          status.passkey ? (
            <div className="cf-row">
              <span className="sw-chip">🔑 {t("safe.settings.passkeyOn")}</span>
              {hasPw && (
                <button type="button" className="cf-link cf-danger-link" onClick={async () => { await client.removePasskey(); await refresh(); }}>
                  {t("safe.settings.passkeyRemove")}
                </button>
              )}
            </div>
          ) : (
            <button type="button" className="pz-btn pz-btn-ghost" onClick={async () => { try { const pk = await createPasskey(t("safe.onb.passkeyLabel")); await client.addPasskey(pk.credId, pk.salt, pk.prf); await refresh(); toast(t("safe.settings.passkeyAdded"), "ok"); } catch (ex) { toast(t(errKey(ex)), "err"); } }} data-testid="cf-add-passkey">
              🔑 {t("safe.settings.passkeyAdd")}
            </button>
          )
        ) : (
          <p className="sw-small">{t("safe.settings.passkeyUnsupported")}</p>
        )}
        <p className="sw-small">{t("safe.settings.phraseNote")}</p>
      </section>

      <section className="cf-sec" data-testid="cf-backup">
        <h3 className="cf-h3">{t("safe.backup.title")}</h3>
        <p className="v3-warn cf-callout" data-testid="cf-clear-warning">⚠️ {t("safe.backup.clearWarning")}</p>
        <p className="sw-small">{t("safe.backup.explain")}</p>
        <div className="cf-row">
          <button type="button" className="pz-btn" onClick={async () => { await exportBackupFile(client); toast(t("safe.backup.exported"), "ok"); }} data-testid="cf-export">
            ⬇︎ {t("safe.backup.export")}
          </button>
          <ImportBackup client={client} hasVault onDone={() => { toast(t("safe.backup.imported"), "ok"); onReset(); }} />
        </div>
        <div className="cf-row cf-mt">
          <span className="sw-chip" data-testid="cf-persisted" data-persisted={String(persisted)}>
            {persisted ? `✓ ${t("safe.backup.persisted")}` : t("safe.backup.notPersisted")}
          </span>
          {!persisted && <button type="button" className="cf-link" onClick={() => void persist()} data-testid="cf-persist">{t("safe.backup.persist")}</button>}
          {estimate?.usage != null && <small className="sw-small">{t("safe.backup.usage", { mb: (estimate.usage / 1048576).toFixed(1) })}</small>}
        </div>
      </section>

      <section className="cf-sec">
        <h3 className="cf-h3">{t("safe.settings.danger")}</h3>
        <button
          type="button"
          className="cf-link cf-danger-link"
          data-testid="cf-destroy-settings"
          onClick={async () => {
            if (!(await confirmDialog({ title: t("safe.settings.destroyTitle"), message: t("safe.settings.destroyMsg"), confirmLabel: t("safe.settings.destroy"), cancelLabel: t("safe.cancel"), danger: true }))) return;
            await client.destroyVault();
            onReset();
          }}
        >
          {t("safe.settings.destroy")}
        </button>
      </section>
    </div>
  );
}
