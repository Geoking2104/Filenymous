import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Member } from "./feed";
import type { Thread, ThreadMsg } from "./threads";

/**
 * Host-only view of the private agent-to-agent threads. They are routed
 * through this tab, so the host sees every message, approves each thread and
 * can close it; other participants never receive them.
 */
export function AgentThreads({ threads, msgs, members, onApprove, onClose }: { threads: Thread[]; msgs: Record<string, ThreadMsg[]>; members: Member[]; onApprove: (id: string) => void; onClose: (id: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<string | null>(null);
  if (!threads.length) return null;
  const name = (l: string) => members.find((m) => m.label === l)?.name ?? l;
  const order = { pending: 0, open: 1, closed: 2 } as const;
  const list = [...threads].sort((x, y) => order[x.state] - order[y.state] || y.at - x.at);
  return (
    <section className="sw2-section sw-threads" data-testid="wall-threads">
      <h3 className="sw2-h">🔒 {t("wall.threads.title")}</h3>
      <p className="sw-small">{t("wall.threads.note")}</p>
      {list.map((th) => (
        <div key={th.id} className="sw-thread" data-testid="wall-thread" data-state={th.state} data-id={th.id}>
          <p>
            <strong>{name(th.a)}</strong> ↔ <strong>{name(th.b)}</strong> · <span data-testid="wall-thread-state">{t(`wall.threads.state.${th.state}`)}</span>
            {th.goal && (
              <>
                <br />
                <small>🎯 {th.goal}</small>
              </>
            )}
          </p>
          <div className="sw-thread-actions">
            {th.state === "pending" && (
              <button type="button" className="pz-btn" data-testid="wall-thread-approve" onClick={() => onApprove(th.id)}>
                {t("wall.threads.approve")}
              </button>
            )}
            {th.state !== "closed" && (
              <button type="button" className="pz-btn pz-btn-ghost" data-testid="wall-thread-close" onClick={() => onClose(th.id)}>
                {t(th.state === "pending" ? "wall.threads.refuse" : "wall.threads.close")}
              </button>
            )}
            <button type="button" className="pz-btn pz-btn-ghost" data-testid="wall-thread-view" onClick={() => setOpen(open === th.id ? null : th.id)}>
              {t("wall.threads.view", { count: th.n })}
            </button>
          </div>
          {open === th.id && (
            <ol className="sw-thread-log" data-testid="wall-thread-log">
              {(msgs[th.id] ?? []).map((m) => (
                <li key={m.n}>
                  <strong>{name(m.by)}</strong>: {m.text}
                </li>
              ))}
            </ol>
          )}
        </div>
      ))}
    </section>
  );
}
