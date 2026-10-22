/**
 * Sharewall collaboration UI: shared checklist + decisions log, agent approval
 * and scopes, context-pack sharing. Pure presentation: every action goes to the
 * host (single writer) through RoomApi.
 */
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SCOPE_DEFAULT, TASK_TEXT_MAX, TERMINAL_STATES, scopeName, type AgentScope, type Task, type TaskKind } from "./collab";
import type { Member } from "./feed";
import { Hl } from "./Markup";

type Patch = import("./collab").TaskPatch;

export interface TasksApi {
  addTask(kind: TaskKind, text: string, owner: string | null): void | Promise<void>;
  updateTask(id: string, patch: Patch): void | Promise<void>;
  deleteTask(id: string): void | Promise<void>;
}

const hhmm = (at: number, lang: string) => new Date(at).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
const quiet = (p: void | Promise<void>) => void Promise.resolve(p).catch(() => undefined);

export function TasksPanel({ tasks, members, self, isHost, nameOf, api, canWrite, share }: {
  tasks: Task[];
  members: Member[];
  self?: string;
  isHost: boolean;
  nameOf: (l: string) => string;
  api: TasksApi;
  canWrite: boolean;
  share?: (id: string) => ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const [kind, setKind] = useState<TaskKind>("task");
  const [text, setText] = useState("");
  const [owner, setOwner] = useState("");
  const open = tasks.filter((x) => x.kind === "task");
  const decisions = tasks.filter((x) => x.kind === "decision");
  const ownerSelect = (value: string, onChange: (v: string) => void, testId: string) => (
    <select className="sw-task-owner" data-testid={testId} value={value} onChange={(e) => onChange(e.target.value)} aria-label={t("wall.tasks.owner")}>
      <option value="">{t("wall.tasks.unassigned")}</option>
      {members.map((m) => (
        <option key={m.label} value={m.label}>
          {m.agent ? "🤖 " : ""}
          {m.name}
        </option>
      ))}
    </select>
  );
  return (
    <section className="sw2-section sw-tasks" data-testid="wall-tasks">
      {canWrite && (
        <form
          className="sw-task-form"
          onSubmit={(e) => {
            e.preventDefault();
            const v = text.trim();
            if (!v) return;
            quiet(api.addTask(kind, v, kind === "task" ? owner || null : null));
            setText("");
          }}
        >
          <div className="sw-task-kinds" role="radiogroup" aria-label={t("wall.tasks.kind")}>
            <label><input type="radio" name="sw-task-kind" data-testid="wall-task-kind-task" checked={kind === "task"} onChange={() => setKind("task")} /> ✅ {t("wall.tasks.task")}</label>
            <label><input type="radio" name="sw-task-kind" data-testid="wall-task-kind-decision" checked={kind === "decision"} onChange={() => setKind("decision")} /> 🧭 {t("wall.tasks.decision")}</label>
          </div>
          <input className="sw-task-input" data-testid="wall-task-input" value={text} maxLength={TASK_TEXT_MAX} placeholder={t(kind === "task" ? "wall.tasks.placeholderTask" : "wall.tasks.placeholderDecision")} onChange={(e) => setText(e.target.value)} aria-label={t("wall.tasks.text")} />
          {kind === "task" && ownerSelect(owner, setOwner, "wall-task-owner-new")}
          <button type="submit" className="pz-btn" data-testid="wall-task-add" disabled={!text.trim()}>
            {t("wall.tasks.add")}
          </button>
        </form>
      )}
      <h3 className="sw2-h">✅ {t("wall.tasks.checklist", { done: open.filter((x) => x.done).length, count: open.length })}</h3>
      {!open.length && <p className="sw-small">{t("wall.tasks.emptyTasks")}</p>}
      <ul className="sw-task-list" data-testid="wall-task-list">
        {open.map((x) => (
          <li key={x.id} className={`sw-task${x.done ? " is-done" : ""}`} data-testid="wall-task" data-id={x.id} data-done={x.done} data-owner={x.owner ?? ""}>
            <label className="sw-task-check">
              <input type="checkbox" data-testid="wall-task-done" checked={x.done} disabled={!canWrite} onChange={(e) => quiet(api.updateTask(x.id, { done: e.target.checked }))} />
              <span className="sw-task-text">{x.text}</span>
            </label>
            {x.state && (
              <span className="sw-task-a2a">
                <span className={`sw-task-state is-${x.state}`} data-testid="wall-task-state" data-state={x.state} title={t("wall.tasks.stateHint")}>
                  🤝 {t(`wall.tasks.state.${x.state}`)}
                </span>
                {x.note && !x.done && !TERMINAL_STATES.has(x.state) && <small className="sw-task-note" data-testid="wall-task-note">{x.note}</small>}
                {x.result && <small data-testid="wall-task-result">📎 {t("wall.tasks.result")}</small>}
                {canWrite && (isHost || x.by === self) && !["completed", "failed", "canceled", "rejected"].includes(x.state) && (
                  <button type="button" className="sw2-linkbtn" data-testid="wall-task-cancel" onClick={() => quiet(api.updateTask(x.id, { state: "canceled" }))}>
                    {t("wall.tasks.cancel")}
                  </button>
                )}
              </span>
            )}
            <span className="sw-task-meta">
              {canWrite ? ownerSelect(x.owner ?? "", (v) => quiet(api.updateTask(x.id, { owner: v || null })), "wall-task-owner") : <span>{x.owner ? nameOf(x.owner) : t("wall.tasks.unassigned")}</span>}
              <small>{t("wall.tasks.by", { name: nameOf(x.by), time: hhmm(x.at, i18n.language) })}</small>
              {share?.(x.id)}
              {(isHost || x.by === self) && canWrite && (
                <button type="button" className="sw2-iconbtn" data-testid="wall-task-delete" aria-label={t("wall.tasks.delete")} title={t("wall.tasks.delete")} onClick={() => quiet(api.deleteTask(x.id))}>
                  🗑
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      <h3 className="sw2-h">🧭 {t("wall.tasks.decisions", { count: decisions.length })}</h3>
      {!decisions.length && <p className="sw-small">{t("wall.tasks.emptyDecisions")}</p>}
      <ol className="sw-decision-list" data-testid="wall-decision-list">
        {decisions.map((x) => (
          <li key={x.id} className="sw-decision" data-testid="wall-decision" data-id={x.id}>
            <span className="sw-task-text">{x.text}</span>
            <small>{t("wall.tasks.by", { name: nameOf(x.by), time: hhmm(x.at, i18n.language) })}</small>
            {share?.(x.id)}
            {(isHost || x.by === self) && canWrite && (
              <button type="button" className="sw2-iconbtn" data-testid="wall-task-delete" aria-label={t("wall.tasks.delete")} title={t("wall.tasks.delete")} onClick={() => quiet(api.deleteTask(x.id))}>
                🗑
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

export function TaskSearchHits({ tasks, query, onOpen }: { tasks: Task[]; query: string; onOpen: () => void }) {
  const { t } = useTranslation();
  if (!tasks.length) return null;
  return (
    <div className="sw-note-hits" data-testid="wall-task-hits">
      {tasks.map((x) => (
        <button key={x.id} type="button" className="sw-note-hit" data-testid="wall-task-hit" onClick={onOpen}>
          {x.kind === "decision" ? "🧭" : x.done ? "☑️" : "✅"} <span className="sw-small">{t(x.kind === "decision" ? "wall.tasks.decision" : "wall.tasks.task")}</span> <Hl text={x.text} q={query} />
        </button>
      ))}
    </div>
  );
}

// ---- agents: approval, scopes ------------------------------------------------

export function ScopeChips({ scope }: { scope?: AgentScope }) {
  const { t } = useTranslation();
  if (!scope) return null;
  const name = scopeName(scope);
  return (
    <span className="sw-scope" data-testid="wall-agent-scope" data-scope={name} data-limited={scope.limited}>
      <span className="sw2-badge is-scope" title={t("wall.scope.hint")}>
        {t(`wall.scope.name.${name}`)}
      </span>
      {name === "custom" && (
        <>
          {scope.post && <span className="sw2-badge is-scope">{t("wall.scope.post")}</span>}
          {scope.files && <span className="sw2-badge is-scope">{t("wall.scope.files")}</span>}
          {scope.secrets && <span className="sw2-badge is-scope">{t("wall.scope.secrets")}</span>}
        </>
      )}
      {scope.limited && <span className="sw2-badge is-scope is-limited">{t("wall.scope.limited")}</span>}
    </span>
  );
}

export function ScopeEditor({ value, onChange }: { value: AgentScope; onChange: (s: AgentScope) => void }) {
  const { t } = useTranslation();
  const box = (k: keyof AgentScope) => (
    <label className="sw-check sw-scope-opt" key={k}>
      <input type="checkbox" data-testid={`wall-scope-${k}`} checked={value[k]} onChange={(e) => onChange({ ...value, [k]: e.target.checked })} />
      <span>
        <strong>{t(`wall.scope.${k}`)}</strong>
        <small>{t(`wall.scope.${k}Hint`)}</small>
      </span>
    </label>
  );
  return <div className="sw-scope-editor" data-testid="wall-scope-editor">{(["post", "files", "secrets", "limited"] as const).map(box)}</div>;
}

export function PendingAgents({ pending, onApprove, onRefuse }: { pending: Array<{ label: string; name: string }>; onApprove: (label: string, s: AgentScope) => void; onRefuse: (label: string) => void }) {
  const { t } = useTranslation();
  if (!pending.length) return null;
  return (
    <section className="sw2-section sw-pending" data-testid="wall-agents-pending">
      <h3 className="sw2-h">🤖 {t("wall.scope.pendingTitle", { count: pending.length })}</h3>
      {pending.map((a) => (
        <PendingCard key={a.label} a={a} onApprove={onApprove} onRefuse={onRefuse} />
      ))}
      <p className="sw-small">{t("wall.scope.pendingNote")}</p>
    </section>
  );
}

function PendingCard({ a, onApprove, onRefuse }: { a: { label: string; name: string }; onApprove: (label: string, s: AgentScope) => void; onRefuse: (label: string) => void }) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<AgentScope>({ ...SCOPE_DEFAULT });
  return (
    <div className="sw-pending-card" data-testid="wall-agent-pending" data-label={a.label}>
      <p>
        <strong>{a.name}</strong> {t("wall.scope.wantsToJoin")}
      </p>
      <ScopeEditor value={scope} onChange={setScope} />
      <div className="sw-pending-actions">
        <button type="button" className="pz-btn" data-testid="wall-agent-approve" onClick={() => onApprove(a.label, scope)}>
          {t("wall.scope.approve")}
        </button>
        <button type="button" className="pz-btn pz-btn-ghost" data-testid="wall-agent-refuse" onClick={() => onRefuse(a.label)}>
          {t("wall.scope.refuse")}
        </button>
      </div>
    </div>
  );
}

/** Host-only per-entry toggle: share this post / task with agents in limited view (their context pack). */
export function AgentShare({ id, agents, packs, onShare }: { id: string; agents: Member[]; packs: Record<string, string[]>; onShare: (label: string, id: string, on: boolean) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!agents.length) return null;
  const count = agents.filter((a) => packs[a.label]?.includes(id)).length;
  return (
    <span className="sw-share">
      <button type="button" className="sw2-iconbtn" data-testid="wall-agent-share" aria-expanded={open} title={t("wall.scope.share")} aria-label={t("wall.scope.share")} onClick={() => setOpen((o) => !o)}>
        🤖{count ? <sup>{count}</sup> : "+"}
      </button>
      {open && (
        <span className="sw-share-pop" role="group" data-testid="wall-agent-share-pop">
          <small>{t("wall.scope.shareHint")}</small>
          {agents.map((a) => (
            <label key={a.label} className="sw-check">
              <input type="checkbox" data-testid="wall-agent-share-toggle" data-label={a.label} checked={!!packs[a.label]?.includes(id)} onChange={(e) => onShare(a.label, id, e.target.checked)} />
              <span>{a.name}</span>
            </label>
          ))}
        </span>
      )}
    </span>
  );
}
