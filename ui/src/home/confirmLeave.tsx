/**
 * Single "you are about to close this window" confirmation, shared by every
 * service (Sharewall, direct transfer, Dropzone, secrets, reports…).
 *
 * - A service holds a leave guard (`useLeaveGuard(active, …)`) while closing
 *   would lose something (an open wall, a live share link, a secret shown once…).
 *   The same guard drives the browser's `beforeunload` prompt (tab close/reload).
 * - In-app close controls (← Accueil, logo, Quitter, Arrêter…) call
 *   `confirmLeave()`: nothing is asked when no guard is held; otherwise the
 *   dialog asks, and on "Quitter" the guards' `onLeave` actions run (e.g. the
 *   Sharewall host destroys the wall for everyone).
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { clearUnloadGuards, holdUnloadGuard, releaseUnloadGuard, unloadGuardActive } from "../p2p/unloadGuardCore";

export interface ConfirmRequest {
  title: string;
  message: string;
  detail?: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
}

type Pending = ConfirmRequest & { resolve: (ok: boolean) => void };

let pending: Pending | null = null;
const listeners = new Set<(p: Pending | null) => void>();
const setPending = (p: Pending | null) => {
  pending = p;
  for (const fn of listeners) fn(p);
};

/** Generic in-app confirmation dialog (needs <ConfirmDialogHost/> mounted). */
export function confirmDialog(req: ConfirmRequest): Promise<boolean> {
  if (listeners.size === 0) return Promise.resolve(typeof window === "undefined" ? true : window.confirm(`${req.message}${req.detail ? `\n\n${req.detail}` : ""}`));
  pending?.resolve(false);
  return new Promise((resolve) => setPending({ ...req, resolve }));
}

interface LeaveEntry {
  onLeave?: () => void;
  detail?: string;
}
const entries = new Map<string, LeaveEntry>();
let seq = 0;

/** Whether closing now would lose something. */
export function leaveWouldLoseData(): boolean {
  return unloadGuardActive();
}

/**
 * Asks before leaving when something would be lost. Resolves true when the
 * caller may proceed (nothing to lose, or the user confirmed). On confirmation,
 * the registered `onLeave` actions run (once).
 */
export async function confirmLeave(opts: { force?: boolean } = {}): Promise<boolean> {
  if (!opts.force && !leaveWouldLoseData()) return true;
  const t = i18n.t.bind(i18n);
  const details = Array.from(new Set(Array.from(entries.values()).map((e) => e.detail).filter((d): d is string => !!d)));
  const ok = await confirmDialog({
    title: t("leave.title"),
    message: t("leave.message"),
    detail: details.map((d) => t(d)).join(" ") || undefined,
    confirmLabel: t("leave.confirm"),
    cancelLabel: t("leave.cancel"),
    danger: true,
  });
  if (!ok) return false;
  const actions = Array.from(entries);
  entries.clear();
  // Confirmed: nothing should ask again for this departure.
  clearUnloadGuards();
  for (const [, e] of actions) {
    try {
      e.onLeave?.();
    } catch {
      /* a failing action never blocks leaving */
    }
  }
  return true;
}

/**
 * Holds the leave guard while `active`. `onLeave` runs when the user confirms
 * leaving through the in-app dialog; `detail` is an i18n key appended to the
 * dialog message (e.g. "the wall will be destroyed for everyone").
 */
export function useLeaveGuard(active: boolean, opts: { onLeave?: () => void; detail?: string } = {}): void {
  const ref = useRef(opts);
  ref.current = opts;
  useEffect(() => {
    if (!active) return;
    const id = `leave-${++seq}`;
    entries.set(id, {
      get onLeave() {
        return ref.current.onLeave;
      },
      get detail() {
        return ref.current.detail;
      },
    });
    holdUnloadGuard(id);
    return () => {
      entries.delete(id);
      releaseUnloadGuard(id);
    };
  }, [active]);
}

/** Renders the pending confirmation (mount once, near the app root). */
export function ConfirmDialogHost() {
  const { t } = useTranslation();
  const [req, setReq] = useState<Pending | null>(pending);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    listeners.add(setReq);
    return () => {
      listeners.delete(setReq);
    };
  }, []);
  useEffect(() => {
    if (!req) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") answer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);
  if (!req) return null;
  function answer(ok: boolean) {
    const r = pending;
    setPending(null);
    r?.resolve(ok);
  }
  return (
    <div className="pz-modal-backdrop" onClick={() => answer(false)}>
      <div
        className="pz-modal pz-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="pz-confirm-title"
        aria-describedby="pz-confirm-msg"
        data-testid="leave-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="pz-confirm-title">{req.title}</h2>
        <p id="pz-confirm-msg" data-testid="leave-message">{req.message}</p>
        {req.detail && <p className="pz-confirm-detail" data-testid="leave-detail">{req.detail}</p>}
        <div className="pz-confirm-actions">
          <button ref={cancelRef} type="button" className="pz-btn pz-btn-ghost" data-testid="leave-cancel" onClick={() => answer(false)}>
            {req.cancelLabel || t("leave.cancel")}
          </button>
          <button type="button" className={`pz-btn${req.danger ? " pz-btn-danger" : ""}`} data-testid="leave-confirm" onClick={() => answer(true)}>
            {req.confirmLabel || t("leave.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
