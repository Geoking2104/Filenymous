import { describe, expect, it } from "vitest";
import { htmlToMd, mdToHtml, pagesToHtml, textToHtml } from "./markdown";
import { openKind, sanitizeStem, stem, withExt } from "./fileName";

describe("markdown ⇄ editor HTML", () => {
  it("imports headings, emphasis, lists, links, tables and page breaks", () => {
    const html = mdToHtml("# Titre\n\nTexte **gras** et *italique* ~~barré~~ [lien](https://ex.fr)\n\n- un\n- deux\n\n1. a\n2. b\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n\\newpage\n\nFin");
    expect(html).toContain("<h1>Titre</h1>");
    expect(html).toContain("<strong>gras</strong>");
    expect(html).toContain("<em>italique</em>");
    expect(html).toContain("<s>barré</s>");
    expect(html).toContain('<a href="https://ex.fr">lien</a>');
    expect(html).toMatch(/<ul>\s*<li>un<\/li>/);
    expect(html).toContain("<table>");
    expect(html).toContain('<div data-type="page-break"></div>');
  });

  it("does not render raw HTML from a Markdown file", () => {
    const html = mdToHtml('<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
  });

  it("exports editor HTML (paragraph-wrapped list items and cells) to clean GFM", () => {
    const md = htmlToMd(
      '<h2>Résumé</h2><p>Un <strong>mot</strong> et <em>deux</em>, <s>non</s>, <a href="https://a.b">lien</a>.</p>' +
        "<ul><li><p>pomme</p></li><li><p>poire</p><ul><li><p>williams</p></li></ul></li></ul>" +
        '<ol start="3"><li><p>trois</p></li><li><p>quatre</p></li></ol>' +
        '<table><colgroup><col></colgroup><tbody><tr><th><p>Nom</p></th><th><p>Prix</p></th></tr><tr><td><p>Thé</p></td><td><p>2 €</p></td></tr></tbody></table>' +
        '<div data-type="page-break"></div><hr><pre><code>x = 1</code></pre>',
    );
    expect(md).toContain("## Résumé");
    expect(md).toContain("Un **mot** et *deux*, ~~non~~, [lien](https://a.b).");
    expect(md).toMatch(/^- pomme$/m);
    expect(md).toMatch(/^- poire\n {2}- williams$/m);
    expect(md).toMatch(/^3\. trois$/m);
    expect(md).toMatch(/^4\. quatre$/m);
    expect(md).toMatch(/\| Nom \| Prix \|/);
    expect(md).toMatch(/\| Thé \| 2 € \|/);
    expect(md).toContain("\\newpage");
    expect(md).toContain("```\nx = 1\n```");
  });

  it("round-trips Markdown through the editor HTML", () => {
    const src = "# Plan\n\nIntro avec **gras**.\n\n- a\n- b\n\n> cité\n";
    const back = htmlToMd(mdToHtml(src));
    expect(back).toContain("# Plan");
    expect(back).toContain("Intro avec **gras**.");
    expect(back).toMatch(/^- a$/m);
    expect(back).toContain("> cité");
  });

  it("plain text and extracted pages become paragraphs (escaped)", () => {
    expect(textToHtml("ligne 1\nligne 2\n\n<b>x</b>")).toBe("<p>ligne 1<br>ligne 2</p><p>&lt;b&gt;x&lt;/b&gt;</p>");
    expect(pagesToHtml([["p1"], ["p2a", "p2b"]])).toBe('<p>p1</p><div data-type="page-break"></div><p>p2a</p><p>p2b</p>');
  });
});

describe("file names", () => {
  it("keeps an editable stem and adds the format's extension", () => {
    expect(stem("Complete-Filing-Dossier.pdf")).toBe("Complete-Filing-Dossier");
    expect(stem("notes.v2.md")).toBe("notes.v2");
    expect(sanitizeStem('  a/b:c*?"<>|  ')).toBe("a-b-c-");
    expect(sanitizeStem("...")).toBe("document");
    expect(withExt("Rapport final", "md")).toBe("Rapport final.md");
    expect(withExt("x.pdf", "pdf")).toBe("x.pdf");
    expect(openKind({ name: "a.MD" })).toBe("markdown");
    expect(openKind({ name: "a.txt" })).toBe("text");
    expect(openKind({ name: "a.pdf" })).toBe("pdf");
    expect(openKind({ name: "a.docx" })).toBeNull();
  });
});
