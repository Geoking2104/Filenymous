# Stratégie SEO & visibilité auprès des assistants IA (« GEO ») — Filenymous

*Rédigé le 17 octobre 2026. Périmètre : https://filenymous.eu/app/, la CLI npm `filenymous`, l'extension navigateur et le dépôt GitHub.*

Objectif : que Claude, ChatGPT, Gemini, Grok, Perplexity, Mistral (Le Chat), Copilot, etc. **comprennent** Filenymous, le **citent** avec des faits exacts et puissent, à terme, **utiliser** ses fonctions (MCP, API). Cela ne doit jamais compromettre le modèle de secret : les clés vivent dans le fragment d'URL (`#…`).

---

## 1. Audit de l'existant (17/10/2026)

| Point | Constat | Effet |
|---|---|---|
| `https://filenymous.eu/` | 301 → `https://filenymous.eu:443/app/` (le `:443` explicite figure dans `Location`) | Fonctionne, mais l'URL canonique est « sale ». À corriger dans le `.htaccess` racine. |
| `https://www.filenymous.eu/` | 301 → `https://www.filenymous.eu:443/app/`, et `www` sert aussi l'app (200) | **Contenu dupliqué** apex/www, sans canonical. |
| HTTP (port 80) | Non vérifiable depuis notre environnement (port 80 bloqué en sortie) | À contrôler : http → https en une seule redirection. |
| `/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/.well-known/security.txt`, `/favicon.ico` | **404** | Aucune consigne aux robots, aucun plan de site. |
| `/app/` vu par GPTBot, ClaudeBot, PerplexityBot, OAI-SearchBot, Googlebot, bingbot | 200, 3,5 Ko : `<div id="root"></div>` vide, `<title>Filenymous</title>`, description en anglais (« Files that fly private ») | **Aucun contenu lisible sans JavaScript.** La plupart des robots IA n'exécutent pas le JS : pour eux, la page est vide. |
| Routes | Tout se passe dans une SPA à routes par fragment (`#p2p:`, `#s:`, `#drop:`, `#report…`, `#secret-new`…) | Les fragments ne sont ni crawlés ni indexés, c'est voulu. Mais il n'existe **aucune page publique par fonctionnalité**. |
| Méta | Pas de canonical, hreflang, Open Graph, Twitter Card ni JSON-LD | Aperçus de partage pauvres ; aucune donnée structurée. |
| Langue | Un navigateur `en-US` / `en-GB` voyait l'interface **en français** (bug i18n) | Corrigé dans la PR #29, qui ajoute aussi `?lang=en|fr`. |
| Titre d'accueil | « Partagez en toute confiance, sans compte ni nuage. » / « Share with confidence, no account, no cloud. » déjà en place (`home.title`) | OK. Il est maintenant aussi présent dans le HTML statique. |
| Hébergement | OVH mutualisé (Apache), fichiers statiques. `/app/` est déployé par `deploy-ovh-ui.yml` (SFTP, sauvegarde par fichier). La racine contient un `.htaccess` (403 en lecture) qui fait la redirection | On peut déposer des fichiers statiques à la racine, sans toucher au `.htaccess`. |
| Mesure | Umami auto-hébergé (www.opendpe.net/umami), chemin seul, sans fragment ni query string | Permet de mesurer les visites venant des assistants IA (référents), voir §5. |
| GitHub | Description « peer to peer file transfer », pas de site web, aucun *topic*, 0 étoile | Faible signal d'autorité ; page souvent lue par les LLM. |
| npm `filenymous` 0.3.0 | Description correcte, `homepage` = README GitHub, mots-clés limités | `homepage` devrait pointer vers la page CLI du site. |
| Wikidata / Wikipédia / annuaires | Aucune présence connue | Signal tiers absent ; c'est aujourd'hui le plus gros manque pour être *cité*. |

### Ce que disent les sources (2025-2026)

