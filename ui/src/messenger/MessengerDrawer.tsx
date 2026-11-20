/**
 * Messenger drawer (M1): my profile, friends added by link / QR with mutual
 * acceptance, invitations, import of vault contacts. Presence and chat come in
 * the next phases; their places are shown as "bientôt".
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import { Avatar } from "../components/Avatar";
import { activeSafe } from "../safe/shared";
import { handleOfCard } from "../safe/invite";
import { AVATAR_MAX_BYTES, resizeAvatar } from "./avatar";
import { NAME_MAX } from "./invite";
import { MESSENGER_CHANGED } from "./link";
import type { DrawerTab } from "./MessengerButton";
import {
  acceptInvite,
  confirmReply,
  createProfile,
  declineOrRemove,
  forgetCachedKeys,
  importVaultContacts,
  loadMe,
  myInviteLink,
  receiveInvite,
  requestLink,
  updateProfile,
  type InviteOutcome,
  type Me,
  type VaultContact,
} from "./service";
import { listFriends, wipeAll, type Friend, type Profile } from "./store";

interface Props {
  initialTab: DrawerTab;
  invite: string | null;
  onInviteHandled: () => void;
  onClose: () => void;
}

const TABS: DrawerTab[] = ["friends", "chats", "invites", "profile"];

function errText(t: (k: string) => string, e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  const known = ["avatar-not-image", "avatar-input-too-big", "avatar-unreadable", "avatar-too-big", "bad-name"];
  return known.includes(m) ? t(`msg.err.${m}`) : t("msg.err.generic");
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CopyLink({ link, testId, label }: { link: string; testId: string; label?: string }) {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  return (
    <div className="fy-msg-link">
      <div className="fy-msg-qr">
        <QRCodeSVG value={link} size={156} level="M" marginSize={2} bgColor="#ffffff" fgColor="#0f172a" title={t("msg.qrTitle")} />
      </div>
      {label && <p className="fy-msg-hint">{label}</p>}
      <div className="fy-msg-row">
        <input readOnly value={link} aria-label={t("msg.linkLabel")} data-testid={testId} onFocus={(e) => e.currentTarget.select()} />
        <button
          type="button"
          className="pz-btn"
          onClick={async () => {
            setDone(await copy(link));
            window.setTimeout(() => setDone(false), 1800);
          }}
        >
          {done ? t("msg.copied") : t("msg.copy")}
        </button>
      </div>
    </div>
  );
}

function PhotoPicker({ value, onChange, name, seed }: { value: Blob | null; onChange: (b: Blob | null) => void; name: string; seed: string }) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <div className="fy-msg-photo">
      <Avatar name={name || "?"} seed={seed} photo={value} size={72} testId="msg-photo-preview" />
      <div className="fy-msg-photo-actions">
        <input
          ref={input}
          type="file"
          accept="image/*"
          hidden
          data-testid="msg-photo-input"
          onChange={async (e) => {
            const f = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (!f) return;
            setBusy(true);
            setErr("");
            try {
              onChange(await resizeAvatar(f));
            } catch (x) {
              setErr(errText(t, x));
            } finally {
              setBusy(false);
            }
          }}
        />
        <button type="button" className="pz-btn-ghost" disabled={busy} onClick={() => input.current?.click()} data-testid="msg-photo-pick">
          {busy ? t("msg.photo.busy") : value ? t("msg.photo.change") : t("msg.photo.pick")}
        </button>
        {value && (
          <button type="button" className="pz-link" onClick={() => onChange(null)} data-testid="msg-photo-remove">
            {t("msg.photo.remove")}
          </button>
        )}
        <small className="fy-msg-hint">{t("msg.photo.hint", { kb: Math.round(AVATAR_MAX_BYTES / 1024) })}</small>
        {err && (
          <small className="fy-msg-err" role="alert">
            {err}
          </small>
        )}
      </div>
    </div>
  );
}

function ProfileForm({ onDone, lead }: { onDone: (me: Me) => void; lead?: string }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="fy-msg-card"
      data-testid="msg-profile-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr("");
        try {
          onDone(await createProfile(name, photo ?? undefined));
        } catch (x) {
          setErr(errText(t, x));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>{t("msg.profile.createTitle")}</h3>
      <p className="fy-msg-hint">{lead ?? t("msg.profile.createLead")}</p>
      <label className="fy-msg-field">
        <span>{t("msg.profile.name")}</span>
        <input value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} required autoComplete="nickname" data-testid="msg-name" />
      </label>
      <PhotoPicker value={photo} onChange={setPhoto} name={name} seed={name} />
      {err && (
        <p className="fy-msg-err" role="alert">
          {err}
        </p>
      )}
      <button type="submit" className="pz-btn pz-btn-block" disabled={busy || !name.trim()} data-testid="msg-create-profile">
        {t("msg.profile.create")}
      </button>
    </form>
  );
}

function Soon({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <span className="fy-msg-soon" title={t("msg.soonTitle")}>
      {children} · {t("msg.soon")}
    </span>
  );
}

function VaultRef({ refCard }: { refCard: string }) {
  const { t } = useTranslation();
  const [handle, setHandle] = useState<string | null>(null);
  const [alias, setAlias] = useState<string | null>(null);
  useEffect(() => {
    void handleOfCard(refCard).then(setHandle);
    const safe = activeSafe();
    if (!safe) return;
    void safe
      .status()
      .then((s) => (s.unlocked ? safe.peers() : []))
      .then((peers) => setAlias(peers.find((p) => p.card === refCard)?.alias ?? null))
      .catch(() => undefined);
  }, [refCard]);
  if (!handle) return null;
  return (
    <small className="fy-msg-hint" data-testid="msg-vault-ref">
      {alias ? t("msg.invites.vaultKnown", { alias }) : t("msg.invites.vaultRef", { handle })}
    </small>
  );
}

function ProfileTab({ me, setMe }: { me: Me; setMe: (m: Me | null) => void }) {
  const { t } = useTranslation();
  const [link, setLink] = useState<string | null>(null);
  const [name, setName] = useState(me.profile.displayName);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState(false);
  const p = me.profile;

  const patch = async (x: Partial<Omit<Profile, "createdAt" | "updatedAt">>) => {
    setErr("");
    try {
      const profile = await updateProfile(x);
      setMe({ ...me, profile });
      if (x.displayName !== undefined) setLink(null);
      return true;
    } catch (e) {
      setErr(errText(t, e));
      return false;
    }
  };

  const toggles: { key: "discoverable" | "shareOfflineStatus" | "hideLastSeen" | "hideReadReceipts" }[] = [
    { key: "discoverable" },
    { key: "shareOfflineStatus" },
    { key: "hideLastSeen" },
    { key: "hideReadReceipts" },
  ];

  return (
    <div className="fy-msg-stack" data-testid="msg-profile">
      <section className="fy-msg-card fy-msg-me">
        <Avatar name={p.displayName} seed={me.handle} photo={p.avatar} size={64} testId="msg-my-avatar" />
        <div>
          <strong data-testid="msg-my-name">{p.displayName}</strong>
          <code className="fy-msg-handle" data-testid="msg-my-handle">
            {me.handle}
          </code>
        </div>
      </section>

      <section className="fy-msg-card">
        <h3>{t("msg.profile.addFriend")}</h3>
        <p className="fy-msg-hint">{t("msg.profile.addFriendLead")}</p>
        {link ? (
          <CopyLink link={link} testId="msg-invite-link" />
        ) : (
          <button type="button" className="pz-btn pz-btn-block" data-testid="msg-make-invite" onClick={async () => setLink(await myInviteLink())}>
            {t("msg.profile.makeInvite")}
          </button>
        )}
      </section>

      <section className="fy-msg-card">
        <h3>{t("msg.profile.edit")}</h3>
        <form
          className="fy-msg-row"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await patch({ displayName: name })) {
              setSaved(true);
              window.setTimeout(() => setSaved(false), 1500);
            }
          }}
        >
          <input value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} aria-label={t("msg.profile.name")} data-testid="msg-edit-name" />
          <button type="submit" className="pz-btn-ghost" disabled={!name.trim() || name.trim() === p.displayName}>
            {saved ? t("msg.saved") : t("msg.save")}
          </button>
        </form>
        <PhotoPicker value={p.avatar ?? null} onChange={(b) => void patch({ avatar: b ?? undefined })} name={p.displayName} seed={me.handle} />
        {err && (
          <p className="fy-msg-err" role="alert">
            {err}
          </p>
        )}
      </section>

      <section className="fy-msg-card">
        <h3>{t("msg.privacy.title")}</h3>
        <p className="fy-msg-hint">{t("msg.privacy.lead")}</p>
        {toggles.map(({ key }) => (
          <label key={key} className="fy-msg-toggle">
            <input type="checkbox" checked={p[key]} onChange={(e) => void patch({ [key]: e.currentTarget.checked })} data-testid={`msg-privacy-${key}`} />
            <span>
              <strong>{t(`msg.privacy.${key}`)}</strong>
              <small>{t(`msg.privacy.${key}Hint`)}</small>
            </span>
          </label>
        ))}
      </section>

      <VaultImport />

      <section className="fy-msg-card">
        <button
          type="button"
          className="pz-link fy-msg-danger"
          data-testid="msg-wipe"
          onClick={async () => {
            if (!window.confirm(t("msg.profile.wipeConfirm"))) return;
            await wipeAll();
            forgetCachedKeys();
            setMe(null);
          }}
        >
          {t("msg.profile.wipe")}
        </button>
      </section>
    </div>
  );
}

function VaultImport() {
  const { t } = useTranslation();
  const [state, setState] = useState<"closed" | "unlocked" | "loading">("loading");
  const [contacts, setContacts] = useState<VaultContact[]>([]);
  const [myCard, setMyCard] = useState<string | undefined>();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<number | null>(null);

  useEffect(() => {
    const safe = activeSafe();
    if (!safe) {
      setState("closed");
      return;
    }
    void safe
      .status()
      .then(async (s) => {
        if (!s.unlocked) return setState("closed");
        const [peers, me] = await Promise.all([safe.peers(), safe.identity()]);
        setContacts(peers.map((p) => ({ handle: p.peerId, alias: p.alias, card: p.card })));
        setMyCard(me.card);
        setState("unlocked");
      })
      .catch(() => setState("closed"));
  }, []);

  return (
    <section className="fy-msg-card" data-testid="msg-vault-import">
      <h3>{t("msg.import.title")}</h3>
      <p className="fy-msg-hint">{t("msg.import.lead")}</p>
      {state === "closed" && (
        <p className="fy-msg-hint">
          {t("msg.import.locked")}{" "}
          <a className="pz-link" href="#safe">
            {t("msg.import.openSafe")}
          </a>
        </p>
      )}
      {state === "unlocked" && contacts.length === 0 && <p className="fy-msg-hint">{t("msg.import.none")}</p>}
      {state === "unlocked" && contacts.length > 0 && (
        <>
          <ul className="fy-msg-list">
            {contacts.map((c) => (
              <li key={c.handle}>
                <label className="fy-msg-toggle">
                  <input
                    type="checkbox"
                    checked={picked.has(c.handle)}
                    onChange={(e) => {
                      const n = new Set(picked);
                      if (e.currentTarget.checked) n.add(c.handle);
                      else n.delete(c.handle);
                      setPicked(n);
                    }}
                  />
                  <span>
                    <strong>{c.alias}</strong>
                    <small>{c.handle}</small>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="pz-btn pz-btn-block"
            disabled={picked.size === 0}
            onClick={async () => {
              setDone(await importVaultContacts(contacts.filter((c) => picked.has(c.handle)), myCard));
              setPicked(new Set());
            }}
          >
            {t("msg.import.go", { count: picked.size })}
          </button>
          <small className="fy-msg-hint">{t("msg.import.reaccept")}</small>
        </>
      )}
      {done !== null && (
        <p className="fy-msg-ok" role="status">
          {t("msg.import.done", { count: done })}
        </p>
      )}
    </section>
  );
}

function FriendRow({ f, children }: { f: Friend; children?: ReactNode }) {
  return (
    <li className="fy-msg-friend" data-testid="msg-friend" data-status={f.status} data-name={f.name}>
      <Avatar name={f.name} seed={f.handle ?? f.id} size={40} />
      <div className="fy-msg-friend-main">
        <strong>{f.name}</strong>
        {f.handle && <code className="fy-msg-handle">{f.handle}</code>}
        {f.ref && f.status !== "friend" && <VaultRef refCard={f.ref} />}
      </div>
      <div className="fy-msg-friend-actions">{children}</div>
    </li>
  );
}

function FriendsTab({ friends, reload, go }: { friends: Friend[]; reload: () => void; go: (t: DrawerTab) => void }) {
  const { t } = useTranslation();
  const mutual = friends.filter((f) => f.status === "friend");
  const outgoing = friends.filter((f) => f.status === "outgoing");
  const [shown, setShown] = useState<{ id: string; link: string } | null>(null);
  return (
    <div className="fy-msg-stack" data-testid="msg-friends">
      {mutual.length === 0 ? (
        <div className="fy-msg-empty">
          <p>{t("msg.friends.empty")}</p>
          <button type="button" className="pz-btn" onClick={() => go("profile")}>
            {t("msg.friends.invite")}
          </button>
        </div>
      ) : (
        <ul className="fy-msg-list">
          {mutual.map((f) => (
            <FriendRow key={f.id} f={f}>
              <Soon>{t("msg.friends.presence")}</Soon>
              <button type="button" className="pz-btn-ghost" disabled title={t("msg.soonTitle")}>
                {t("msg.friends.write")}
              </button>
              {f.replyLink && (
                <button type="button" className="pz-link" onClick={() => setShown(shown?.id === f.id ? null : { id: f.id, link: f.replyLink! })}>
                  {t("msg.friends.replyLink")}
                </button>
              )}
              <button
                type="button"
                className="pz-link fy-msg-danger"
                onClick={async () => {
                  if (!window.confirm(t("msg.friends.removeConfirm", { name: f.name }))) return;
                  await declineOrRemove(f.id);
                  reload();
                }}
              >
                {t("msg.friends.remove")}
              </button>
              {shown?.id === f.id && <CopyLink link={shown.link} testId="msg-reply-link-again" label={t("msg.invites.replyLead", { name: f.name })} />}
            </FriendRow>
          ))}
        </ul>
      )}
      {outgoing.length > 0 && (
        <section className="fy-msg-card">
          <h3>{t("msg.friends.outgoing")}</h3>
          <p className="fy-msg-hint">{t("msg.friends.outgoingLead")}</p>
          <ul className="fy-msg-list">
            {outgoing.map((f) => (
              <FriendRow key={f.id} f={f}>
                <button type="button" className="pz-link" onClick={async () => setShown(shown?.id === f.id ? null : { id: f.id, link: await requestLink(f.id) })}>
                  {t("msg.friends.requestLink")}
                </button>
                <button
                  type="button"
                  className="pz-link fy-msg-danger"
                  onClick={async () => {
                    await declineOrRemove(f.id);
                    reload();
                  }}
                >
                  {t("msg.friends.cancel")}
                </button>
                {shown?.id === f.id && <CopyLink link={shown.link} testId="msg-request-link" label={t("msg.friends.requestLead", { name: f.name })} />}
              </FriendRow>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function InvitesTab({ me, setMe, friends, outcome, reload }: { me: Me | null; setMe: (m: Me) => void; friends: Friend[]; outcome: InviteOutcome | null; reload: () => void }) {
  const { t } = useTranslation();
  const pending = friends.filter((f) => f.status === "incoming" || f.status === "reply");
  const [reply, setReply] = useState<{ name: string; link: string } | null>(null);
  const [err, setErr] = useState("");

  return (
    <div className="fy-msg-stack" data-testid="msg-invites">
      {outcome && outcome.kind !== "saved" && (
        <p className={outcome.kind === "already" ? "fy-msg-ok" : "fy-msg-err"} role="status" data-testid="msg-invite-outcome" data-kind={outcome.kind}>
          {outcome.kind === "already" ? t("msg.invites.already", { name: outcome.friend.name }) : t(`msg.invites.${outcome.kind === "not-for-me" ? "notForMe" : outcome.kind}`)}
        </p>
      )}
      {reply && (
        <section className="fy-msg-card fy-msg-success" data-testid="msg-reply">
          <h3>{t("msg.invites.acceptedTitle", { name: reply.name })}</h3>
          <CopyLink link={reply.link} testId="msg-reply-link" label={t("msg.invites.replyLead", { name: reply.name })} />
        </section>
      )}
      {pending.length === 0 && !reply && <p className="fy-msg-empty">{t("msg.invites.empty")}</p>}
      {pending.length > 0 && !me && <ProfileForm onDone={setMe} lead={t("msg.invites.needProfile")} />}
      {err && (
        <p className="fy-msg-err" role="alert">
          {err}
        </p>
      )}
      {pending.length > 0 && (
        <ul className="fy-msg-list">
          {pending.map((f) => (
            <FriendRow key={f.id} f={f}>
              <small className="fy-msg-hint fy-msg-friend-lead">{f.status === "incoming" ? t("msg.invites.incoming", { name: f.name }) : t("msg.invites.replied", { name: f.name })}</small>
              <button
                type="button"
                className="pz-btn"
                disabled={!me}
                data-testid={f.status === "incoming" ? "msg-accept" : "msg-confirm"}
                onClick={async () => {
                  setErr("");
                  try {
                    if (f.status === "incoming") setReply({ name: f.name, link: await acceptInvite(f.id) });
                    else await confirmReply(f.id);
                    reload();
                  } catch (e) {
                    setErr(errText(t, e));
                  }
                }}
              >
                {f.status === "incoming" ? t("msg.invites.accept") : t("msg.invites.confirm")}
              </button>
              <button
                type="button"
                className="pz-btn-ghost"
                data-testid="msg-decline"
                onClick={async () => {
                  await declineOrRemove(f.id);
                  reload();
                }}
              >
                {t("msg.invites.decline")}
              </button>
            </FriendRow>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function MessengerDrawer({ initialTab, invite, onInviteHandled, onClose }: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<DrawerTab>(initialTab);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [outcome, setOutcome] = useState<InviteOutcome | null>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const reload = useCallback(() => {
    void listFriends().then(setFriends);
  }, []);

  useEffect(() => {
    void loadMe().then(setMe);
    reload();
    window.addEventListener(MESSENGER_CHANGED, reload);
    return () => window.removeEventListener(MESSENGER_CHANGED, reload);
  }, [reload]);

  useEffect(() => setTab(initialTab), [initialTab]);

  useEffect(() => {
    if (!invite) return;
    void receiveInvite(invite).then((o) => {
      setOutcome(o);
      setTab("invites");
      onInviteHandled();
      reload();
    });
  }, [invite, onInviteHandled, reload]);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [onClose]);

  const counts: Partial<Record<DrawerTab, number>> = {
    friends: friends.filter((f) => f.status === "friend").length,
    invites: friends.filter((f) => f.status === "incoming" || f.status === "reply").length,
  };

  let body: ReactNode;
  if (me === undefined) body = <p className="fy-msg-hint">…</p>;
  else if (tab === "invites") body = <InvitesTab me={me} setMe={setMe} friends={friends} outcome={outcome} reload={reload} />;
  else if (!me) body = <ProfileForm onDone={setMe} />;
  else if (tab === "profile") body = <ProfileTab me={me} setMe={setMe} />;
  else if (tab === "chats")
    body = (
      <div className="fy-msg-empty" data-testid="msg-chats">
        <p>
          <strong>{t("msg.chats.title")}</strong>
        </p>
        <p className="fy-msg-hint">{t("msg.chats.soon")}</p>
      </div>
    );
  else body = <FriendsTab friends={friends} reload={reload} go={setTab} />;

  return createPortal(
    <div className="fy-msg-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} className="fy-msg-drawer" role="dialog" aria-modal="true" aria-labelledby="fy-msg-title" data-testid="msg-drawer">
        <header className="fy-msg-head">
          {me && <Avatar name={me.profile.displayName} seed={me.handle} photo={me.profile.avatar} size={32} />}
          <h2 id="fy-msg-title">{t("msg.title")}</h2>
          <button ref={closeBtn} type="button" className="fy-msg-close" aria-label={t("msg.close")} onClick={onClose} data-testid="msg-close">
            ×
          </button>
        </header>
        <nav className="fy-msg-tabs" role="tablist" aria-label={t("msg.title")}>
          {TABS.map((k) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)} data-testid={`msg-tab-${k}`}>
              {t(`msg.tabs.${k}`)}
              {!!counts[k] && <span className="fy-msg-count">{counts[k]}</span>}
            </button>
          ))}
        </nav>
        <div className="fy-msg-body">{body}</div>
        <footer className="fy-msg-foot">{t("msg.footer")}</footer>
      </div>
    </div>,
    // Inside the shell so the design tokens (light/dark) and button styles apply.
    document.querySelector(".pz-app") ?? document.body,
  );
}
