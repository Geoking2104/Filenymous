# Plan d'implémentation : Dropzone, Secrets Vault, extension Chrome et API/CLI

Ce plan découle du cahier des charges (CDCF) « Modules Dropzone & Secrets Vault + Extension Chrome & API ». Il s'appuie sur le code actuel du dépôt :

- `ui/` : application React + Vite, build statique hébergé sur OVH (mutualisé, sans exécution côté serveur) ;
- `ui/src/p2p/` : transfert direct WebRTC (`protocol.ts` v2, `session.ts` avec `P2PSender`/`P2PReceiver`, `signal.ts`, `config.ts`, `sink.ts`, panneaux `P2PSendPanel.tsx` / `P2PReceivePanel.tsx`) ;
- `p2p-signal/server.js` : relais de signalisation WebSocket sur le VPS (salles à code unique `join`/`signal`/`leave`, salles multi-pairs `room-*`, `GET /ice`, `GET /health`, TTL `ROOM_TTL_MS`, limites de débit, `MAX_ROOM_PEERS`) ;
- `ui/e2e/` : tests Playwright (dont `p2p-direct.spec.ts` qui démarre un relais local) ; tests unitaires Vitest (`protocol.test.ts`, etc.).

## Principes directeurs (rappel)

1. **Zéro inscription** pour tous les usages.
2. **Moins de 3 clics** pour chaque parcours principal.
3. **Zero-knowledge** : chiffrement et déchiffrement côté client via `crypto.subtle` ; aucun serveur ne voit le clair ni les clés (les clés restent dans le fragment `#` de l'URL).
4. **API documentées** (OpenAPI) pour l'extension, la CLI et les intégrations tierces.

## Décision d'architecture (validée)

| Module | Stockage serveur | Transport |
|---|---|---|
| A. Dropzone | **Aucun fichier stocké** : 100 % P2P | WebRTC DataChannel + protocole de blocs AES-GCM existant, signalisation via `p2p-signal` |
| B. Secrets Vault | Chiffré uniquement, éphémère (Redis sur le VPS, à côté de `p2p-signal`) | HTTPS |
| C. Extension / API / CLI | Aucun nouveau stockage (réutilise A et B) | HTTPS + WebSocket |

Contrainte OVH : le site statique ne peut ni exécuter de code ni stocker de données. Toute logique serveur (API secrets, jetons d'API) va donc sur le VPS, derrière nginx (`p2p-signal/nginx-opendpe-location.conf`). Le site statique se contente d'appeler `https://<vps>/api/v1/...` (CORS restreint via `ALLOWED_ORIGIN`).

---

## Phase 0 : socle commun (1 à 2 jours)

**Objectif** : factoriser ce qui sera partagé par la Dropzone et le Vault.

- `ui/src/p2p/unloadGuard.ts` (nouveau) : un hook `useUnloadGuard(active: boolean, message: string)` qui pose et retire un écouteur `beforeunload` (`event.preventDefault(); event.returnValue = message`). Il remplace les écouteurs ad hoc déjà présents dans `P2PSendPanel.tsx` (l. ~34) et `P2PReceivePanel.tsx` (l. ~35). Le hook gère un compteur de raisons actives pour que plusieurs transferts simultanés ne se marchent pas dessus.
- `ui/src/crypto/fragment.ts` (nouveau) : extraire de `protocol.ts` `b64urlEncode`/`b64urlDecode`, la génération de secret aléatoire de 32 octets et le parsing générique de fragments `#<type>:<id>/<secret>`.
- Routage : `App.tsx` reconnaît déjà `#p2p:` ; ajouter `#drop:` et `#s:` ainsi que les chemins `/drop/<slug>` et `/s/` (réécriture vers `index.html` via `.htaccess` sur OVH, déjà nécessaire pour le SPA).
- i18n : nouvelles clés dans `ui/src/i18n/locales/{fr,en}` sous `dropzone.*`, `vault.*`, `unloadGuard.*` ; lancer `npm run i18n`.
- Tests : Vitest pour `fragment.ts` (aller-retour encodage, rejet des fragments malformés) et pour `useUnloadGuard` (ajout/retrait d'écouteur, compteur).

---

## Phase 1 : Module A, Dropzone 100 % P2P (5 à 7 jours)

### A.1 Modèle

L'onglet du **propriétaire** joue le rôle de récepteur permanent. Chaque **contributeur** est un émetteur. C'est l'inverse du transfert direct actuel, où l'émetteur attend et le destinataire se connecte. Aucun fichier ne transite ni ne reste sur un serveur ; le relais ne voit que du SDP/ICE.

### A.2 Format du lien de dépôt

```
https://filenymous.eu/drop/<slug>#drop:<roomId>/<secret>[/<expiry>]
```

- `<slug>` : nom de projet lisible (facultatif, purement cosmétique, ex. `mon-projet`), jamais utilisé comme secret.
- `<roomId>` : `room-<16 car. base32>` aléatoire, compatible avec `validateRoomId` dans `server.js`.
- `<secret>` : 32 octets en base64url, **uniquement dans le fragment** (ni l'hébergeur OVH ni le relais ne le voient). Clé maîtresse : HKDF-SHA256(secret, info=`filenymous-drop-v1`) → clé AES-256-GCM, avec une sous-clé par contributeur (HKDF avec `info = contributorId`).
- `<expiry>` : horodatage Unix facultatif, inclus dans l'AAD du handshake pour que le contributeur ne puisse pas le modifier.
- Mot de passe facultatif : il n'est pas dans le lien. On réutilise le mécanisme `wrappedSecret` de `protocol.ts` : le propriétaire envoie au contributeur un défi chiffré avec une clé PBKDF2(mot de passe, sel = roomId) ; le contributeur doit le déchiffrer et le renvoyer avant que le propriétaire n'accepte des blocs. Comme le secret du lien seul ne suffit pas, la fuite du lien ne permet pas de déposer.

### A.3 Signalisation (`p2p-signal/server.js`)

On réutilise les salles multi-pairs `room-join` / `room-event` / `room-leave` (déjà limitées par `MAX_ROOM_PEERS`), avec les ajouts suivants :

- un rôle `owner` dans `room-join`, avec un seul owner par salle ; un second owner est refusé (`error: owner-exists`) ;
- les messages `signal` sont adressés de pair à pair (`to: peerId`) entre owner et contributeur ; un contributeur ne voit jamais les autres contributeurs (filtrage côté serveur de `peer-joined`/`peer-left`, envoyés uniquement à l'owner) ;
- un événement `owner-offline` est diffusé aux contributeurs quand l'owner quitte la salle ou que son ping expire ; un contributeur qui rejoint une salle sans owner reçoit immédiatement `owner-offline` ;
- un TTL de salle propre aux dropzones : `DROP_ROOM_TTL_MS` (par défaut 24 h, plafonné par l'expiration choisie et transmise en clair par l'owner dans `room-join`). Le serveur ferme la salle à échéance (`room-close`). L'expiration est **aussi** vérifiée côté client, puisque le contributeur refuse un lien expiré avant toute connexion ;
- des limites de débit existantes, plus un plafond de contributeurs simultanés par salle (`MAX_DROP_CONTRIBUTORS`, par défaut 8).

### A.4 Protocole de données

On réutilise `P2P_CHUNK_SIZE`, le cadrage `FRAME_HEADER_BYTES` et le chiffrement par bloc (IV = fileIndex ‖ chunkIndex, en-tête en AAD) de `protocol.ts`. Les nouveaux messages de contrôle (`P2PControl`) sont :

- `hello-drop { v, contributorId, expiry }` (contributeur → owner) ;
- `pw-challenge` / `pw-response`, seulement si un mot de passe est défini ;
- `manifest` (existant, sens contributeur → owner) ;
- `file-end`, `done` (existants) ;
- `receipt { files: [{index, sha256}] }` (owner → contributeur) : confirmation que tout est écrit sur le disque de l'owner, sha256 calculé à la volée côté owner et comparé à celui que le contributeur annonce dans `manifest`.

Plusieurs contributeurs sont gérés par une `RTCPeerConnection` et une sous-clé chacun. L'owner gère N sessions en parallèle (limite configurable, puis file d'attente).

### A.5 Code UI

- `ui/src/p2p/dropzone/DropOwner.ts` : classe `DropOwner` (sur le modèle de `P2PReceiver`), qui gère plusieurs sessions et écrit via `sink.ts` (File System Access API si disponible, sinon téléchargement en blob par fichier).
- `ui/src/p2p/dropzone/DropContributor.ts` : classe `DropContributor` (sur le modèle de `P2PSender`), avec lecture en flux pour ne jamais charger les fichiers entièrement en mémoire.
- `ui/src/p2p/dropzone/DropCreatePanel.tsx` : formulaire (nom du projet, expiration, mot de passe), génération du lien, bouton copier et QR (`qrferry`). La création se fait en 1 clic, ou 3 avec les options.
- `ui/src/p2p/dropzone/DropOwnerPanel.tsx` : liste des contributions en cours et terminées, avec progression par contributeur. Un **avertissement permanent et visible** indique : « Gardez cet onglet ouvert : les fichiers arrivent directement sur votre appareil. Si vous le fermez, les contributeurs verront "propriétaire hors ligne". » Il est complété par un badge d'état de connexion au relais et une demande facultative `Notification` à l'arrivée d'un fichier.
- `ui/src/p2p/dropzone/DropContributorPanel.tsx` : zone de glisser-déposer avec barre de progression par fichier, sans aucune liste des fichiers des autres. Si l'owner est hors ligne, le message « Propriétaire hors ligne : réessayez plus tard ou contactez-le » s'affiche, puis le panneau se reconnecte automatiquement quand l'owner revient. À la fin, le message « Vos fichiers ont été transmis au propriétaire » s'affiche, **seulement après le `receipt`**.

### A.6 Garde anti-fermeture d'onglet

- **Côté owner** : `useUnloadGuard(true)` dès qu'au moins un transfert de contributeur est en cours (entre `hello-drop` et l'envoi du `receipt`) **et jusqu'à ce que le contributeur ait accusé réception du `receipt`**, c'est-à-dire jusqu'à la fin complète de l'autre côté. Hors transfert, l'avertissement visuel reste affiché, mais il n'y a pas de boîte de dialogue bloquante.
- **Côté contributeur** : garde active de la sélection des fichiers jusqu'à la réception du `receipt` de l'owner.
- `visibilitychange` / `pagehide` : sur mobile, où `beforeunload` n'est pas fiable, on affiche un bandeau « transfert en cours, ne quittez pas l'application » et on envoie `cancel` proprement si la page est réellement déchargée.
- Le texte personnalisé de `beforeunload` est ignoré par les navigateurs modernes, d'où l'importance de l'avertissement dans l'interface.

### A.7 Tests

- Vitest : dérivation des sous-clés, validation du lien et de l'expiration, machine à états `DropOwner` (pairs simulés), refus en cas de mauvais mot de passe, isolation (un contributeur ne reçoit aucun événement sur les autres).
- `p2p-signal` : tests `node --test` pour le rôle owner unique, le filtrage des événements, `owner-offline` et l'expiration de salle.
- Playwright (`ui/e2e/dropzone.spec.ts`, avec le relais local comme dans `p2p-direct.spec.ts`) : 1 owner + 2 contributeurs en parallèle, contenus vérifiés côté owner ; owner hors ligne → message affiché ; mot de passe faux → refus ; lien expiré → refus ; présence de la garde `beforeunload` pendant le transfert (vérifiée via `page.on('dialog')`) et absence après le `receipt`.

---

## Phase 2 : Module B, Secrets Vault burn-after-reading (4 à 5 jours)

### B.1 Cryptographie (client)

- Clé aléatoire AES-GCM 256 générée par `crypto.subtle.generateKey`, IV de 12 octets.
- Mot de passe facultatif : clé finale = HKDF(clé_aléatoire ‖ PBKDF2(mot de passe, sel, 600 000 itérations, SHA-256)). Le sel est stocké avec le chiffré ; le mot de passe n'est jamais envoyé.
- Lien : `https://filenymous.eu/s/<id>#<clé base64url>`. L'`id` (128 bits aléatoires, généré par le serveur) n'a aucun lien avec la clé.

### B.2 Stockage serveur (VPS)

- Nouveau service `vault-api/` (Node, même style que `p2p-signal`, ou routes ajoutées à `server.js` si l'on préfère un seul processus) avec Redis local (`127.0.0.1`, `appendonly no`, `maxmemory` + `allkeys-lru` interdit → `noeviction`).
- Clé Redis `secret:<id>` → JSON `{ v:1, ct, iv, salt?, pw: bool, reads_left, created }`, avec `EXPIRE` = TTL choisi (5 min à 7 jours, 24 h par défaut).
- Lecture atomique : script Lua `GET` + `DECR reads_left` + `DEL` si 0, ou `GETDEL` pour 1 lecture, de sorte que deux lectures concurrentes ne peuvent pas aboutir toutes les deux.
- Taille max du chiffré : 64 Kio. Aucun log de corps ni d'IP au-delà du rate-limit en mémoire.

### B.3 Endpoints

| Méthode | Chemin | Corps / réponse |
|---|---|---|
| `POST` | `/api/v1/secrets` | `{ ct, iv, salt?, pw, ttl, reads }` → `201 { id, expiresAt }` |
| `GET` | `/api/v1/secrets/:id/meta` | `{ pw, expiresAt }` sans consommer de lecture (permet d'afficher « Révéler le secret » avant consommation, contre les robots d'aperçu de liens) |
| `POST` | `/api/v1/secrets/:id/reveal` | consomme : `{ ct, iv, salt? }` ou `404 { error: "gone" }` |

Comme la lecture est en `POST` après un clic explicite, les aperçus Slack ou Teams ne détruisent pas le secret.

### B.4 UI

- `ui/src/vault/VaultCreatePanel.tsx` : zone de texte, options (mot de passe, nombre de lectures, TTL), bouton « Créer le lien », copie automatique.
- `ui/src/vault/VaultRevealPanel.tsx` : bouton « Révéler », puis déchiffrement local, affichage et bouton copier. Après un rechargement ou une seconde visite, le message « Ce secret a déjà été lu ou a expiré » s'affiche.
- Nettoyage : la clé est retirée de l'URL après lecture (`history.replaceState`).

### B.5 Sécurité

- CSP stricte sur le site OVH (`.htaccess`) : `default-src 'self'; script-src 'self'; connect-src 'self' https://<vps> wss://<vps>; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`, plus `Referrer-Policy: no-referrer` pour que le fragment ne fuie pas.
- Côté VPS : HSTS, CORS limité à `ALLOWED_ORIGIN`, rate-limit par IP (création et révélation), body limit.

### B.6 Tests

- Vitest : chiffrement et déchiffrement aller-retour, avec et sans mot de passe, mauvais mot de passe → erreur.
- `vault-api` : `node --test` + Redis en conteneur pour vérifier l'atomicité (100 révélations concurrentes → exactement 1 succès), l'expiration et les limites de taille.
- Playwright : création → révélation → rechargement → message « déjà lu ».

---

## Phase 3 : API publique et jetons (2 à 3 jours)

- Jetons **en écriture seule** : `secrets:write`, `dropzone:write`. Format `fny_<base62 32>`, stocké hashé (SHA-256) dans Redis `token:<hash>` → `{ scopes, label, created }`. Émission par une commande d'administration sur le VPS (pas de comptes au départ, conformément au principe zéro inscription).
- `POST /api/v1/secrets` accepte `Authorization: Bearer` pour l'automatisation (le client chiffre toujours lui-même).
- `POST /api/v1/dropzone/:id/upload` : comme la Dropzone est 100 % P2P, l'API n'est **pas** un stockage. La CLI se comporte en contributeur WebRTC (voir phase 4). Cet endpoint sert seulement de pré-vol : il vérifie le jeton, indique si l'owner est en ligne et renvoie la config ICE. L'envoi par blocs suit ensuite le protocole de A.4. Ce point est à valider : il n'existe pas d'upload HTTP stockant sans renoncer au 100 % P2P.
- Documentation : `docs/api/openapi.yaml` + page `docs/API.md`.

## Phase 4 : CLI `filenymous` (3 à 4 jours)

- Paquet `cli/` (Node ≥ 20, `node-datachannel` ou `werift` pour WebRTC hors navigateur, Web Crypto natif).
- `filenymous secret create [--ttl 1h] [--reads 1] [--password] < fichier` affiche le lien.
- `filenymous upload archive.zip --dropzone=<lien complet>` : connexion au relais, handshake, envoi par blocs chiffrés, attente du `receipt`. Si l'owner est hors ligne, la CLI quitte avec le code 3 et le message « propriétaire hors ligne », ou attend avec `--wait`. Note : `--dropzone=mon-projet` seul ne suffit pas, car le secret est dans le fragment. On prévoit un alias local `~/.config/filenymous/dropzones.json` (nom → lien).
- Tests : vitest + e2e CLI ↔ navigateur Playwright avec le relais local.

## Phase 5 : extension Chrome (Manifest V3) (4 à 5 jours)

- Dossier `extension/` : `manifest.json` (permissions `contextMenus`, `clipboardWrite`, `storage`, `activeTab` ; `host_permissions` limités au VPS).
- Popup avec deux onglets :
  - **Fichier** : envoi direct P2P. Une popup se ferme dès qu'on clique ailleurs, donc la sélection ouvre un onglet `filenymous.eu/#p2p...` qui porte le transfert et sa garde anti-fermeture.
  - **Secret** : réutilise le module crypto du Vault, avec copie automatique du lien.
- Menus contextuels : « Envoyer comme secret » (texte sélectionné), « Partager ce lien en secret » (lien) et « Envoyer cette image » (image : téléchargement puis onglet d'envoi).
- Le code crypto est partagé avec `ui/src` via un paquet interne `packages/core` (protocol, fragment, vault-crypto), qui exige un workspace npm.
- Tests : Vitest pour le service worker, Playwright avec `--load-extension`.

## Phase 6 : déploiement

- **OVH (statique)** : build `ui/` comme aujourd'hui (`deploy-ui.ps1`), avec en plus `.htaccess` (CSP, réécritures `/drop/*` et `/s/*` → `index.html`).
- **VPS** : mise à jour de `p2p-signal` (rôle owner, `owner-offline`, `DROP_ROOM_TTL_MS`, `MAX_DROP_CONTRIBUTORS`) ; nouveau service systemd `filenymous-vault.service` + Redis ; bloc nginx `location /api/v1/` ; mise à jour de `docs/DEPLOYMENT.md`.
- **Chrome Web Store** : publication de l'extension, page de confidentialité.
- Observabilité : uniquement des compteurs agrégés (nombre de salles, de secrets créés), sans contenu ni identifiants.

## Synthèse des fichiers touchés

| Zone | Fichiers |
|---|---|
| UI commun | `ui/src/App.tsx`, `ui/src/p2p/unloadGuard.ts`, `ui/src/crypto/fragment.ts`, `ui/src/p2p/protocol.ts`, `ui/src/p2p/P2PSendPanel.tsx`, `ui/src/p2p/P2PReceivePanel.tsx`, `ui/src/i18n/locales/*` |
| Dropzone | `ui/src/p2p/dropzone/*`, `ui/src/p2p/signal.ts`, `p2p-signal/server.js`, `ui/e2e/dropzone.spec.ts` |
| Vault | `ui/src/vault/*`, `vault-api/*` (ou `p2p-signal/server.js`), `ui/e2e/vault.spec.ts` |
| API/CLI | `docs/api/openapi.yaml`, `docs/API.md`, `cli/*` |
| Extension | `extension/*`, `packages/core/*` |
| Déploiement | `ui/public/.htaccess`, `p2p-signal/*.service`, nginx, `docs/DEPLOYMENT.md` |

## Risques et points ouverts

- **Dropzone hors ligne** : c'est la conséquence assumée du 100 % P2P. Si le besoin d'asynchronisme devient fort, une option « relais chiffré temporaire » pourra être ajoutée plus tard, sur activation explicite.
- **Mobile** : un onglet en arrière-plan est suspendu par l'OS, d'où un avertissement spécifique côté owner mobile.
- **NAT stricts** : il faut un TURN (déjà prévu via `TURN_SECRET` dans `p2p-signal`), avec un coût de bande passante sur le VPS.
- **Gros volumes chez l'owner** : sans File System Access API (Firefox, Safari), les fichiers passent en mémoire. Il faut donc un avertissement au-delà d'environ 1 Go.
