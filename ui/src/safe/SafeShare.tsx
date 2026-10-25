import { createPortal } from "react-dom";
import type { TFunction } from "i18next";
/** P2P sharing: share dialog, contact book, incoming share requests. */
import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { buildContactInvite, handleOfCard, type ContactInvite } from "./invite";
import { useModal } from "../home/useModal";
import { useTranslation } from "react-i18next";
import { confirmDialog, useLeaveGuard } from "../home/confirmLeave";
import { deliver, type DeliveryResult } from "./transport";
import { errKey, fmtRelative, overlayRoot, useSafe } from "./ui";
import { ROLES, type ItemSummary, type Role } from "./types";

const EXPIRY = [0, 3600_000, 86_400_000, 7 * 86_400_000, 30 * 86_400_000];

const inviteBase = () => `${location.origin}${location.pathname}`;

/** Link + QR carrying only your public contact card. */
function InviteLink({ card, handle, reply, testId }: { card: string; handle?: string; reply?: boolean; testId: string }) {
  const { t } = useTranslation();
  const { toast } = useSafe();
  const link = buildContactInvite(inviteBase(), card, reply);
  return (
    <div className="cf-invite-link" data-testid={testId}>
      <p className="sw-small">{t("safe.invite.linkHonest", { handle: handle ?? "" })}</p>
      <div className="v3-qr-wrap">
        <div className="v3-qr">
          <QRCodeSVG value={link} size={168} level="M" marginSize={2} bgColor="#ffffff" fgColor="#0f172a" title={t("safe.invite.qrTitle")} />
        </div>
      </div>
      <div className="v3-link-row cf-card-row">
        <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label={t("safe.invite.linkLabel")} data-testid={`${testId}-url`} />
        <button
          type="button"
          className="pz-btn pz-btn-ghost"
          onClick={async () => {
            await navigator.clipboard.writeText(link).catch(() => undefined);
            toast(t("safe.invite.copied"), "ok");
          }}
          data-testid={`${testId}-copy`}
        >
          {t("safe.copy")}
        </button>
        {typeof navigator.share === "function" && (
          <button type="button" className="pz-btn pz-btn-ghost" onClick={() => void navigator.share({ title: "Filenymous", url: link }).catch(() => undefined)}>
            {t("p2p.shareNative")}
          </button>
        )}
      </div>
    </div>
  );
}

/** Someone opened your vault with their invite link: verify, name, add, then offer yours back. */
function IncomingInvite({ invite, onDone }: { invite: ContactInvite; onDone: () => void }) {
  const { t } = useTranslation();
  const { client, status, peers, toast, reloadPeers } = useSafe();
  const [handle, setHandle] = useState<string | null>(null);
  const [alias, setAlias] = useState("");
  const [added, setAdded] = useState<string | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    void handleOfCard(invite.card).then(setHandle);
  }, [invite.card]);
  const self = invite.card === status.card;
  const known = peers.find((p) => p.card === invite.card);
  return (
    <section className="cf-invite" data-testid="cf-invite" aria-labelledby="cf-invite-title">
      <h2 id="cf-invite-title" className="cf-h3">👤 {t("safe.invite.incomingTitle")}</h2>
      {self ? (
        <p className="sw-small" data-testid="cf-invite-self">{t("safe.invite.self")}</p>
      ) : added || known ? (
        <>
          <p data-testid="cf-invite-added">{t("safe.invite.added", { who: added ?? known!.alias })}</p>
          {!invite.reply && status.card && (
            <>
              <p className="sw-small">{t("safe.invite.replyLead")}</p>
              <InviteLink card={status.card} handle={status.handle} reply testId="cf-invite-reply" />
            </>
          )}
        </>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setErr("");
            try {
              const p = await client.addPeer(invite.card, alias.trim());
              await reloadPeers();
              toast(t("safe.contacts.added", { who: p.alias }), "ok");
              setAdded(p.alias);
            } catch (ex) {
              setErr(t(errKey(ex)));
            }
          }}
        >
          <p className="sw-small">{t("safe.invite.incomingLead")}</p>
          <p>
            <span className="cf-field-label">{t("safe.invite.theirHandle")}</span>{" "}
            <strong className="cf-handle" data-testid="cf-invite-handle">{handle ?? "…"}</strong>
          </p>
          <p className="v3-warn cf-callout" data-testid="cf-invite-verify">{t("safe.invite.verify")}</p>
          <label className="v3-field sw-field">
            <span>{t("safe.contacts.alias")}</span>
            <input value={alias} onChange={(e) => setAlias(e.target.value)} maxLength={60} autoFocus data-testid="cf-invite-alias" />
          </label>
          {err && <p className="pz-err" role="alert">{err}</p>}
          <div className="cf-row">
            <button type="submit" className="pz-btn" data-testid="cf-invite-accept">{t("safe.invite.accept")}</button>
            <button type="button" className="cf-link" onClick={onDone} data-testid="cf-invite-ignore">{t("safe.invite.ignore")}</button>
          </div>
        </form>
      )}
      {(self || added || known) && (
        <button type="button" className="cf-link" onClick={onDone} data-testid="cf-invite-close">{t("common.close")}</button>
      )}
    </section>
  );
}

