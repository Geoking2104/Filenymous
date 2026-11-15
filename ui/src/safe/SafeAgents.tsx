/**
 * Coffre-fort › Agents: Doppler-style credentials for AI agents.
 * Scoped (one config = a few items mapped to env var names), read-only,
 * expiring and revocable tokens; every fetch is audited on the owner's node.
 * Secret values are sealed inside the vault worker to the agent's own key:
 * the page and the node only ever handle ciphertext.
 * Design: docs/agent-vault/ARCHITECTURE.md.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSafe } from "./ui";
import { ENV_NAME, agentPubKeyFromEd25519, decodeEnrollment, enrollmentFingerprint, randomId, type Enrollment } from "./agentSeal";
import type { AgentEnvMapping, ItemSummary } from "./types";
import {
  agentVaultAvailable,
  createAgentConfig,
  issueAgentToken,
  listAccessEvents,
  listAgentConfigs,
  listAgentTokens,
  revokeAgentToken,
  rotateBundle,
  tokenFileFor,
  type AgentConfigEntry,
  type AuditEntry,
  type TokenStatus,
} from "../holochain/agentVault";

const TTLS: { key: string; s: number }[] = [
  { key: "1h", s: 3600 },
  { key: "8h", s: 8 * 3600 },
  { key: "24h", s: 24 * 3600 },
  { key: "7d", s: 7 * 86400 },
  { key: "30d", s: 30 * 86400 },
];
const FIELDS: AgentEnvMapping["field"][] = ["apiKey", "password", "username", "url", "notes"];
const fmt = (us: number) => new Date(us / 1000).toLocaleString();

export function Agents() {
  const { t } = useTranslation();
  const { client, toast } = useSafe();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [configs, setConfigs] = useState<AgentConfigEntry[]>([]);
  const [tokens, setTokens] = useState<TokenStatus[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [shown, setShown] = useState<{ file: string; label: string } | null>(null);

  const reload = useCallback(async () => {
    const [c, tk, a] = await Promise.all([listAgentConfigs(), listAgentTokens(), listAccessEvents({ limit: 50 })]);
    setConfigs(c);
    setTokens(tk.sort((x, y) => y.issued_at - x.issued_at));
    setAudit(a);
  }, []);

  useEffect(() => {
    void agentVaultAvailable().then(async (ok) => {
      setAvailable(ok);
      if (!ok) return;
      setItems((await client.list()).filter((i) => i.category !== "file"));
      await reload().catch((e) => toast(String((e as Error).message), "err"));
    });
  }, [client, reload, toast]);

  if (available === null) return <div className="cf-pane" />;
  if (!available)
    return (
      <div className="cf-pane" data-testid="cf-agents-unavailable">
        <h2 className="cf-h3">{t("safe.agents.title")}</h2>
        <p className="sw-small">{t("safe.agents.needsNode")}</p>
      </div>
    );

  const rotate = async (tk: TokenStatus) => {
    const cfg = configs.find((c) => c.config_id === tk.config_id);
    if (!cfg) return toast(t("safe.agents.errNoConfig"), "err");
    const manifest = await client.agentManifestOpen(cfg.enc_manifest);
    const sealed = await client.agentSeal(manifest.mappings, tk.agent_x25519, { tokenId: tk.token_id, version: tk.latest_version + 1 });
    await rotateBundle(tk.token_id, sealed);
    toast(t("safe.agents.rotated"), "ok");
    await reload();
  };

  const revoke = async (tk: TokenStatus) => {
    if (!window.confirm(t("safe.agents.revokeConfirm"))) return;
    await revokeAgentToken(tk.token_id, "revoked from Coffre-fort");
    toast(t("safe.agents.revoked"), "ok");
    await reload();
  };

  return (
    <div className="cf-pane cf-agents" data-testid="cf-agents">
      <h2 className="cf-h3">{t("safe.agents.title")}</h2>
      <p className="sw-small">{t("safe.agents.intro")}</p>
      <p className="sw-small cf-warn-text">{t("safe.agents.limits")}</p>

      <ConfigForm items={items} onCreated={reload} />
      <IssueForm configs={configs} onIssued={async (file, label) => { setShown({ file, label }); await reload(); }} />

      {shown && (
        <section className="cf-sec" data-testid="cf-agents-token">
          <h2 className="cf-h3">{t("safe.agents.tokenOnce", { label: shown.label })}</h2>
          <p className="sw-small">{t("safe.agents.tokenHelp")}</p>
          <textarea readOnly className="cf-input" rows={3} value={shown.file} data-testid="cf-agents-token-value" onFocus={(e) => e.currentTarget.select()} />
          <pre className="sw-small">{`FNY_AGENT_TOKEN='…' npx filenymous vault run -- <agent command>`}</pre>
          <button type="button" className="pz-btn" onClick={() => { void navigator.clipboard?.writeText(shown.file); toast(t("safe.agents.copied"), "ok"); }}>{t("safe.copy")}</button>{" "}
          <button type="button" className="pz-btn pz-btn-ghost" onClick={() => setShown(null)}>{t("safe.close")}</button>
        </section>
      )}

      <section className="cf-sec" data-testid="cf-agents-tokens">
        <h2 className="cf-h3">{t("safe.agents.tokens")} <span className="cf-count">{tokens.length}</span></h2>
        {tokens.length === 0 ? <p className="sw-small">{t("safe.agents.noTokens")}</p> : (
          <ul className="cf-sec-list">
            {tokens.map((tk) => (
              <li key={tk.token_id} data-testid="cf-agents-token-row">
                <strong>{tk.label || tk.token_id.slice(0, 8)}</strong>{" "}
                <small>
                  {tk.revoked ? t("safe.agents.stRevoked") : tk.expired ? t("safe.agents.stExpired") : t("safe.agents.stActive")}
                  {" · "}{t("safe.agents.uses", { n: tk.uses, max: tk.max_uses || "∞" })}
                  {" · "}{t("safe.agents.expires", { at: fmt(tk.expires_at) })}
                  {" · v"}{tk.latest_version}
                </small>{" "}
                {!tk.revoked && !tk.expired && (
                  <>
                    <button type="button" className="cf-link" onClick={() => void rotate(tk).catch((e) => toast(String(e.message), "err"))}>{t("safe.agents.rotate")}</button>{" "}
                    <button type="button" className="cf-link" onClick={() => void revoke(tk).catch((e) => toast(String(e.message), "err"))} data-testid="cf-agents-revoke">{t("safe.agents.revoke")}</button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="cf-sec" data-testid="cf-agents-audit">
        <h2 className="cf-h3">{t("safe.agents.audit")}</h2>
        {audit.length === 0 ? <p className="sw-small">{t("safe.agents.noAudit")}</p> : (
          <ul className="cf-sec-list">
            {audit.map((a) => (
              <li key={a.action_seq} data-testid={`cf-agents-audit-${a.event.kind.type}`}>
                <small>#{a.action_seq} {fmt(a.event.at)}</small>{" "}
                <strong>{t(`safe.agents.kind.${a.event.kind.type}`)}</strong>
                {a.event.kind.type === "Denied" && <small className="cf-warn-text"> ({a.event.kind.reason})</small>}{" "}
                <small>{tokens.find((x) => x.token_id === a.event.token_id)?.label || a.event.token_id.slice(0, 8)}</small>
                {a.event.bundle_version != null && <small> · v{a.event.bundle_version}</small>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ConfigForm({ items, onCreated }: { items: ItemSummary[]; onCreated: () => Promise<void> }) {
  const { t } = useTranslation();
  const { client, toast } = useSafe();
  const [name, setName] = useState("");
  const [rows, setRows] = useState<AgentEnvMapping[]>([]);
  const valid = name.trim().length > 0 && rows.length > 0 && rows.every((r) => r.itemId && ENV_NAME.test(r.env)) && new Set(rows.map((r) => r.env)).size === rows.length;

  const save = async () => {
    const blob = await client.agentManifestSeal({ v: 1, mappings: rows });
    await createAgentConfig(randomId(), name.trim().slice(0, 64), blob);
    setName("");
    setRows([]);
    toast(t("safe.agents.configSaved"), "ok");
    await onCreated();
  };

  return (
    <details className="cf-sec" data-testid="cf-agents-config">
      <summary className="cf-h3">{t("safe.agents.newConfig")}</summary>
      <label className="sw-small">{t("safe.agents.configName")} <input className="cf-input" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} data-testid="cf-agents-config-name" /></label>
      {rows.map((r, i) => (
        <div key={i} className="cf-row">
          <select className="cf-input" data-testid={`cf-agents-row-item-${i}`} value={r.itemId} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, itemId: e.target.value } : x)))}>
            <option value="">{t("safe.agents.pickItem")}</option>
            {items.map((it) => <option key={it.id} value={it.id}>{it.title}</option>)}
          </select>
          <select className="cf-input" data-testid={`cf-agents-row-field-${i}`} value={r.field} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, field: e.target.value as AgentEnvMapping["field"] } : x)))}>
            {FIELDS.map((f) => <option key={f} value={f}>{t(`safe.agents.field.${f}`)}</option>)}
          </select>
          <input className="cf-input" data-testid={`cf-agents-row-env-${i}`} placeholder="GITHUB_TOKEN" value={r.env} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, env: e.target.value.toUpperCase() } : x)))} />
          <button type="button" className="cf-link" onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button type="button" className="pz-btn pz-btn-ghost" onClick={() => setRows([...rows, { itemId: "", field: "apiKey", env: "" }])} data-testid="cf-agents-addvar">{t("safe.agents.addVar")}</button>{" "}
      <button type="button" className="pz-btn" data-testid="cf-agents-config-save" disabled={!valid} onClick={() => void save().catch((e) => toast(String(e.message), "err"))}>{t("safe.save")}</button>
    </details>
  );
}

function IssueForm({ configs, onIssued }: { configs: AgentConfigEntry[]; onIssued: (file: string, label: string) => Promise<void> }) {
  const { t } = useTranslation();
  const { client, toast } = useSafe();
  const [configId, setConfigId] = useState("");
  const [code, setCode] = useState("");
  const [ttl, setTtl] = useState(3600);
  const [maxUses, setMaxUses] = useState(0);
  const [busy, setBusy] = useState(false);
  const [fp, setFp] = useState<string | null>(null);
  const enrollment = useMemo<Enrollment | null>(() => {
    try {
      return code.trim() ? decodeEnrollment(code) : null;
    } catch {
      return null;
    }
  }, [code]);

  useEffect(() => {
    setFp(null);
    if (enrollment) void enrollmentFingerprint(enrollment).then(setFp);
  }, [enrollment]);

  const issue = async () => {
    const cfg = configs.find((c) => c.config_id === configId);
    if (!cfg || !enrollment) return;
    setBusy(true);
    try {
      const tokenId = randomId();
      const manifest = await client.agentManifestOpen(cfg.enc_manifest);
      const sealed = await client.agentSeal(manifest.mappings, enrollment.x, { tokenId, version: 1 });
      const label = enrollment.label || cfg.name;
      const issued = await issueAgentToken({
        tokenId,
        configId: cfg.config_id,
        label,
        agentKey: agentPubKeyFromEd25519(enrollment.ed),
        agentX25519: enrollment.x,
        sealed,
        ttlSeconds: ttl,
        maxUses,
      });
      setCode("");
      await onIssued(await tokenFileFor(issued, label), label);
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="cf-sec" data-testid="cf-agents-issue">
      <summary className="cf-h3">{t("safe.agents.issue")}</summary>
      <p className="sw-small">{t("safe.agents.enrollHelp")}</p>
      <pre className="sw-small">npx filenymous vault enroll --name claude-ci</pre>
      <label className="sw-small">{t("safe.agents.enrollCode")} <textarea className="cf-input" rows={2} value={code} onChange={(e) => setCode(e.target.value)} data-testid="cf-agents-enroll-code" /></label>
      {code.trim() && !enrollment && <p className="sw-small cf-warn-text">{t("safe.agents.badCode")}</p>}
      {fp && <p className="sw-small" data-testid="cf-agents-fp">{t("safe.agents.fingerprint", { fp })}</p>}
      <label className="sw-small">{t("safe.agents.config")}{" "}
        <select className="cf-input" data-testid="cf-agents-issue-config" value={configId} onChange={(e) => setConfigId(e.target.value)}>
          <option value="">—</option>
          {configs.map((c) => <option key={c.config_id} value={c.config_id}>{c.name}</option>)}
        </select>
      </label>
      <label className="sw-small">{t("safe.agents.ttl")}{" "}
        <select className="cf-input" value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
          {TTLS.map((x) => <option key={x.key} value={x.s}>{t(`safe.agents.ttlOpt.${x.key}`)}</option>)}
        </select>
      </label>
      <label className="sw-small">{t("safe.agents.maxUses")} <input className="cf-input" type="number" min={0} value={maxUses} onChange={(e) => setMaxUses(Math.max(0, Math.floor(Number(e.target.value) || 0)))} /></label>
      <button type="button" className="pz-btn" disabled={busy || !enrollment || !configId} onClick={() => void issue().catch((e) => toast(String(e.message), "err"))} data-testid="cf-agents-issue-btn">{t("safe.agents.issueCta")}</button>
    </details>
  );
}
