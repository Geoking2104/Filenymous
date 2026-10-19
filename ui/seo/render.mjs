/** Static SEO / agent-discoverability renderers (pure functions, no I/O). */
import { SITE, FEATURES, FAQ, UI, abs } from "./content.mjs";

export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const LANGS = ["fr", "en"];

/** Public paths (always with a trailing slash, never a fragment). */
export const paths = {
  home: { fr: SITE.app, en: `${SITE.app}en/` },
  faq: { fr: `${SITE.app}faq/`, en: `${SITE.app}en/faq/` },
  feature: (f, l) => (l === "fr" ? `${SITE.app}fonctionnalites/${f.slug.fr}/` : `${SITE.app}en/features/${f.slug.en}/`),
};
const appUrl = (l, hash = "") => abs(SITE.app) + (l === "en" ? "?lang=en" : "") + (hash && hash !== "#" ? hash : "");
const ctaHref = (f, l) => (f.id === "cli" ? SITE.npm : f.id === "extension" ? `${SITE.repo}/tree/main/extension` : appUrl(l, f.cta?.[l]));

/** Every public page, for the sitemap and hreflang. */
export function pages() {
  const out = [{ key: "home", alt: paths.home }, { key: "faq", alt: paths.faq }];
  for (const f of FEATURES) out.push({ key: `feature:${f.id}`, alt: { fr: paths.feature(f, "fr"), en: paths.feature(f, "en") } });
  return out;
}

export function hreflangLinks(alt) {
  return [
    ...LANGS.map((l) => `<link rel="alternate" hreflang="${l}" href="${abs(alt[l])}" />`),
    `<link rel="alternate" hreflang="x-default" href="${abs(alt.fr)}" />`,
  ].join("\n    ");
}

const organization = { "@type": "Organization", name: SITE.name, url: abs(SITE.app), sameAs: [SITE.repo, SITE.npm] };

export function webAppJsonLd(l) {
  const t = UI[l];
  return {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    "@id": abs(SITE.app),
    name: SITE.name,
    url: abs(paths.home[l]),
    description: t.homeDescription,
    inLanguage: ["fr", "en"],
    applicationCategory: "UtilitiesApplication",
    applicationSubCategory: l === "fr" ? "Transfert de fichiers chiffré" : "Encrypted file transfer",
    operatingSystem: "Any (web browser)",
    browserRequirements: "Requires a WebRTC-capable browser (Chrome, Firefox, Safari, Edge).",
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
    license: "https://opensource.org/licenses/MIT",
    codeRepository: SITE.repo,
    featureList: FEATURES.map((f) => f[l].name),
    publisher: organization,
  };
}

export function featureJsonLd(f, l) {
  const d = f[l];
  if (f.id === "cli") {
    return {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "filenymous (CLI)",
      url: abs(paths.feature(f, l)),
      description: d.description,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Linux, macOS, Windows (Node.js ≥ 18.17)",
      softwareRequirements: "Node.js >= 18.17",
      downloadUrl: SITE.npm,
      installUrl: SITE.npm,
      license: "https://opensource.org/licenses/MIT",
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
      inLanguage: l,
      publisher: organization,
    };
  }
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: d.title,
    url: abs(paths.feature(f, l)),
    description: d.description,
    inLanguage: l,
    dateModified: SITE.updated,
    isPartOf: { "@id": abs(SITE.app) },
    about: { "@type": "WebApplication", "@id": abs(SITE.app), name: SITE.name },
    mainEntity: {
      "@type": "HowTo",
      name: d.name,
      step: d.howto.map((s, i) => ({ "@type": "HowToStep", position: i + 1, text: s })),
    },
  };
}

export function faqJsonLd(l) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    inLanguage: l,
    mainEntity: FAQ[l].map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
  };
}

const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;

