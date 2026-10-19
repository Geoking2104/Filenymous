import { Fragment, useMemo, type ReactNode } from "react";
import { parseMarkup, type Inline, type MentionTarget } from "./markup";
import { highlightRanges } from "./search-annotations";

/** Plain text with the search matches wrapped in <mark> (text nodes only). */
export function Hl({ text, q }: { text: string; q?: string }): ReactNode {
  const r = q ? highlightRanges(text, q) : [];
  if (!r.length) return text;
  const out: ReactNode[] = [];
  let at = 0;
  r.forEach(([a, b], i) => {
    if (a > at) out.push(text.slice(at, a));
    out.push(
      <mark key={i} className="sw2-hl" data-testid="wall-search-hl">
        {text.slice(a, b)}
      </mark>,
    );
    at = b;
  });
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** Renders markdown-lite as React elements (text nodes only: no HTML injection). */
export function Markup({ text, members, self, highlight }: { text: string; members: MentionTarget[]; self?: string; highlight?: string }) {
  const blocks = useMemo(() => parseMarkup(text, members), [text, members]);
  const inl = (c: Inline[]): ReactNode =>
    c.map((n, i) => {
      switch (n.t) {
        case "text":
          return <Fragment key={i}><Hl text={n.v} q={highlight} /></Fragment>;
        case "br":
          return <br key={i} />;
        case "b":
          return <strong key={i}>{inl(n.c)}</strong>;
        case "i":
          return <em key={i}>{inl(n.c)}</em>;
        case "code":
          return <code key={i}><Hl text={n.v} q={highlight} /></code>;
        case "link":
          return (
            <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
              <Hl text={n.v} q={highlight} />
            </a>
          );
        case "mention":
          return (
            <span key={i} className={`sw2-mention${n.label === self ? " is-me" : ""}`} data-label={n.label}>
              <Hl text={n.v} q={highlight} />
            </span>
          );
        default:
          return null;
      }
    });
  return (
    <div className="sw2-md">
      {blocks.map((b, i) =>
        b.t === "pre" ? <pre key={i}><Hl text={b.v} q={highlight} /></pre> : b.t === "quote" ? <blockquote key={i}>{inl(b.c)}</blockquote> : <p key={i}>{inl(b.c)}</p>,
      )}
    </div>
  );
}