function AddContact({ onAdded, compact }: { onAdded: (peerId: string) => void; compact?: boolean }) {
  const { t } = useTranslation();
  const { client, toast, reloadPeers } = useSafe();
  const [card, setCard] = useState("");
  const [alias, setAlias] = useState("");
  const [err, setErr] = useState("");
  return (
    <form
      className={`cf-add-contact${compact ? " is-compact" : ""}`}
      onSubmit={async (e) => {
        e.preventDefault();
        setErr("");
        try {
          const p = await client.addPeer(card.trim(), alias.trim());
          setCard("");
          setAlias("");
          await reloadPeers();
          toast(t("safe.contacts.added", { who: p.alias }), "ok");
          onAdded(p.peerId);
        } catch (ex) {
          setErr(t(errKey(ex)));
        }
      }}
    >
      <label className="v3-field sw-field">
        <span>{t("safe.contacts.card")}</span>
        <input value={card} onChange={(e) => setCard(e.target.value)} placeholder="fny1.…" spellCheck={false} autoComplete="off" data-testid="cf-contact-card" />
      </label>
      <label className="v3-field sw-field">
        <span>{t("safe.contacts.alias")}</span>
        <input value={alias} onChange={(e) => setAlias(e.target.value)} maxLength={60} data-testid="cf-contact-alias" />
      </label>
      {err && <p className="pz-err" role="alert">{err}</p>}
      <button type="submit" className="pz-btn pz-btn-ghost" disabled={!card.trim()} data-testid="cf-contact-add">
        {t("safe.contacts.add")}
      </button>
    </form>
  );
}

export function MyCard() {
  const { t } = useTranslation();
  const { status, toast } = useSafe();
  const [inviting, setInviting] = useState(false);
  return (
    <div className="cf-mycard" data-testid="cf-mycard">
      <div>
        <span className="cf-field-label">{t("safe.contacts.myHandle")}</span>
        <strong className="cf-handle" data-testid="cf-my-handle">{status.handle}</strong>
      </div>
      <p className="sw-small">{t("safe.contacts.myCardHint")}</p>
      <button type="button" className="pz-btn" aria-expanded={inviting} onClick={() => setInviting((v) => !v)} data-testid="cf-invite-open">
        👤 {t("safe.invite.cta")}
      </button>
      {inviting && status.card && <InviteLink card={status.card} handle={status.handle} testId="cf-invite-out" />}
      <details className="cf-card-raw">
        <summary>{t("safe.invite.rawCard")}</summary>
      <div className="v3-link-row cf-card-row">
        <input readOnly value={status.card ?? ""} onFocus={(e) => e.currentTarget.select()} aria-label={t("safe.contacts.myCard")} data-testid="cf-my-card" />
        <button type="button" className="pz-btn pz-btn-ghost" onClick={async () => { await navigator.clipboard.writeText(status.card ?? "").catch(() => undefined); toast(t("safe.contacts.cardCopied"), "ok"); }} data-testid="cf-copy-card">
          {t("safe.copy")}
        </button>
      </div>
      </details>
    </div>
  );
}

