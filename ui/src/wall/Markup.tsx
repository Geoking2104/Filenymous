import { Fragment, useMemo, type ReactNode } from "react";
import { parseMarkup, type Inline, type MentionTarget } from "./markup";

/** Renders markdown-lite as React elements (text nodes only: no HTML injection). */
export function Markup({ text, members, self }: { text: string; members: MentionTarget[]; self?: string }) {
  const blocks = useMemo(() => parseMarkup(text, members), [text, members]);
  const inl = (c: Inline[]): ReactNode =>
    c.map((n, i) => {
      switch (n.t) {
        case "text":
          return <Fragment key={i}>{n.v}</Fragment>;
        case "br":
          return <br key={i} />;
        case "b":
          return <strong key={i}>{inl(n.c)}</strong>;
        case "i":
          return <em key={i}>{inl(n.c)}</em>;
        case "code":
          return <code key={i}>{n.v}</code>;
        case "link":
          return (
            <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
              {n.v}
            </a>
          );
        case "mention":
          return (
            <span key={i} className={`sw2-mention${n.label === self ? " is-me" : ""}`} data-label={n.label}>
              {n.v}
            </span>
          );
        default:
          return null;
      }
    });
  return (
    <div className="sw2-md">
      {blocks.map((b, i) =>
        b.t === "pre" ? <pre key={i}>{b.v}</pre> : b.t === "quote" ? <blockquote key={i}>{inl(b.c)}</blockquote> : <p key={i}>{inl(b.c)}</p>,
      )}
    </div>
  );
}
