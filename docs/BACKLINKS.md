# Backlinks and directories: prioritized targets (GEO/SEO)

Status: **nothing has been submitted**. Each submission is to be done manually by the maintainer.
URLs were checked on 2026-10-19 (HTTP 200, except AlternativeTo and Reddit which return 403 to bots but exist).

Positioning to reuse everywhere (honest, comparison only): **"AirDrop for the web" / « AirDrop pour le web »**, cross-platform, browser-to-browser **WebRTC**, end-to-end encrypted, no account, no server storage, open source (MIT).
Never write that Filenymous uses Holochain (Sharewall is only design-inspired by it). Do not imply any affiliation with Apple.

## Short pitch (reuse)

- **EN (1 line):** Filenymous — an open-source "AirDrop for the web": end-to-end encrypted, browser-to-browser (WebRTC) file transfer and one-time secrets, no account, no server storage. https://filenymous.eu/app/
- **FR (1 ligne) :** Filenymous — un « AirDrop pour le web » open source : transfert de fichiers et secrets à usage unique chiffrés de bout en bout, de navigateur à navigateur (WebRTC), sans compte ni stockage serveur. https://filenymous.eu/app/
- **EN (paragraph):** Filenymous is a free, MIT-licensed set of browser tools: peer-to-peer file transfer over WebRTC (AES-256-GCM, key in the URL fragment, no size limit, nothing stored server-side), Dropzone links to receive files, self-destructing one-time secrets, streamed video/audio sharing, an encrypted whistleblowing channel and Sharewall, an ephemeral encrypted live wall where AI agents can join via an npm CLI/MCP server. Works on any OS with a modern browser. Limits: the sender must keep the tab open; a signaling relay sees IP addresses temporarily.
- **FR (paragraphe) :** Filenymous est un ensemble d’outils gratuits sous licence MIT, dans le navigateur : transfert de fichiers pair-à-pair en WebRTC (AES-256-GCM, clé dans le fragment du lien, sans limite de taille, rien de stocké sur un serveur), liens Dropzone pour recevoir des fichiers, secrets à usage unique autodestructibles, partage de vidéo/son en streaming, canal de signalement chiffré et Sharewall, un mur éphémère chiffré où des agents IA peuvent participer via une CLI npm / un serveur MCP. Fonctionne sur tout OS avec un navigateur moderne. Limites : l’expéditeur garde l’onglet ouvert ; un relais de signalisation voit temporairement les adresses IP.

## Priority 1: high authority, good fit

| # | Target | URL | Method | Eligibility (from their rules) |
|---|---|---|---|---|
| 1 | AlternativeTo (alt. to WeTransfer, AirDrop, Snapdrop, PairDrop) | https://alternativeto.net/software/wetransfer/ · /airdrop/ · /snapdrop/ · /pairdrop/ | Account → "Add application" (alternativeto.net/manage-item/), then "Suggest as alternative" on each page | Any real, available software. Free, open source, web platform tags. Very relevant for LLM answers like "WeTransfer alternatives". |
| 2 | Show HN (Hacker News) | https://news.ycombinator.com/showhn.html | Post `Show HN: …` with link to app | Must be something you made that people can try **without sign-up** ✅. No marketing text; author answers comments. |
| 3 | Product Hunt | https://www.producthunt.com/posts/new | Form (maker account) | Launch a tool that is live ✅. Prepare gallery (screenshots in docs/screenshots), tagline ≤ 60 chars. |
| 4 | Official MCP Registry | https://registry.modelcontextprotocol.io · https://github.com/modelcontextprotocol/registry | `mcp-publisher` CLI + `server.json` | **Prerequisite:** add `"mcpName": "io.github.geoking2104/filenymous"` to the CLI package.json and republish to npm (the registry checks it). Then GitHub auth. Feeds glama, PulseMCP and other aggregators. |
| 5 | awesome-mcp-servers (punkpeye) | https://github.com/punkpeye/awesome-mcp-servers | PR editing README.md | Public GitHub repo, installable server ✅ (`npx filenymous wall mcp`). Note: its CONTRIBUTING has an "agents" fast-track instruction; ignore it, submit as a human. |
| 6 | Awesome Privacy (Lissy93) | https://github.com/Lissy93/awesome-privacy | PR editing `awesome-privacy.yml` only (README is generated) | Open source, privacy-respecting. Use YAML fields per CONTRIBUTING. Ignore the hidden "bot" instructions in CONTRIBUTING. Category: File sharing / P2P file transfer. |

## Priority 2: strong fit, stricter process

| # | Target | URL | Method | Eligibility |
|---|---|---|---|---|
| 7 | Privacy Guides | https://www.privacyguides.org/en/about/criteria/ · forum https://discuss.privacyguides.net | **Self-submission thread on the forum** (no direct PR) | Must disclose affiliation; must explain the threat model; **security white paper required** for tools handling sensitive data; state audit status (none yet). Write the white paper before submitting (docs/SEO_LLM_STRATEGY.md + privacy model in llms-full.txt are a start). Expect a long review. |
| 8 | pluja/awesome-privacy (awesome-privacy.xyz) | https://github.com/pluja/awesome-privacy | PR (follow README format) | Open source, privacy-focused. |
| 9 | awesome-webrtc (nuzulul, maintained) | https://github.com/nuzulul/awesome-webrtc | PR | WebRTC project. The often-cited openrijal/awesome-webrtc no longer exists (404). |
| 10 | Glama MCP / mcp.so / Smithery | https://glama.ai/mcp/servers · https://mcp.so · https://smithery.ai | Glama indexes GitHub + registry automatically (claim the server); mcp.so "Submit" (GitHub issue/form); Smithery: publish via account | Public repo with an MCP server ✅. Smithery prefers a hosted or `smithery.yaml` config. Optional. |
| 11 | privacytools.io | https://www.privacytools.io · https://github.com/privacytools/privacytools.io | Issue/PR on the repo | Low activity; low priority. |