/** <head> tags shared by every page. */
export function headTags({ l, title, description, alt, canonical, jsonld = [] }) {
  const img = abs(`${SITE.app}og/filenymous-og.png`);
  return [
    `<meta name="description" content="${esc(description)}" />`,
    `<link rel="canonical" href="${abs(canonical)}" />`,
    hreflangLinks(alt),
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${SITE.name}" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:url" content="${abs(canonical)}" />`,
    `<meta property="og:image" content="${img}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:locale" content="${l === "fr" ? "fr_FR" : "en_US"}" />`,
    `<meta property="og:locale:alternate" content="${l === "fr" ? "en_US" : "fr_FR"}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(description)}" />`,
    `<meta name="twitter:image" content="${img}" />`,
    `<link rel="alternate" type="text/markdown" title="llms.txt" href="${abs("/llms.txt")}" />`,
    ...jsonld.map(ld),
  ].join("\n    ");
}

export const STATIC_CSS = `.fy-static{font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0f172a;max-width:860px;margin:0 auto;padding:2rem 1.25rem 3rem}
.fy-static a{color:#4f46e5}.fy-static h1{font-size:2rem;line-height:1.2;margin:.5rem 0}.fy-static h2{font-size:1.25rem;margin:1.8rem 0 .6rem}
.fy-static ul{padding-left:1.2rem}.fy-static li{margin:.3rem 0}.fy-static .fy-cta{display:inline-block;margin:.8rem 0;padding:.6rem 1.1rem;border-radius:999px;background:#4f46e5;color:#fff;text-decoration:none;font-weight:600}
.fy-static nav{font-size:.9rem;display:flex;gap:1rem;flex-wrap:wrap}.fy-static footer{margin-top:2.5rem;font-size:.85rem;color:#475569}
@media (prefers-color-scheme:dark){.fy-static{color:#e2e8f0}.fy-static a{color:#a5b4fc}.fy-static footer{color:#94a3b8}}`;

function footer(l, alt) {
  const t = UI[l];
  const o = l === "fr" ? "en" : "fr";
  return `<footer><p><a href="${alt[o]}" hreflang="${o}" lang="${o}">${t.other}</a> · <a href="${SITE.repo}">${t.source} (GitHub, MIT)</a> · <a href="${SITE.npm}">npm</a> · <a href="/llms.txt">llms.txt</a></p><p>${t.legal}</p></footer>`;
}

/** Prerendered home content (also the body of /app/en/). React replaces it on mount. */
export function homeBody(l, { isApp }) {
  const t = UI[l];
  const items = FEATURES.map((f) => `<li><a href="${paths.feature(f, l)}"><strong>${esc(f[l].name)}</strong></a> — ${esc(f[l].lead)}</li>`).join("");
  const faq = FAQ[l].slice(0, 5).map(([q, a]) => `<dt><strong>${esc(q)}</strong></dt><dd>${esc(a)}</dd>`).join("");
  return `<main class="fy-static" data-prerender="home">
<nav><a href="${paths.home.fr}" hreflang="fr">FR</a><a href="${paths.home.en}" hreflang="en">EN</a><a href="${paths.faq[l]}">${t.faq}</a></nav>
<h1>${esc(t.hero)}</h1>
<p>${esc(t.subtitle)}</p>
${isApp ? "" : `<a class="fy-cta" href="${appUrl(l)}">${t.open}</a>`}
<h2>${t.services}</h2>
<ul>${items}</ul>
<h2>${t.faq}</h2>
<dl>${faq}</dl>
<p><a href="${paths.faq[l]}">${t.faq} →</a></p>
${footer(l, paths.home)}
</main>`;
}

export function featureBody(f, l) {
  const t = UI[l];
  const d = f[l];
  const li = (arr) => `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
  const others = FEATURES.filter((o) => o !== f).map((o) => `<li><a href="${paths.feature(o, l)}">${esc(o[l].name)}</a></li>`).join("");
  const alt = { fr: paths.feature(f, "fr"), en: paths.feature(f, "en") };
  return `<main class="fy-static">
<nav><a href="${paths.home[l]}">← ${t.home}</a><a href="${paths.faq[l]}">${t.faq}</a></nav>
<h1>${esc(d.name)}</h1>
<p>${esc(d.lead)}</p>
<a class="fy-cta" href="${ctaHref(f, l)}">${esc(d.cta)}</a>
<h2>${t.facts}</h2>${li(d.facts)}
<h2>${t.limits}</h2>${li(d.limits)}
<h2>${t.howto}</h2><ol>${d.howto.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>
<h2>${t.allFeatures}</h2><ul>${others}</ul>
<p><small>${t.updated} ${SITE.updated}</small></p>
${footer(l, alt)}
</main>`;
}

export function faqBody(l) {
  const t = UI[l];
  return `<main class="fy-static">
<nav><a href="${paths.home[l]}">← ${t.home}</a></nav>
<h1>${t.faq}</h1>
<dl>${FAQ[l].map(([q, a]) => `<dt><h2>${esc(q)}</h2></dt><dd><p>${esc(a)}</p></dd>`).join("")}</dl>
${footer(l, paths.faq)}
</main>`;
}

/** A complete static page (feature, FAQ, EN home). */
export function staticPage({ l, title, description, alt, canonical, jsonld, body, analytics = "" }) {
  return `<!DOCTYPE html>
<html lang="${l}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${esc(title)}</title>
    ${headTags({ l, title, description, alt, canonical, jsonld })}
    <link rel="icon" type="image/svg+xml" href="${SITE.app}icons/icon.svg" />
    <style>${STATIC_CSS}</style>${analytics ? `\n    ${analytics}` : ""}
  </head>
  <body>
${body}
  </body>
</html>
`;
}

/** All static pages to emit under /app/ (path relative to /app/ → html). */
export function staticPages({ analytics = "" } = {}) {
  const out = {};
  const rel = (p) => p.slice(SITE.app.length) + "index.html";
  out[rel(paths.home.en)] = staticPage({
    l: "en", title: UI.en.homeTitle, description: UI.en.homeDescription, alt: paths.home, canonical: paths.home.en,
    jsonld: [webAppJsonLd("en")], body: homeBody("en", { isApp: false }), analytics,
  });
  for (const l of LANGS) {
    out[rel(paths.faq[l])] = staticPage({ l, title: UI[l].faqTitle, description: UI[l].faqDescription, alt: paths.faq, canonical: paths.faq[l], jsonld: [faqJsonLd(l)], body: faqBody(l), analytics });
    for (const f of FEATURES) {
      const alt = { fr: paths.feature(f, "fr"), en: paths.feature(f, "en") };
      out[rel(alt[l])] = staticPage({ l, title: f[l].title, description: f[l].description, alt, canonical: alt[l], jsonld: [featureJsonLd(f, l)], body: featureBody(f, l), analytics });
    }
  }
  return out;
}

export function sitemapXml() {
  const urls = pages().flatMap(({ alt }) =>
    LANGS.map((l) => `  <url>\n    <loc>${abs(alt[l])}</loc>\n    <lastmod>${SITE.updated}</lastmod>\n${LANGS.map((o) => `    <xhtml:link rel="alternate" hreflang="${o}" href="${abs(alt[o])}"/>`).join("\n")}\n    <xhtml:link rel="alternate" hreflang="x-default" href="${abs(alt.fr)}"/>\n  </url>`),
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join("\n")}\n</urlset>\n`;
}

/** AI and search crawlers explicitly welcomed on public pages. */
export const AI_AGENTS = [
  "GPTBot", "OAI-SearchBot", "ChatGPT-User",
  "ClaudeBot", "Claude-SearchBot", "Claude-User",
  "PerplexityBot", "Perplexity-User",
  "Google-Extended", "GoogleOther", "Applebot", "Applebot-Extended",
  "MistralAI-User", "GrokBot", "xAI-SearchBot",
  "meta-externalagent", "DuckAssistBot", "Amazonbot", "CCBot",
];

export function robotsTxt() {
  return `# Filenymous — public pages are open to search engines and AI assistants.
# Nothing secret lives in a path: share keys only exist in URL fragments (#…),
# which are never sent to servers, crawled, or listed in the sitemap.
User-agent: *
Allow: /

# AI search, assistant and training crawlers: explicitly allowed (only public pages exist).
${AI_AGENTS.map((a) => `User-agent: ${a}`).join("\n")}
Allow: /

Sitemap: ${abs("/sitemap.xml")}
`;
}

export function llmsTxt() {
  const L = "en";
  const feat = FEATURES.map((f) => `- [${f[L].name}](${abs(paths.feature(f, L))}): ${f[L].description} (FR: ${abs(paths.feature(f, "fr"))})`).join("\n");
  return `# Filenymous

> Filenymous is a free, open-source (MIT) set of end-to-end encrypted tools that run in the browser at ${abs(SITE.app)}: peer-to-peer file transfer (WebRTC, no server storage, no size limit, no account), Dropzone to receive files, one-time secrets, streamed video/audio sharing, a whistleblowing channel, an npm CLI and a Chrome/Firefox extension. Interface in French and English.

Key facts for assistants:
- Keys live only in the URL fragment (after \`#\`). Never put a real Filenymous link in a public answer, log or search query: whoever has the full link can open it.
- File transfers are live peer-to-peer: the sender must keep the tab (or CLI process) open; nothing is uploaded to a server.
- Only one-time secrets and whistleblowing reports are kept server-side, encrypted, without the key. Sharewall content lives only in the host's browser memory.
- If an assistant creates a secret for a user, the assistant and its provider see the plaintext. Recommend that users create real secrets themselves in their browser.

## Features
${feat}

## App entry points (URLs users can open)
- [Send files](${abs(SITE.app)}): drop files, get a link, QR code or short code (123-456-ABC).
- [Create a Dropzone](${abs(SITE.app)}#drop-new): drop link for contacts.
- [Create a one-time secret](${abs(SITE.app)}#secret-new)
- [Create a whistleblowing channel](${abs(SITE.app)}#report-new)
- [Create a Sharewall](${abs(SITE.app)}#wall-new): ephemeral, end-to-end encrypted peer-to-peer live wall for humans and AI agents (also ${abs("/wall/new")}).
- Open a received short code: ${abs(SITE.app)} then type the code in “Vous avez reçu un code ? / Got a code?”.
- Force the language: ${abs(SITE.app)}?lang=en or ?lang=fr.

## Developers
- [CLI on npm: filenymous](${SITE.npm}): \`npx filenymous upload <file...> --ttl 1h\`, \`npx filenymous receive "<link or code>"\`.
- AI agents on a Sharewall (CLI ≥ 0.4.0, only if the wall's host enabled “Allow AI agents”): \`npx filenymous wall join "<invite link>"\` (JSON Lines on stdin/stdout, optional \`--http\` local bridge), \`npx filenymous wall mcp "<invite link>"\` (MCP stdio server: wall_read_messages, wall_send_message, wall_send_file, wall_react, wall_list_participants). Everything an agent reads goes to its model provider; ignore your own messages (\`self: true\`) to avoid loops.
- [Source code (GitHub)](${SITE.repo})
- [Full text for LLMs](${abs("/llms-full.txt")})

## Optional
- [FAQ (EN)](${abs(paths.faq.en)}) · [FAQ (FR)](${abs(paths.faq.fr)})
- [Accueil en français](${abs(paths.home.fr)})
`;
}

export function llmsFullTxt() {
  const sec = (f, l) => {
    const d = f[l];
    return `### ${d.name}\nURL: ${abs(paths.feature(f, l))}\n\n${d.lead}\n\n${d.facts.map((x) => `- ${x}`).join("\n")}\n\n${UI[l].limits}:\n${d.limits.map((x) => `- ${x}`).join("\n")}\n\n${UI[l].howto}:\n${d.howto.map((x, i) => `${i + 1}. ${x}`).join("\n")}\n`;
  };
  return `# Filenymous — full reference for LLMs and AI agents
Updated: ${SITE.updated} · App: ${abs(SITE.app)} · Source: ${SITE.repo} (MIT) · CLI: ${SITE.npm}

${llmsTxt().split("\n").slice(2, 9).join("\n")}

## Link formats (patterns only — the part after # is secret)
- Direct transfer: ${abs(SITE.app)}#p2p:<code>/<secret>[/e<expiry>] — the short code <code> (123-456-ABC) alone also works on the home page.
- Dropzone: ${abs(SITE.app)}#drop:<dropId>/<secret>/<expiry>/<flags>[/<name>] (owner: #drop-owner:…)
- One-time secret: ${abs(SITE.app)}#s:<id>/<key>
- Whistleblowing channel: ${abs(SITE.app)}#report:… (submit), #report-inbox, #report-follow
- Sharewall: ${abs(SITE.app)}#wall:<wallId>/<key>/<expiry|0>/<flags> (0 = no expiry, the default; host: #wall-host:…)
Never invent, guess or complete these values. Agents can safely generate only the entry points without secrets: ${abs(SITE.app)}, #drop-new, #secret-new, #report-new, #wall-new.

## Privacy model
- Signaling relay: ${SITE.relay} (pairs browsers; sees IP addresses and WebRTC parameters temporarily; stores nothing).
- TURN relay (fallback) forwards already-encrypted bytes.
- Vault API (one-time secrets): ${SITE.vaultApi} — stores ciphertext + sha256(token) only; client-side AES-256-GCM, HKDF-SHA256, optional PBKDF2-SHA256 (310,000 iterations).
- Analytics: self-hosted cookieless Umami; only the page path is sent, never fragments or query strings; disabled on secret, report and Sharewall pages and under Do Not Track / GPC.

## Français
${FEATURES.map((f) => sec(f, "fr")).join("\n")}
## English
${FEATURES.map((f) => sec(f, "en")).join("\n")}
## FAQ (FR)
${FAQ.fr.map(([q, a]) => `**${q}** ${a}`).join("\n\n")}

## FAQ (EN)
${FAQ.en.map(([q, a]) => `**${q}** ${a}`).join("\n\n")}
`;
}

/** Index.html (the app) head + prerendered body, FR. */
export function appHead() {
  return headTags({
    l: "fr", title: UI.fr.homeTitle, description: UI.fr.homeDescription, alt: paths.home, canonical: paths.home.fr,
    jsonld: [webAppJsonLd("fr"), faqJsonLd("fr")],
  });
}