- **Google** (« Optimizing your website for generative AI features », mai 2026) : aucun fichier spécial n'est requis pour AI Overviews et AI Mode. Ce qui compte : un contenu utile et unique, crawlable et indexable, idéalement rendu côté serveur ou statique. Les données structurées n'aident que pour les résultats enrichis éligibles. **FAQPage** n'affiche plus de résultat enrichi pour la plupart des sites, et **HowTo** est abandonné. On les garde comme description structurée, sans en attendre de résultat enrichi.
- **llms.txt** (llmstxt.org v2, août 2026) : proposition individuelle, pas un standard. Environ 9 % des 1 000 premiers sites en publient un, mais 97 % de ces fichiers ne reçoivent aucune visite (Ahrefs, juin 2026), et aucun grand assistant n'en a confirmé l'usage. Les agents de code (Claude Code, Cursor…) le lisent parfois. **Coût quasi nul, gain incertain** : on le publie, court et à jour, sans stratégie qui en dépende. Pour llms-full.txt (convention sans spécification), on reste sous ~60 Ko.
- **Robots IA**, jetons documentés par les éditeurs :
  - OpenAI : `GPTBot` (entraînement), `OAI-SearchBot` (recherche ChatGPT), `ChatGPT-User` (à la demande d'un utilisateur).
  - Anthropic : `ClaudeBot`, `Claude-SearchBot`, `Claude-User`.
  - Perplexity : `PerplexityBot`, `Perplexity-User` (ce dernier ignore généralement robots.txt).
  - Google : `Google-Extended` est un jeton de contrôle (entraînement et ancrage Gemini), pas un robot.
  - Apple : `Applebot` et `Applebot-Extended`.
  - Mistral : `MistralAI-User`.
  - xAI : **n'a publié aucun jeton**. Les registres signalent `GrokBot` et `xAI-SearchBot` ; on les nomme quand même.
- **Bing / Copilot / ChatGPT** :
  - Bing Webmaster Tools propose un rapport *AI Performance* (citations dans Copilot et les réponses IA de Bing).
  - IndexNow accélère la découverte des pages par Bing.
  - OpenAI ne confirme pas utiliser Bing pour ChatGPT Search, mais Bing reste une source importante des moteurs de réponse.
- **MCP** :
  - Registre officiel (`registry.modelcontextprotocol.io`, en préversion) avec `server.json`, en paquet npm ou en serveur distant « streamable-http ».
  - Découverte HTTP en brouillon (SEP-2127) : `/.well-known/mcp-server-card`.

---

## 2. Principes non négociables (secret et honnêteté)

1. **Aucun fragment, aucune clé, aucun code dans une URL publique**, que ce soit dans le sitemap, llms.txt, le JSON-LD, les exemples ou les logs. Les formats de liens sont documentés sous forme de **motifs** (`#s:<id>/<clé>`), jamais avec des valeurs. Les tests unitaires vérifient l'absence de `#` et `?` dans le sitemap.
2. Les seuls liens à fragment qu'un agent peut générer en toute sécurité sont les **points d'entrée sans secret** : `#drop-new`, `#secret-new`, `#report-new`.
3. **Un secret créé par un LLM n'est pas un secret vis-à-vis du fournisseur du LLM.** Si un assistant appelle `create_one_time_secret`, le texte en clair passe par le modèle, par les journaux de l'hébergeur de l'assistant et éventuellement par le client MCP. On l'écrit partout : llms.txt, FAQ, description des outils MCP. Pour un vrai secret, l'utilisateur crée le lien lui-même dans son navigateur.
4. Les pages de secret et de signalement ne sont jamais mesurées (garde Umami existant) ni indexées : elles n'existent que derrière un fragment.
5. Uniquement des faits vérifiés dans le code (algorithmes, limites, TTL). Aucune promesse de conformité : « conçu en pensant à » la directive lanceurs d'alerte et à Sapin II, « pas une certification ».
6. On autorise les robots d'entraînement (`GPTBot`, `ClaudeBot`, `Google-Extended`, `Applebot-Extended`, `CCBot`). C'est un **choix éditorial** : un logiciel libre gagne à être connu des modèles. On peut revenir dessus à tout moment avec un `Disallow`, sans effet sur Google ou Bing.

---

## 3. Plan priorisé

### 3.1 Quick wins (PR « SEO/LLM quick wins », prête)

| # | Action | Détail |
|---|---|---|
| Q1 | **Contenu statique crawlable dans `/app/`** | Le plugin Vite `ui/seo/vite-plugin.mjs` injecte dans `#root` le titre, le sous-titre, les 7 services avec liens et une FAQ courte. React remplace ce contenu au montage : le rendu de l'app ne change pas. |
| Q2 | **14 pages statiques par fonctionnalité** (FR + EN) + FAQ FR/EN + accueil EN `/app/en/` | `/app/fonctionnalites/<slug>/` et `/app/en/features/<slug>/` : transfert direct, Dropzone, secret à usage unique, partage streamé, canal de signalement, CLI npm, extension. Chaque page contient : faits, limites honnêtes, mode d'emploi, CTA vers l'app. HTML pur, lisible sans JS. |
| Q3 | Méta | `<title>` et description en FR, canonical, hreflang fr/en/x-default, Open Graph et Twitter Card avec image 1200×630 (`/app/og/filenymous-og.png`). |
| Q4 | JSON-LD | `WebApplication` (gratuit, MIT, featureList, codeRepository), `FAQPage`, `SoftwareApplication` pour la CLI, `WebPage` + `HowTo` par fonctionnalité. |
| Q5 | `robots.txt` racine | `Allow: /` pour tous, groupe explicite pour les robots IA, lien vers le sitemap. |
| Q6 | `sitemap.xml` racine | 18 URL, avec alternates hreflang réciproques, sans fragment ni query string. |
| Q7 | `llms.txt` + `llms-full.txt` | À la racine et sous `/app/`. Résumé, faits clés, avertissements de secret, points d'entrée, motifs de liens, CLI. Lien `rel="alternate" type="text/markdown"` dans le `<head>`. |
| Q8 | Mesure | Le même snippet Umami garde-fou sur les pages statiques, pour mesurer les arrivées IA par page. |
| Q9 | Déploiement | `deploy-ovh-ui.yml` dépose aussi les 4 fichiers racine (`ui/dist-root/`) en mode `--merge`, avec sauvegarde par fichier. Le `.htaccess` racine et `app/` ne sont pas touchés. |
| Q10 | i18n (PR #29) | `en-*` → anglais, `?lang=`, `<html lang>` correct. |

Tout est généré depuis une **source unique** (`ui/seo/content.mjs`) : on modifie un texte une fois, et il se met à jour dans les pages, le sitemap, llms.txt et le JSON-LD.

### 3.2 Moyen terme (1 à 3 mois)

1. **Comptes moteurs** (nécessite l'utilisateur) :
   - Google Search Console : propriété de domaine `filenymous.eu`, vérifiée par un enregistrement DNS TXT chez OVH. Soumettre le sitemap.
   - Bing Webmaster Tools : import depuis GSC, soumettre le sitemap, suivre le rapport *AI Performance*.
   - IndexNow : clé `/<clé>.txt` à la racine, puis ping à chaque déploiement. Il faudra ajouter une étape au workflow avec la clé en secret GitHub.
2. **`.htaccess` racine** (nécessite d'y avoir accès ; il faut d'abord récupérer son contenu actuel) :
   - `www` → apex en 301 ;
   - `Location` sans `:443` ;
   - `http` → `https` en un seul saut ;
   - `/app` → `/app/` ;
   - en-têtes `X-Content-Type-Options` et `Referrer-Policy: no-referrer`. Le fragment n'est jamais envoyé en référent, mais un en-tête explicite évite de faire fuiter le chemin vers des sites tiers.
3. **Métadonnées des dépôts** (changements visibles, à valider) :
   - GitHub : description « Partage chiffré de bout en bout, pair-à-pair, dans le navigateur : fichiers, secrets à usage unique, canal de signalement. Sans compte, sans stockage. » ; site `https://filenymous.eu/app/` ; topics `p2p`, `webrtc`, `e2ee`, `file-sharing`, `whistleblowing`, `one-time-secret`, `privacy`, `cli`.
   - npm : `homepage` → `https://filenymous.eu/app/fonctionnalites/cli-npm/`, mots-clés supplémentaires (`file-sharing`, `encryption`, `wetransfer-alternative`), publiée avec la prochaine version de la CLI.
   - README : un paragraphe d'ouverture factuel et des liens vers les pages de fonctionnalités.
4. **OpenAPI du coffre** (`docs/openapi-vault.yaml`, ajouté dans cette PR). Ensuite, le publier à `https://www.opendpe.net/filenymous-signal/openapi.json` et le référencer dans llms.txt.
5. **Page « Sécurité et modèle de menace »** (FR/EN) : ce que voit chaque serveur (signalisation, TURN, coffre, signalement, Umami), algorithmes, limites. C'est le contenu que les LLM citent le plus volontiers, parce qu'il est factuel et unique.
6. **Comparatif honnête** : catégories « transfert via cloud » (stockage temporaire côté serveur), « pair-à-pair direct », « secret à usage unique ». Critères mesurables : stockage, compte, taille, chiffrement, open source. Les concurrents ne sont nommés qu'avec des faits sourcés et datés.
7. **`/.well-known/security.txt`** (contact, politique de divulgation) : signal de sérieux pour un outil de sécurité.
8. **Contrôle des pages** : Lighthouse SEO, validateur Schema.org, Rich Results Test sur `/app/` et une page de fonctionnalité, après déploiement.

### 3.3 Long terme (3 à 12 mois) : usage natif par les agents

#### a) Serveur MCP `filenymous-mcp` (spécification, **ne pas publier tant que ce n'est pas validé**)

- **Distribution** :
  - paquet npm `filenymous-mcp` (transport stdio) qui réutilise le code de la CLI (`cli/src`) : même protocole, même chiffrement ;
  - puis `server.json` dans le registre MCP officiel (espace de noms `io.github.geoking2104/filenymous`) ;
  - un serveur MCP distant (streamable-http) n'est **pas** recommandé pour `share_file`, qui doit tourner près des fichiers ;
  - optionnellement un serveur distant limité au coffre, avec un *server card* à `/.well-known/mcp-server-card` (SEP-2127, brouillon).
- **Outils** :

| Outil | Entrée | Sortie | Notes de confidentialité |
|---|---|---|---|
| `create_one_time_secret` | `text` (≤ 64 Kio), `ttl_seconds` (60 à 604 800), `read_once` (bool), `password?` | `link` (`…#s:<id>/<clé>`), `expires_at` | Chiffrement AES-256-GCM, HKDF et PBKDF2 **dans le processus MCP** ; le serveur du coffre ne voit que du chiffré. **Le texte en clair passe par le LLM** : la description de l'outil doit le dire. Le lien retourné est un secret : ne pas le journaliser, le remettre uniquement au destinataire. |
| `share_file` | `paths[]`, `ttl`, `max_downloads`, `password?`, `stream?` | `link`, `code`, puis notifications de progression | Le processus reste actif jusqu'à la fin des téléchargements ou du TTL, comme `filenymous upload`. Le contenu des fichiers ne passe **pas** par le LLM, seul le lien y passe. |
| `receive_file` | `link_or_code`, `output_dir`, `password?` | chemins écrits | Écrit uniquement dans `output_dir`, sans jamais écraser un fichier existant. |
| `share_status` / `stop_share` | `share_id` | état | Permet d'arrêter un partage. |
| `open_dropzone_link` | rien | `https://filenymous.eu/app/#drop-new` | Ne crée rien : renvoie le point d'entrée. |

- **Garde-fous** :
  - confirmation explicite de l'utilisateur avant `share_file` et `create_one_time_secret` (*elicitation* MCP) ;
  - `--webhook-no-link` par défaut ;
  - liste de dossiers autorisés pour `paths` ;
  - aucun envoi de télémétrie.
- **Tests** : interopérabilité CLI ↔ web existante, plus un test MCP de bout en bout (client MCP → lien → ouverture dans Playwright).

#### b) API et découverte

- OpenAPI du coffre publiée, avec un exemple de chiffrement client (pseudo-code). L'API ne doit **jamais** recevoir de texte en clair.
- `/.well-known/` : `security.txt` d'abord ; `mcp-server-card` seulement si un serveur MCP distant existe. Il n'existe pas de standard largement adopté pour un « ai-plugin » ; on évite les fichiers spéculatifs.

#### c) Liens profonds que les LLM peuvent générer (documentés dans llms.txt)

- `https://filenymous.eu/app/` : envoyer des fichiers ; `?lang=en|fr` pour la langue.
- `…/app/#drop-new`, `…/app/#secret-new`, `…/app/#report-new`.
- Saisie d'un code reçu (`123-456-ABC`) sur l'accueil.
- **Interdit** : composer ou compléter des liens `#p2p:`, `#s:`, `#drop:`, `#report:`.
- Pas de schéma d'URL natif (`filenymous://`) pour l'instant : l'extension pourrait en enregistrer un plus tard.

#### d) Présence tierce (ce que les LLM utilisent le plus pour *citer*)

| Canal | Action | Qui |
|---|---|---|
| Wikidata | Élément « Filenymous » : logiciel libre, licence MIT, site officiel, dépôt, langages. Pas d'article Wikipédia tant qu'il n'y a pas de sources secondaires indépendantes (critères de notoriété). | Utilisateur (compte Wikidata) |
| AlternativeTo | Fiche « alternative à WeTransfer / Snapdrop / OneTimeSecret / SecureDrop », avec des faits exacts | Utilisateur |
| Product Hunt | Lancement préparé : visuels, première phrase factuelle | Utilisateur |
| Hacker News (Show HN), Reddit (r/privacy, r/selfhosted, r/opensource, r/webdev) | Publication honnête et technique (modèle de menace, limites). Pas de publications automatisées ni répétées. | Utilisateur |
| Chrome Web Store, addons.mozilla.org | Publier l'extension : très bon signal, et ce sont des pages que les LLM connaissent | Utilisateur (comptes développeur) |
| awesome-lists GitHub (awesome-privacy, awesome-selfhosted si auto-hébergeable, awesome-webrtc) | PR d'ajout | Utilisateur ou agent, après validation |
| Annuaires de serveurs MCP (registre officiel, Smithery, Glama, mcp.so) | Une fois `filenymous-mcp` publié | Utilisateur |

---

## 4. Gains attendus et risques

- **Gain probable** : les pages statiques et le JSON-LD rendent Filenymous *lisible* pour les robots sans JS (ChatGPT-User, Claude-User, Perplexity-User, MistralAI-User) qui ouvrent une URL quand un utilisateur pose une question. Aujourd'hui, ils voient une page vide.
- **Gain incertain** : llms.txt et llms-full.txt. Coût nul, on les maintient avec le contenu.
- **Gain fort mais lent** : citations tierces (Wikidata, annuaires, discussions), indexation Bing et Google, puis MCP pour l'usage natif.
- **Risques** :
  - contenu statique visible quelques millisecondes avant le montage de React : accepté, c'est le même contenu ;
  - contenu dupliqué www/apex tant que le `.htaccess` n'est pas corrigé : le canonical l'atténue ;
  - entraînement des modèles autorisé : choix réversible.

---

## 5. KPI et mesure

### 5.1 Arrivées depuis les assistants IA dans Umami

Umami enregistre le **domaine référent** sans paramètres. Dans le tableau de bord (https://www.opendpe.net/umami/ → filenymous.eu → *Referrers*), on suit en particulier :

| Assistant | Domaines référents |
|---|---|
| ChatGPT | `chatgpt.com`, `chat.openai.com` |
| Perplexity | `perplexity.ai`, `www.perplexity.ai` |
| Claude | `claude.ai` |
| Gemini | `gemini.google.com` (AI Overviews / AI Mode apparaissent comme `google.com`) |
| Grok | `grok.com`, `x.com` (lien depuis Grok sur X) |
| Copilot | `copilot.microsoft.com`, `bing.com` |
| Le Chat (Mistral) | `chat.mistral.ai` |
| Autres | `you.com`, `phind.com`, `kagi.com`, `duckduckgo.com` (DuckAssist) |

- **Comment faire** : *Filter* → *Referrer* → « contient » `chatgpt` (etc.). Enregistrer ce filtre en **segment** « Assistants IA » (OR sur les domaines ci-dessus) et le comparer au total des visites. Voir aussi la ventilation par page d'entrée (pages de fonctionnalités).
- **Limites** : beaucoup d'assistants ouvrent les liens sans référent (applis mobiles, `rel=noreferrer`), donc ces chiffres sont des minima. ChatGPT ajoute parfois `utm_source=chatgpt.com` ; nous **n'enregistrons pas** la query string (choix de confidentialité), donc ce signal n'est pas visible.
- **Optionnel** : une section « Grand public » dans le rapport mensuel, avec le nombre de visites venant d'assistants et les pages d'entrée.

### 5.2 Autres indicateurs

| KPI | Source | Cible à 3 mois |
|---|---|---|
| Pages indexées (18 URL) | Search Console, Bing WMT | ≥ 15 |
| Citations IA | Bing WMT *AI Performance* | > 0, puis en hausse |
| Visites venant d'assistants IA | Umami (segment §5.1) | Tendance mensuelle en hausse |
| Visites de robots IA | Logs Apache OVH (statistiques OVH) | Visites de `OAI-SearchBot`, `Claude-SearchBot`, `PerplexityBot` constatées |
| Exactitude | Panel de questions mensuel posé à 5 assistants : « Qu'est-ce que Filenymous ? », « Comment envoyer un mot de passe une seule fois sans compte ? », « Alternative chiffrée à WeTransfer sans stockage ? » | Faits corrects (pas de « stocke vos fichiers »), lien vers filenymous.eu |
| Téléchargements npm `filenymous` | npm | Tendance |
| Étoiles et forks GitHub | GitHub | Tendance |

---

## 6. Ce qui nécessite l'utilisateur

1. **Relire et fusionner** les PR #29 (langue) et « SEO/LLM quick wins », puis lancer `deploy-ovh-ui.yml` sur `main`. Le workflow dépose aussi `robots.txt`, `sitemap.xml`, `llms.txt` et `llms-full.txt` à la racine, avec sauvegarde.
2. **Google Search Console** : créer la propriété de domaine (enregistrement TXT dans la zone DNS OVH de `filenymous.eu`) et soumettre `https://filenymous.eu/sitemap.xml`.
3. **Bing Webmaster Tools** : importer depuis GSC, soumettre le sitemap. Plus tard, une clé **IndexNow** à stocker en secret GitHub.
4. **`.htaccess` racine** (www → apex, `:443`, http → https) : il faut son contenu actuel avant toute modification.
5. **Métadonnées GitHub et npm** (§3.2-3) : changements visibles publiquement, à valider.
6. **Annuaires et communautés** (§3.3-d) : comptes et publications sous son nom.
7. **Extension** : comptes développeur Chrome Web Store (5 $) et AMO.
8. **Feu vert pour le MCP** : choix entre `share_file` seul ou avec le secret, et validation du texte d'avertissement.

---

## 7. Annexes

- Source des textes : `ui/seo/content.mjs`. Rendu : `ui/seo/render.mjs`. Plugin : `ui/seo/vite-plugin.mjs`. Tests : `ui/src/seo.test.ts`, `ui/e2e/seo-prerender.spec.ts`.
- Spécification OpenAPI du coffre : `docs/openapi-vault.yaml`.
- Robots nommés dans `robots.txt` : voir `AI_AGENTS` dans `ui/seo/render.mjs`.
- Références :
  - [developers.openai.com/api/docs/bots](https://developers.openai.com/api/docs/bots)
  - [docs.perplexity.ai](https://docs.perplexity.ai/docs/resources/perplexity-crawlers)
  - [docs.mistral.ai/robots](https://docs.mistral.ai/robots)
  - [Cloudflare AI bot reference](https://developers.cloudflare.com/ai-crawl-control/reference/bots/)
  - [llmstxt.org](https://llmstxt.org/)
  - [Google AI optimization guide](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide)
  - [Bing AI Performance](https://blogs.bing.com/webmaster/2026/2/Introducing-AI-Performance-in-Bing-Webmaster-Tools-Public-Preview/)
  - [MCP Registry](https://modelcontextprotocol.io/registry/about)
  - [SEP-2127 Server Cards](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/sep/mcp-server-cards/seps/2127-mcp-server-cards.md)