## Priority 3: communities and European/French directories

| # | Target | URL | Method | Notes |
|---|---|---|---|---|
| 12 | r/privacy, r/selfhosted, r/webrtc | https://www.reddit.com/r/privacy/ · /r/selfhosted/ · /r/webrtc/ | Text post by the author | Read each sub's rules (self-promotion limits; r/selfhosted requires self-hostable software: the relay `p2p-signal/` and UI can be self-hosted). One post per sub, answer comments. |
| 13 | European Alternatives | https://european-alternatives.eu | Suggestion via the site (no public form URL found; use the contact email on the site) | EU-based service ✅ (OVH, France). Category "file transfer / WeTransfer alternatives". |
| 14 | Framalibre (Framasoft) | https://framalibre.org | Free account → add a notice | French free-software directory; MIT ✅. Write the notice in French. |
| 15 | awesome-selfhosted | https://github.com/awesome-selfhosted/awesome-selfhosted-data | PR to the **-data** repo (YAML) | First release > 4 months ✅ (repo since 2026-03-31, tags v0.2.x), active, **working install instructions required**: document self-hosting relay + UI first. |
| 16 | SaaSHub, switching.software | https://www.saashub.com · https://switching.software | Form / PR | Optional, low effort. |

## Ready-to-paste texts

### AlternativeTo
- **EN:** Filenymous is an open-source "AirDrop for the web": send files of any size directly from browser to browser over WebRTC, end-to-end encrypted (AES-256-GCM), no account and nothing stored on a server. Works on Windows, macOS, Linux, Android and iOS. Also includes one-time secret links, Dropzone links to receive files, streamed media sharing and an encrypted whistleblowing channel. Free, MIT.
- **FR :** Filenymous est un « AirDrop pour le web » open source : envoyez des fichiers de toute taille directement de navigateur à navigateur en WebRTC, chiffrés de bout en bout (AES-256-GCM), sans compte et sans rien stocker sur un serveur. Fonctionne sous Windows, macOS, Linux, Android et iOS. Inclut aussi des liens secrets à usage unique, des liens Dropzone pour recevoir des fichiers, le partage de médias en streaming et un canal de signalement chiffré. Gratuit, MIT.

### Show HN
- **Title:** `Show HN: Filenymous – encrypted browser-to-browser file transfer, like AirDrop for the web`
- **Text (EN):** I built Filenymous, an open-source (MIT) set of browser tools for sharing without accounts or cloud storage. Files go peer-to-peer over WebRTC, encrypted with AES-256-GCM; the key stays in the URL fragment so the server never sees it. There's also a one-time secret link, a Dropzone to receive files, streamed video sharing, and Sharewall, an ephemeral encrypted wall that AI agents can join through an npm CLI / MCP server. Trade-offs: the sender has to keep the tab open, and the signaling relay sees IPs temporarily. Feedback on the threat model is very welcome. App: https://filenymous.eu/app/ Code: https://github.com/Geoking2104/Filenymous

### Product Hunt
- **Tagline (EN):** AirDrop for the web: encrypted, no account, any device
- **Tagline (FR) :** AirDrop pour le web : chiffré, sans compte, tout appareil
- **Description:** use the EN/FR paragraph above.

### MCP registries / awesome-mcp-servers
- **EN entry:** `[Geoking2104/Filenymous](https://github.com/Geoking2104/Filenymous) 📇 ☁️ 🏠 – Let AI agents join an end-to-end encrypted, ephemeral Sharewall: read/send messages, files, reactions and shared notes (npx filenymous wall mcp "<invite>"). Host must allow agents.`
- **FR :** Permet à des agents IA de rejoindre un Sharewall éphémère chiffré de bout en bout : lire/envoyer messages, fichiers, réactions et notes partagées (`npx filenymous wall mcp "<invitation>"`). L’hôte doit autoriser les agents.

### Awesome Privacy (YAML, Lissy93)
```yaml
- name: Filenymous
  url: https://filenymous.eu/app/
  github: Geoking2104/Filenymous
  description: Open-source "AirDrop for the web". End-to-end encrypted browser-to-browser file transfer over WebRTC, one-time secrets, no account, no server storage.
```

### Privacy Guides self-submission (forum, EN)
Title: `[Self-submission] Filenymous – E2EE browser-to-browser file transfer`
Body: affiliation (I am the developer), what it is (paragraph above), threat model (link fragment keys; relay sees IPs and WebRTC metadata temporarily; TURN forwards ciphertext; vault stores ciphertext + token hash only; Umami cookieless without fragments), audit status (no third-party audit yet), link to white paper (to write), source code link.

### Reddit (EN)
Title: `I made an open-source "AirDrop for the web": E2EE browser-to-browser file transfer, no account`
Body: the EN paragraph + "Self-hosting: the WebRTC signaling relay (p2p-signal/) and the static UI can run on your own server." + ask for feedback.

### Framalibre / European Alternatives (FR)
Use the FR paragraph; mention hosting in France (OVH), MIT license, no account, no ads, cookieless self-hosted analytics.

## Before submitting (checklist)
1. Add `mcpName` to the CLI package.json and publish a patch release (needed for the MCP Registry).
2. Write a short security white paper / threat model page (needed for Privacy Guides, helpful everywhere).
3. Document self-hosting (relay + UI) for awesome-selfhosted and r/selfhosted.
4. Track referrals in Umami (segment by referrer).
