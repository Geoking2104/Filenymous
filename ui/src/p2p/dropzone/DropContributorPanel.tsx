import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { p2pSupported } from "../config";
import { formatBytes } from "../../ux-v3/types";
import { DropContributor, type ContributorState } from "./contributor";
import { isExpired, parseDropLink } from "./link";
import { PasswordPrompt } from "./DropOwnerPanel";

interface Props {
  hash: string;
}

const GUARDED = ["handshake", "sending", "confirming"];

/** Contributor landing for `#drop:...`: drag & drop, progress, confirmation. */
export default function DropContributorPanel({ hash }: Props) {
  const { t } = useTranslation();
  const params = parseDropLink(hash);
  const [state, setState] = useState<ContributorState>({ status: "connecting", files: [], sentBytes: 0, totalBytes: 0, ownerOnline: false });
  const [password, setPassword] = useState<string | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState(false);
  const ref = useRef<DropContributor | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!params || !p2pSupported()) return;
    const c = new DropContributor(params, setState);
    ref.current = c;
    void c.start();
    return () => c.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash]);

  // The tab-close guard itself is held by DropContributor, from file selection
  // until the owner's receipt.
  useEffect(() => {
    if (["complete", "rejected", "expired"].includes(state.status)) setPending(false);
  }, [state.status]);

  if (!params) return <div className="v3-warn">{t("dropzone.invalidLink")}</div>;
  if (!p2pSupported()) return <div className="v3-warn">{t("p2p.unsupported")}</div>;
  if (isExpired(params) || state.status === "expired") {
    return <div className="v3-warn" data-testid="drop-contrib-status" data-status="expired">{t("dropzone.expired")}</div>;
  }
  const badPassword = state.status === "rejected" && state.reason === "bad-password";
  if (params.password && (password === undefined || badPassword)) {
    return (
      <PasswordPrompt
        error={badPassword && password !== undefined}
        onSubmit={(pw) => {
          setPassword(pw);
          // After a wrong password the user simply drops the files again.
          setState((s) => ({ ...s, status: s.ownerOnline ? "ready" : "owner-offline", reason: undefined }));
        }}
      />
    );
  }

  const choose = (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (!files.length || !ref.current) return;
    setPending(true);
    void ref.current.send(files, password);
  };

  const pct = state.totalBytes ? Math.min(100, Math.round((state.sentBytes / state.totalBytes) * 100)) : 0;
  const busy = GUARDED.includes(state.status) || (pending && state.status === "owner-offline");

  const statusText = (() => {
    switch (state.status) {
      case "connecting":
        return t("dropzone.contribConnecting");
      case "owner-offline":
        return pending ? t("dropzone.ownerOfflinePending") : t("dropzone.ownerOffline");
      case "ready":
        return t("dropzone.contribReady");
      case "handshake":
        return t("dropzone.contribHandshake");
      case "sending":
        return t("dropzone.contribSending", { pct });
      case "confirming":
        return t("dropzone.contribConfirming");
      case "complete":
        return t("dropzone.contribComplete");
      case "rejected":
        return t("dropzone.contribRejected");
      case "error":
        return t("p2p.errorSignal", { message: state.error ?? "" });
      default:
        return "";
    }
  })();

  return (
    <div className="v3-result" data-testid="drop-contrib-panel">
      <div className="v3-step">{params.name ? t("dropzone.contribTitleNamed", { name: params.name }) : t("dropzone.contribTitle")}</div>
      {state.status !== "complete" && (
        <div
          className={`v3-drop${dragging ? " drag" : ""}`}
          data-testid="drop-area"
          role="button"
          tabIndex={0}
          aria-disabled={busy}
          onClick={() => !busy && inputRef.current?.click()}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && !busy && inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (!busy) choose(e.dataTransfer.files);
          }}
          style={{ border: "2px dashed currentColor", borderRadius: 12, padding: "2rem 1rem", textAlign: "center", cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}
        >
          {t("dropzone.dropHere")}
          <input ref={inputRef} type="file" multiple hidden data-testid="drop-input" disabled={busy} onChange={(e) => choose(e.target.files)} />
        </div>
      )}
      {(pending || state.status === "complete") && state.files.length > 0 && (
        <ul className="v3-muted" style={{ fontSize: ".8rem", textAlign: "left", paddingLeft: "1.1rem" }}>
          {state.files.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              {f.name} · {formatBytes(f.size)}
            </li>
          ))}
        </ul>
      )}
      <div className="v3-status" data-testid="drop-contrib-status" data-status={state.status} style={{ margin: ".6rem 0" }}>
        {state.status !== "complete" && <span className="v3-pulse" />}
        {statusText}
      </div>
      {state.status === "sending" && <progress max={100} value={pct} style={{ width: "100%" }} aria-label={t("p2p.progress")} />}
      {busy && <div className="v3-warn" role="note">⚠ {t("dropzone.contribKeepOpen")}</div>}
      {state.status === "complete" && (
        <button type="button" className="v3-btn-ghost" data-testid="drop-send-more" onClick={() => ref.current && setState({ ...state, status: state.ownerOnline ? "ready" : "owner-offline", files: [], sentBytes: 0, totalBytes: 0 })}>
          {t("dropzone.sendMore")}
        </button>
      )}
      <p className="v3-footnote">{t("dropzone.contribPrivacy")}</p>
    </div>
  );
}
