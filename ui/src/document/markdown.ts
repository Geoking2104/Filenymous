/**
 * Markdown ⇄ editor HTML (markdown-it and turndown, both MIT).
 *
 * Import: raw HTML in the Markdown is NOT rendered (html: false); the editor
 * then keeps only the nodes its schema knows. A line "\newpage" (pandoc
 * convention) becomes a page break.
 * Export: GitHub-flavoured Markdown (tables, ~~strike~~). Underline, text
 * alignment and image sizes have no Markdown syntax and are dropped.
 */
import MarkdownIt from "markdown-it";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export const PAGE_BREAK_MD = "\\newpage";
export const PAGE_BREAK_HTML = '<div data-type="page-break"></div>';

let md: MarkdownIt | null = null;
function parser() {
  if (!md) {
    md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });
  }
  return md;
}

export function mdToHtml(source: string): string {
  const html = parser().render(source.replace(/\r\n?/g, "\n"));
  return html.replace(/<p>\\newpage<\/p>/g, PAGE_BREAK_HTML);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Plain text: blank lines separate paragraphs, single newlines are kept as line breaks. */
export function textToHtml(source: string): string {
  const paras = source.replace(/\r\n?/g, "\n").split(/\n\s*\n/);
  return paras
    .map((p) => p.replace(/^\n+|\n+$/g, ""))
    .filter((p) => p.trim().length)
    .map((p) => (p === "\f" ? PAGE_BREAK_HTML : `<p>${p.split("\n").map(esc).join("<br>")}</p>`))
    .join("");
}

/** Paragraphs per page (e.g. text extracted from a PDF) → editor HTML with page breaks between pages. */
export function pagesToHtml(pages: string[][]): string {
  return pages
    .map((paras) => paras.map((p) => `<p>${p.split("\n").map(esc).join("<br>")}</p>`).join("") || "<p></p>")
    .join(PAGE_BREAK_HTML);
}

let td: TurndownService | null = null;
function serializer() {
  if (td) return td;
  const t = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
    // Empty elements are "blank" for turndown and never reach the rules.
    blankReplacement: (_content, node) => {
      const el = node as HTMLElement;
      if (el.nodeName === "DIV" && el.getAttribute?.("data-type") === "page-break") return `\n\n${PAGE_BREAK_MD}\n\n`;
      return (node as unknown as { isBlock?: boolean }).isBlock ? "\n\n" : "";
    },
  });
  t.use(gfm);
  t.addRule("strike", {
    filter: ["del", "s", "strike"] as (keyof HTMLElementTagNameMap)[],
    replacement: (content) => `~~${content}~~`,
  });
  t.addRule("pageBreak", {
    filter: (node) => node.nodeName === "DIV" && (node as HTMLElement).getAttribute("data-type") === "page-break",
    replacement: () => `\n\n${PAGE_BREAK_MD}\n\n`,
  });
  // "- item" instead of turndown's "-   item"; nested content indented to the marker.
  t.addRule("listItem", {
    filter: "li",
    replacement(content, node, options) {
      const parent = node.parentNode as HTMLElement | null;
      let prefix = `${options.bulletListMarker} `;
      if (parent?.nodeName === "OL") {
        const start = Number(parent.getAttribute("start") || 1);
        prefix = `${start + Array.prototype.indexOf.call(parent.children, node)}. `;
      }
      const body = content
        .replace(/\n\n(?=\s*(?:[-*+]|\d+\.) )/g, "\n")
        .replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/gm, `\n${" ".repeat(prefix.length)}`);
      return prefix + body.trimEnd() + (node.nextSibling ? "\n" : "");
    },
  });
  td = t;
  return t;
}

/** Table cells of the editor wrap their text in <p>: flatten them so GFM tables stay on one line. */
function prepare(html: string): string {
  if (typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  doc.querySelectorAll("td, th").forEach((cell) => {
    const parts = Array.from(cell.children).filter((c) => c.nodeName === "P");
    if (parts.length && parts.length === cell.children.length) cell.innerHTML = parts.map((p) => p.innerHTML).join("<br>");
  });
  // A table whose first row is not a header is kept as HTML by the GFM plugin: promote it.
  doc.querySelectorAll("table").forEach((table) => {
    const first = table.querySelector("tr");
    if (first && !first.querySelector("th")) {
      first.querySelectorAll("td").forEach((td) => {
        const th = doc.createElement("th");
        th.innerHTML = td.innerHTML;
        td.replaceWith(th);
      });
    }
  });
  doc.querySelectorAll("colgroup").forEach((c) => c.remove());
  return doc.body.innerHTML;
}

export function htmlToMd(html: string): string {
  const out = serializer().turndown(prepare(html));
  return out.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