export function Contacts({ invite, onInviteDone }: { invite?: ContactInvite | null; onInviteDone?: () => void } = {}) {
  const { t, i18n } = useTranslation();
  const { client, peers, reloadPeers } = useSafe();
  return (
    <div className="cf-pane" data-testid="cf-contacts">
      {invite && <IncomingInvite invite={invite} onDone={() => onInviteDone?.()} />}
      <MyCard />
      <h2 className="cf-h3">{t("safe.contacts.title")}</h2>
      {peers.length === 0 ? (
        <div className="sw-empty">{t("safe.contacts.empty")}</div>
      ) : (
        <ul className="cf-contact-list">
          {peers.map((p) => (
            <li key={p.peerId}>
              <span className="cf-avatar" aria-hidden="true">{p.alias.slice(0, 1).toUpperCase()}</span>
              <span className="cf-row-main">
                <strong>{p.alias}</strong>
                <small className="cf-mono">{p.peerId} · {fmtRelative(p.lastSeen, i18n.language)}</small>
              </span>
              <button
                type="button"
                className="cf-link cf-danger-link"
                onClick={async () => {
                  if (!(await confirmDialog({ title: t("safe.contacts.removeTitle"), message: t("safe.contacts.removeMsg", { who: p.alias }), confirmLabel: t("safe.contacts.remove"), cancelLabel: t("safe.cancel"), danger: true }))) return;
                  await client.removePeer(p.peerId);
                  await reloadPeers();
                }}
              >
                {t("safe.contacts.remove")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <h2 className="cf-h3">{t("safe.contacts.addTitle")}</h2>
      <AddContact onAdded={() => undefined} />
    </div>
  );
}

export function deliveryText(t: TFunction, r: DeliveryResult, who: string): { text: string; ok: boolean } {
  switch (r.status) {
    case "new":
    case "updated":
    case "stale":
      return { text: t("safe.share.delivered", { who }), ok: true };
    case "pending":
      return { text: t("safe.share.pendingAccept", { who }), ok: true };
    case "conflict":
      return { text: t("safe.share.conflictThere", { who }), ok: true };
    case "offline":
      return { text: t("safe.share.offline", { who }), ok: false };
    case "rejected":
      return { text: t("safe.share.rejected", { who, reason: r.reason }), ok: false };
    default:
      return { text: t("safe.share.failed", { who }), ok: false };
  }
}

export function ShareDialog({ item, onClose }: { item: ItemSummary; onClose: () => void }) {
  const { t } = useTranslation();
  const { client, peers, toast, refresh } = useSafe();
  const [peerId, setPeerId] = useState(peers[0]?.peerId ?? "");
  const [role, setRole] = useState<Role>("reader");
  const [expiry, setExpiry] = useState(0);
  const [phase, setPhase] = useState<"form" | "connecting" | "waiting" | "sending" | "done">("form");
  const [result, setResult] = useState<{ text: string; ok: boolean } | null>(null);
  const [adding, setAdding] = useState(peers.length === 0);
  const busy = phase !== "form" && phase !== "done";
  useLeaveGuard(busy, { detail: "safe.share.leave" });
  const box = useRef<HTMLDivElement>(null);
  useModal(box, onClose, { canClose: !busy });

  const send = async () => {
    const peer = peers.find((p) => p.peerId === peerId);
    if (!peer) return;
    const expiresAt = expiry ? Date.now() + expiry : undefined;
    setResult(null);
    try {
      const out = await client.buildShare(item.id, peerId, role, expiresAt);
      const r = await deliver(out, { timeoutMs: 45_000, onState: (s) => setPhase(s) });
      const msg = deliveryText(t, r, peer.alias);
      if (msg.ok) {
        await client.recordGrant(item.id, peerId, role, expiresAt);
        await refresh();
      }
      setResult(msg);
      toast(msg.text, msg.ok ? "ok" : "warn");
    } catch (ex) {
      setResult({ text: t(errKey(ex)), ok: false });
    } finally {
      setPhase("done");
    }
  };

  return createPortal(
    <div className="pz-modal-backdrop" onClick={() => !busy && onClose()}>
      <div ref={box} className="pz-modal cf-modal" role="dialog" aria-modal="true" aria-labelledby="cf-share-title" onClick={(e) => e.stopPropagation()} data-testid="cf-share-dialog">
        <h2 id="cf-share-title" className="cf-modal-title">↗︎ {t("safe.share.title", { title: item.title })}</h2>
        {adding ? (
          <>
            <p className="v3-muted">{t("safe.share.addFirst")}</p>
            <AddContact compact onAdded={(id) => { setPeerId(id); setAdding(false); }} />
            {peers.length > 0 && <button type="button" className="cf-link" onClick={() => setAdding(false)}>{t("safe.back")}</button>}
          </>
        ) : (
          <>
            <label className="v3-field sw-field">
              <span>{t("safe.share.to")}</span>
              <div className="cf-row">
                <select value={peerId} onChange={(e) => setPeerId(e.target.value)} disabled={busy} data-testid="cf-share-peer" className="cf-select">
                  {peers.map((p) => (
                    <option key={p.peerId} value={p.peerId}>
                      {p.alias} ({p.peerId})
                    </option>
                  ))}
                </select>
                <button type="button" className="cf-link" onClick={() => setAdding(true)} disabled={busy}>+ {t("safe.contacts.add")}</button>
              </div>
            </label>
            <fieldset className="sw-field">
              <legend>{t("safe.share.role")}</legend>
              <div className="cf-seg" role="radiogroup">
                {ROLES.map((r) => (
                  <button key={r} type="button" role="radio" aria-checked={role === r} className={role === r ? "is-on" : ""} onClick={() => setRole(r)} disabled={busy} data-testid={`cf-role-${r}`}>
                    {t(`safe.role.${r}`)}
                  </button>
                ))}
              </div>
              <small className="sw-small">{t(`safe.role.${role}Hint`)}</small>
            </fieldset>
            <label className="v3-field sw-field">
              <span>{t("safe.share.expiry")}</span>
              <select value={expiry} onChange={(e) => setExpiry(Number(e.target.value))} disabled={busy} className="cf-select" data-testid="cf-share-expiry">
                {EXPIRY.map((ms) => (
                  <option key={ms} value={ms}>{t(`safe.share.exp.${ms === 0 ? "none" : ms === 3600_000 ? "1h" : ms === 86_400_000 ? "1d" : ms === 7 * 86_400_000 ? "7d" : "30d"}`)}</option>
                ))}
              </select>
            </label>
            <div className="cf-honest" data-testid="cf-share-honest">
              <p>🔐 {t("safe.share.honestCrypto")}</p>
              <p>⚖️ {t("safe.share.honestRights")}</p>
              <p>🟢 {t("safe.share.honestOnline")}</p>
            </div>
            {busy && (
              <p className="cf-progress" role="status" data-testid="cf-share-progress">
                <span className="cf-spinner" aria-hidden="true" /> {t(`safe.share.phase.${phase}`)}
              </p>
            )}
            {result && <p className={result.ok ? "cf-ok" : "pz-err"} role="status" data-testid="cf-share-result" data-ok={result.ok}>{result.text}</p>}
          </>
        )}
        <div className="pz-confirm-actions">
          <button type="button" className="pz-btn pz-btn-ghost" onClick={onClose} disabled={busy}>
            {phase === "done" ? t("safe.close") : t("safe.cancel")}
          </button>
          {!adding && (
            <button type="button" className="pz-btn" onClick={() => void send()} disabled={busy || !peerId} data-testid="cf-share-send">
              {phase === "done" && !result?.ok ? t("safe.sync.retry") : t("safe.share.send")}
            </button>
          )}
        </div>
      </div>
    </div>,
    overlayRoot(),
  );
}

export function PendingShares({ list, onDone }: { list: { pendingId: string; from: string; title: string; card: string }[]; onDone: (openId?: string) => void }) {
  const { t } = useTranslation();
  const { client, refresh, reloadPeers, toast } = useSafe();
  const [alias, setAlias] = useState<Record<string, string>>({});
  if (!list.length) return null;
  return (
    <div className="cf-pending" data-testid="cf-pending">
      {list.map((p) => (
        <div key={p.pendingId} className="cf-pending-card">
          <p>
            📨 {t("safe.pending.msg", { title: p.title })} <code className="cf-mono">{p.from}</code>
          </p>
          <p className="sw-small">{t("safe.pending.verify")}</p>
          <div className="cf-row">
            <input value={alias[p.pendingId] ?? ""} onChange={(e) => setAlias((a) => ({ ...a, [p.pendingId]: e.target.value }))} placeholder={t("safe.contacts.alias")} maxLength={60} data-testid="cf-pending-alias" />
            <button
              type="button"
              className="pz-btn"
              data-testid="cf-pending-accept"
              onClick={async () => {
                try {
                  const id = await client.acceptPending(p.pendingId, alias[p.pendingId] ?? "");
                  await Promise.all([refresh(), reloadPeers()]);
                  toast(t("safe.pending.accepted"), "ok");
                  onDone(id);
                } catch (ex) {
                  toast(t(errKey(ex)), "err");
                  onDone();
                }
              }}
            >
              {t("safe.pending.accept")}
            </button>
            <button type="button" className="pz-btn pz-btn-ghost" onClick={async () => { await client.declinePending(p.pendingId); onDone(); }} data-testid="cf-pending-decline">
              {t("safe.pending.decline")}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

