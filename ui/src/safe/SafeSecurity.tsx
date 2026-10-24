/** Light security dashboard: weak / reused / old passwords; HIBP only on explicit click (k-anonymity). */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSafe } from "./ui";
import type { SecurityReport } from "./types";

async function pwnedCount(sha1: string): Promise<number> {
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  const r = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, { headers: { "Add-Padding": "true" }, referrerPolicy: "no-referrer", credentials: "omit", cache: "no-store" });
  if (!r.ok) throw new Error("hibp");
  for (const line of (await r.text()).split("\n")) {
    const [s, n] = line.trim().split(":");
    if (s === suffix) return Number(n) || 0;
  }
  return 0;
}

export function Security({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const { client, toast } = useSafe();
  const [rep, setRep] = useState<SecurityReport | null>(null);
  const [hibp, setHibp] = useState<{ state: "idle" | "running" | "done"; hits: { id: string; title: string; n: number }[]; checked: number }>({ state: "idle", hits: [], checked: 0 });

  useEffect(() => {
    void client.security().then(setRep);
  }, [client]);

  if (!rep) return <div className="cf-pane" />;
  const issues = rep.weak.length + rep.reused.reduce((a, g) => a + g.ids.length, 0) + rep.old.length;
  const score = rep.logins ? Math.max(0, Math.round(100 - (issues / rep.logins) * 50)) : 100;

  const runHibp = async () => {
    const all = await client.list();
    const logins = all.filter((i) => i.category === "login" && i.hasSecret);
    setHibp({ state: "running", hits: [], checked: 0 });
    const hits: { id: string; title: string; n: number }[] = [];
    let checked = 0;
    try {
      for (const it of logins) {
        const n = await pwnedCount(await client.passwordSha1(it.id));
        if (n > 0) hits.push({ id: it.id, title: it.title, n });
        checked++;
        setHibp({ state: "running", hits: [...hits], checked });
      }
      setHibp({ state: "done", hits, checked });
    } catch {
      toast(t("safe.sec.hibpError"), "err");
      setHibp({ state: "idle", hits, checked });
    }
  };

  return (
    <div className="cf-pane" data-testid="cf-security">
      <div className="cf-score" data-level={score >= 80 ? "good" : score >= 50 ? "mid" : "bad"}>
        <strong data-testid="cf-score">{score}</strong>
        <span>
          {t("safe.sec.scoreLabel")}
          <small>{t("safe.sec.summary", { logins: rep.logins, issues })}</small>
        </span>
      </div>
      <Section title={t("safe.sec.weak")} empty={t("safe.sec.noneWeak")} testId="cf-sec-weak">
        {rep.weak.map((w) => (
          <li key={w.id}><button type="button" className="cf-link" onClick={() => onOpen(w.id)}>{w.title}</button> <small>{t("safe.strength.bits", { bits: Math.round(w.bits) })}</small></li>
        ))}
      </Section>
      <Section title={t("safe.sec.reused")} empty={t("safe.sec.noneReused")} testId="cf-sec-reused">
        {rep.reused.map((g, i) => (
          <li key={i}>{g.ids.map((id, j) => (<button key={id} type="button" className="cf-link" onClick={() => onOpen(id)}>{g.titles[j]}{j < g.ids.length - 1 ? "," : ""}</button>))}</li>
        ))}
      </Section>
      <Section title={t("safe.sec.old")} empty={t("safe.sec.noneOld")} testId="cf-sec-old">
        {rep.old.map((o) => (
          <li key={o.id}><button type="button" className="cf-link" onClick={() => onOpen(o.id)}>{o.title}</button> <small>{t("safe.sec.days", { n: o.days })}</small></li>
        ))}
      </Section>
      <div className="cf-hibp">
        <h3 className="cf-h3">{t("safe.sec.hibpTitle")}</h3>
        <p className="sw-small">{t("safe.sec.hibpExplain")}</p>
        <button type="button" className="pz-btn pz-btn-ghost" onClick={() => void runHibp()} disabled={hibp.state === "running" || rep.logins === 0} data-testid="cf-hibp">
          {hibp.state === "running" ? t("safe.sec.hibpRunning", { n: hibp.checked, total: rep.logins }) : t("safe.sec.hibpCta")}
        </button>
        {hibp.state === "done" && (
          hibp.hits.length === 0 ? (
            <p className="cf-ok">{t("safe.sec.hibpClean", { n: hibp.checked })}</p>
          ) : (
            <ul className="cf-sec-list">
              {hibp.hits.map((h) => (
                <li key={h.id}><button type="button" className="cf-link" onClick={() => onOpen(h.id)}>{h.title}</button> <small className="cf-warn-text">{t("safe.sec.hibpSeen", { n: h.n.toLocaleString() })}</small></li>
              ))}
            </ul>
          )
        )}
      </div>
    </div>
  );
}

function Section({ title, empty, children, testId }: { title: string; empty: string; children: React.ReactNode[]; testId: string }) {
  return (
    <section className="cf-sec" data-testid={testId}>
      <h3 className="cf-h3">{title} <span className="cf-count">{children.length}</span></h3>
      {children.length ? <ul className="cf-sec-list">{children}</ul> : <p className="sw-small cf-ok">✓ {empty}</p>}
    </section>
  );
}
