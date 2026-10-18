/**
 * Markdown-lite for wall messages, parsed to a small AST that React renders
 * as elements (never innerHTML): **bold**, *italic* / _italic_, `code`,
 * ```code blocks```, > quotes, http(s) links and @mentions. Anything else,
 * including HTML, stays plain text.
 */
export type Inline =
  | { t: "text"; v: string }
  | { t: "br" }
  | { t: "b"; c: Inline[] }
  | { t: "i"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; v: string }
  | { t: "mention"; v: string; label: string };

export type Block = { t: "p"; c: Inline[] } | { t: "quote"; c: Inline[] } | { t: "pre"; v: string };

export interface MentionTarget {
  label: string;
  name: string;
}

/** Only absolute http(s) URLs become links. */
export function safeHref(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/y;

function parseInline(src: string, members: MentionTarget[], depth = 0): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  const names = [...members].filter((m) => m.name).sort((a, b) => b.name.length - a.name.length);
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    const rest = src.slice(i);
    if (ch === "\n") {
      flush();
      out.push({ t: "br" });
      i++;
      continue;
    }
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ t: "code", v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (depth < 3 && rest.startsWith("**")) {
      const end = src.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: "b", c: parseInline(src.slice(i + 2, end), members, depth + 1) });
        i = end + 2;
        continue;
      }
    }
    if (depth < 3 && (ch === "*" || ch === "_") && /\S/.test(src[i + 1] ?? "") && (i === 0 || !/[\p{L}\p{N}]/u.test(src[i - 1]!))) {
      const end = src.indexOf(ch, i + 1);
      if (end > i + 1 && /\S/.test(src[end - 1]!) && !/[\p{L}\p{N}]/u.test(src[end + 1] ?? "")) {
        flush();
        out.push({ t: "i", c: parseInline(src.slice(i + 1, end), members, depth + 1) });
        i = end + 1;
        continue;
      }
    }
    if (ch === "h") {
      URL_RE.lastIndex = i;
      const m = URL_RE.exec(src);
      if (m) {
        const raw = m[0].replace(/[.,;:!?)\]]+$/, "");
        const href = safeHref(raw);
        if (href) {
          flush();
          out.push({ t: "link", href, v: raw });
          i += raw.length;
          continue;
        }
      }
    }
    if (ch === "@" && (i === 0 || !/[\p{L}\p{N}_]/u.test(src[i - 1]!))) {
      const lower = rest.toLowerCase();
      const hit = names.find((n) => lower.startsWith(`@${n.name.toLowerCase()}`) && !/[\p{L}\p{N}_-]/u.test(rest[n.name.length + 1] ?? " "));
      if (hit) {
        flush();
        out.push({ t: "mention", v: rest.slice(0, hit.name.length + 1), label: hit.label });
        i += hit.name.length + 1;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

export function parseMarkup(text: string, members: MentionTarget[] = []): Block[] {
  const blocks: Block[] = [];
  const parts = text.split(/```/);
  parts.forEach((part, idx) => {
    // Odd parts are inside a fence (an unclosed fence stays text).
    if (idx % 2 === 1 && idx < parts.length - 1) {
      blocks.push({ t: "pre", v: part.replace(/^[a-z0-9+-]*\n/i, "").replace(/\n$/, "") });
      return;
    }
    const raw = idx % 2 === 1 ? "```" + part : part;
    let para: string[] = [];
    let quote: string[] = [];
    const flushPara = () => {
      const s = para.join("\n").replace(/^\n+|\n+$/g, "");
      if (s) blocks.push({ t: "p", c: parseInline(s, members) });
      para = [];
    };
    const flushQuote = () => {
      if (quote.length) blocks.push({ t: "quote", c: parseInline(quote.join("\n"), members) });
      quote = [];
    };
    for (const line of raw.split("\n")) {
      if (/^>\s?/.test(line)) {
        flushPara();
        quote.push(line.replace(/^>\s?/, ""));
      } else {
        flushQuote();
        para.push(line);
      }
    }
    flushQuote();
    flushPara();
  });
  return blocks;
}

/** Plain-text preview (reply chips, notifications). */
export function plainPreview(text: string, max = 80): string {
  const s = text.replace(/```[\s\S]*?```/g, "[code]").replace(/[*_`>]/g, "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
