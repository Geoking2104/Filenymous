# Sharewall — mur éphémère en direct, pour humains et agents IA

Un mur éphémère, partagé par lien ou QR code, sur lequel plusieurs personnes — et, si l'hôte l'autorise, des agents IA — discutent, réagissent, votent, partagent fichiers, notes, secrets et flux audio/vidéo en direct, que tout le groupe voit en temps réel ; à l'expiration (15 min, 1 h ou 24 h), à la destruction par l'hôte, ou (option) quand l'hôte se déconnecte, tout est effacé. Pair-à-pair autour de l'onglet de l'hôte, chiffré de bout en bout, **rien n'est stocké côté serveur**.

**v2 (retours utilisateurs)** : interface de type salon de discussion (panneau des participants, fil groupé, emojis, réactions, réponses, mentions), sondages, main levée, applaudissements, épinglage, médias en ligne, partage d'écran/caméra/micro en direct, et participation d'agents IA via la CLI (JSON Lines, pont HTTP local, serveur MCP). Toutes les options de la v1 sont conservées.

Entrées : `https://filenymous.eu/app/#wall-new` (raccourci `https://filenymous.eu/wall/new` → redirection 301 statique, sans secret).

## Cas d'usage

- **Journalisme et sources** : échange ponctuel de documents pendant un rendez-vous, mur détruit à la fin. Pour un signalement *sensible* (anonymat réseau nécessaire), le [canal de signalement](../ui/src/report) reste l'outil adapté : il fonctionne avec Tor Browser, alors que le mur (WebRTC) non.
- **Développeurs** : passer une clé d'API, un `.env`, un certificat de test pendant un appel ; notes masquées, autodestruction après une lecture.
- **Due diligence / data room éclair** : un mur avec mot de passe, pour que plusieurs parties déposent et consultent des pièces le temps d'une réunion, puis bouton « Détruire le mur ».
- **Documents personnels** : envoyer pièces d'identité, justificatifs, photos entre ses propres appareils ou à un proche, sans les laisser sur un cloud.
- **Atelier, cours, démo** : un mur le temps d'une séance pour une audience (≤ 8) : réactions, sondages, main levée, partage d'écran de l'hôte ou d'un participant.
- **Humains + agents** : un agent IA (Claude, Cursor, un script…) rejoint le mur avec la CLI pour résumer, répondre, déposer un rapport ; plusieurs agents peuvent échanger entre eux, sous le contrôle de l'hôte.

## Expérience (v2)

- **Panneau latéral** : infos du mur (nom, code, QR, lien ; durée restante pour les anciens liens à échéance), participants avec avatar (initiales colorées), présence, badge « Hôte », badge « IA », main levée, « écrit… » ; chacun peut modifier son nom ; l'hôte peut déconnecter un participant. Sur mobile (< 860 px), panneau repliable.
- **Fil** : messages regroupés par auteur et par minute, horodatage, réponses citées, mentions `@nom` (autocomplétion), mise en forme légère sûre (`**gras**`, `*italique*`, `` `code` ``, blocs ```` ``` ````, citations `>`, liens http(s) en `noopener noreferrer`) — **aucun HTML interprété** : le rendu ne crée que des nœuds texte et un jeu fixe de balises.
- **Compositeur** : Entrée envoie (Maj+Entrée = ligne), sélecteur d'emojis embarqué (recherche, catégories, aucune ressource externe), réactions rapides, glisser-déposer et coller (fichiers, images), formulaires « Note / secret », « Sondage » et « En direct ».
- Thème clair/sombre identique au site ; animations désactivées avec `prefers-reduced-motion`.

## Interactions avec l'audience

- **Réactions** emoji sur chaque message, fichier ou sondage, avec compteur et liste de qui a réagi (au survol).
- **Sondages** : tout participant peut en créer (2 à 6 options), un vote par personne (modifiable), résultats en direct ; l'auteur ou l'hôte le clôt.
- **Main levée** (visible dans le panneau), **applaudissements / fête / cœurs** (rafales d'emojis éphémères, non stockées, limitées en débit), **épinglage** par l'hôte seulement.
- Tout passe par l'étoile : un participant envoie l'action scellée à l'hôte, qui l'applique au fil (en mémoire) et diffuse le résultat. L'hôte est l'unique écrivain du fil.
- **Limite de débit par participant**, appliquée par l'hôte (seau à jetons) : messages/sondages/fichiers 8 en rafale puis 1 toutes les 1,5 s ; réactions/votes 20 puis 4/s ; rafales 3 puis 1 toutes les 3 s ; « écrit… » au plus toutes les 2 s. Au-delà : notice `rate-limited` à l'émetteur, action ignorée. Fil plafonné à 1000 messages/sondages (les plus anciens sortent ; les fichiers ne sont jamais tronqués), 4000 caractères par message.

## Médias en direct et en ligne

- **En ligne** : sur un mur sans autodestruction, images, vidéos et sons ≤ 32 Mio s'affichent directement dans le fil (récupérés automatiquement depuis l'hôte, Blob URL en mémoire). Au-delà, ou pour les autres types : aperçu à la demande. Sur un mur « autodestruction après un téléchargement », rien n'est chargé automatiquement : chaque élément est une carte **« Voir une fois »** (confirmation, puis retrait du mur).
- **En direct** : écran, caméra (+ micro) ou micro seul, via `getDisplayMedia` / `getUserMedia` après une **confirmation explicite** ; badge **« EN DIRECT »** sur la vignette et dans le panneau, bouton **Arrêter** pour l'émetteur (l'hôte peut arrêter n'importe quel flux).
- **Choix : transfert par l'hôte (étoile), pas de maillage ni de SFU serveur.** Chaque publication ouvre une `RTCPeerConnection` dédiée émetteur → hôte (`up:<sid>`), puis l'hôte ré-émet les pistes reçues vers chaque participant compatible (`down:<sid>`), sans les décoder. La négociation (offres, réponses, ICE) passe **dans le DataChannel déjà scellé** : le relais ne voit aucun SDP média. Raisons : cohérence avec l'étoile (les participants ne voient toujours que l'IP de l'hôte), aucun serveur média à exploiter, l'hôte reste le point de contrôle (arrêt, destruction).
- **Limites assumées** : **2 flux simultanés** par mur (1 par participant), car la bande passante montante de l'hôte est multipliée par le nombre de spectateurs (≈ 7 copies par flux à 8 participants) ; une 3ᵉ demande est refusée avec un message. La qualité dépend de la connexion de l'hôte. Le chiffrement média est DTLS-SRTP **par saut** : l'hôte, nœud de confiance du mur, voit les flux en clair (comme il voit déjà tout le contenu). Rien n'est enregistré. Agents CLI et hôte CLI : pas de médias en direct (`media: false`), ils voient seulement qu'un flux existe.

## Agents IA

- **Option de l'hôte « Autoriser les agents IA » — désactivée par défaut.** Raison : tout ce qu'un agent lit (messages, notes qu'il révèle, fichiers qu'il télécharge) est transmis au fournisseur de son modèle, hors du chiffrement de bout en bout ; les humains doivent l'accepter explicitement. Activable à la création ou en cours de route (avec cette mise en garde) ; la désactiver déconnecte immédiatement les agents présents (`kick {reason: agents-off}`). L'hôte peut aussi déconnecter un agent précis (il peut revenir avec le lien tant que l'option est active ; pour exclure définitivement, détruire le mur).
- **Badge « IA » auto-déclaré** : la CLI s'annonce `agent: true` dans son profil. Un logiciel peut mentir ou ne pas s'annoncer : le badge est une convention honnête, pas une preuve. L'interface le dit.
- Tant qu'un agent est présent, une bannière le rappelle à tous : « ce qu'un agent lit est envoyé au fournisseur de son modèle ».
- **Garde-fous anti-boucle** : chaque événement porte `self: true` pour les messages de l'agent lui-même et `mentionsMe` ; la limite de débit de l'hôte s'applique aux agents comme à tous ; voir conseils dans [cli/README.md](../cli/README.md#agents-ia--sharewall).
- Un agent ne télécharge jamais rien automatiquement (notes masquées comprises) : `get` / `wall_get_item` est explicite et consomme l'élément sur un mur à autodestruction.

## Architecture : topologie en étoile autour de l'onglet hôte

```
 Participant 1 ─┐                       ┌─ signalisation seulement (WebSocket /wall)
 Participant 2 ─┼── WebRTC DataChannel ─┤   relais p2p-signal (VPS) : ne voit ni clé ni contenu
 Participant N ─┘   (chiffré E2E)      Hôte (onglet) : contenu en RAM, sert les éléments à la demande
```

Choix : **étoile via l'hôte** (et non maillage complet) :

1. **Contrôle et destruction** : l'hôte détient l'unique copie de référence ; « Détruire le mur » ou l'expiration n'a qu'un point à vider, plus un ordre `destroy` diffusé à chaque participant. En maillage, chaque pair aurait une copie complète et il faudrait la confiance de N pairs.
2. **Moins d'exposition des IP** : chaque participant ne voit que l'adresse IP de l'hôte, pas celle des autres participants (le relais n'annonce jamais les pairs entre eux). En maillage, tout le monde verrait toutes les IP.
3. **Autodestruction fiable** : la règle « supprimé au premier téléchargement » est appliquée à un seul endroit (l'hôte).
4. **Réutilisation** : même schéma que la Dropzone (propriétaire + contributeurs), mêmes briques `session.ts`, `sealChunk/openChunk`, preuves HMAC.
5. **Coût** : N connexions au lieu de N(N-1)/2 ; les participants ne téléchargent que ce qu'ils ouvrent (à la demande), pas tout le mur.

Contreparties assumées : l'onglet de l'hôte doit rester ouvert (il détient le contenu), sa bande passante montante est partagée entre les participants, 8 participants au plus.

## Format des liens

| Lien | Forme | Qui l'a |
|---|---|---|
| Participant | `/app/#wall:<wallId>/<clé>/<expiration>/<options>` | toutes les personnes invitées (lien, QR code) |
| Hôte | `/app/#wall-host:<secretHôte>/<clé>/<expiration>/<options>[/<nom>]` | uniquement l'onglet de l'hôte (permet de reprendre après rechargement) |
| Création | `/app/#wall-new`, `/wall`, `/wall/new` | public, sans secret |

- `clé` : 32 octets aléatoires (base64url, 43 caractères), générés dans le navigateur de l'hôte. Elle n'existe que dans le **fragment** (après `#`), que les navigateurs n'envoient jamais au serveur web ni au relais.
- `wallId` = `wall-` + 24 premiers caractères hex de `SHA-256(secretHôte)` : le relais vérifie cette égalité, donc seul le détenteur du lien hôte peut prendre le rôle d'hôte. Le lien participant ne contient pas `secretHôte`.
- `expiration` : `0` pour les nouveaux murs (**pas de durée limite** : le mur vit tant que l'hôte le garde ouvert et il est détruit quand l'hôte le quitte). Les anciens liens portent des secondes Unix en base 36 (≤ 24 h) et restent honorés jusqu'à leur échéance.
- `nom` (lien hôte seulement, optionnel) : nom du mur en UTF-8 base64url, pour qu'un hôte qui recharge le garde. Les participants le reçoivent dans le message `welcome` scellé, jamais dans leur lien ; le relais ne le voit pas. Nettoyé (caractères de contrôle retirés, espaces fusionnés, 80 caractères max) et affiché comme du texte.
- `options` : `p` | `n` (mot de passe ou non), puis `1` (autodestruction après un téléchargement) et/ou `h` (détruire si l'hôte se déconnecte). Ex. `n`, `p1h`, `nh`.
- L'expiration et les options entrent dans la dérivation de clés : les modifier dans le lien fait échouer la poignée de main.
- **Code du mur** `XXXX-XXXX` : dérivé de `SHA-256("filenymous-wall-code|wallId|clé")`, affiché chez tous. Il sert à **vérifier** à voix haute qu'on est sur le même mur ; il ne permet **pas** de rejoindre : un code court tapé à la main suffirait au relais pour retrouver la salle, et un code assez long pour porter la clé ne serait plus « court ». On rejoint donc par lien ou QR code uniquement.

## Cryptographie

- Matériau : `clé` seule, ou `clé ‖ PBKDF2-SHA256(mot de passe, "filenymous-wall-pw:<wallId>", 200 000 itérations)` si mot de passe. Le mot de passe n'est jamais transmis.
- HKDF-SHA256 (sel `filenymous-wall-v1`, contexte `<wallId>:<sid>:<exp>:<options>`, `sid` aléatoire par connexion) → trois clés : `wall-proof` (HMAC de preuve), `wall-up` (participant → hôte), `wall-down` (hôte → participant). Des clés distinctes par sens et par session excluent toute réutilisation d'IV.
- Poignée de main en clair sur le DataChannel, sans contenu : `wall-hello {v, sid, proof}` → `wall-ready {proof}` ou `wall-reject {reason}`. Preuve mutuelle (`sealProof/checkProof`) : un mauvais mot de passe est refusé sans rien révéler.
- Ensuite **tout** est scellé AES-256-GCM (format `sealChunk` : IV = flux ‖ index, en-tête en AAD) : flux 0 = messages de contrôle JSON (noms de fichiers, tailles, textes compris), flux ≥ 1 = données. L'ordre est imposé par flux : toute trame rejouée, réordonnée ou modifiée coupe la connexion.

## Protocole

Relais (WebSocket `wss://www.opendpe.net/filenymous-signal/wall`) :

| Message | Champs (liste stricte, tout autre champ est refusé) |
|---|---|
| `wall-join` hôte | `wallId`, `role:"host"`, `hostSecret`, `expiresAt` (optionnel : absent = pas d'expiration), `destroyOnHostLeave` |
| `wall-join` participant | `wallId`, `role:"peer"`, `peerId` (aléatoire) |
| `wall-signal` | `payload` (offre/réponse/ICE), `to` (hôte uniquement) |
| `wall-close` | hôte uniquement : ferme la salle pour tous (pierre tombale : la salle ne peut pas renaître) |
| `wall-leave` | quitter |

Événements serveur : `wall-joined`, `wall-peer-joined/left` (à l'hôte seulement), `wall-host-online/offline`, `wall-signal`, `wall-closed {reason: destroyed|host-left|expired}`. Les participants ne reçoivent jamais l'identifiant des autres participants. Expiration plafonnée (`WALL_MAX_TTL_MS`), non prolongeable ; capacité `MAX_WALL_PEERS` ; si `destroyOnHostLeave`, la salle est fermée après `WALL_HOST_GRACE_MS` sans hôte (5 s, pour tolérer un rechargement).

DataChannel (tout scellé après la poignée de main) :

Version de protocole 2 (`v: 2` dans `wall-hello`).

- participant → hôte : d'abord `profile {name, agent, media}` ; puis `say {text, replyTo?}`, `put {uid, kind, name, size, mime, replyTo?}` + trames (flux `uid`) + `put-end`, `get {rid, id}`, `react {id, emoji}`, `poll {question, options}`, `vote`, `poll-close`, `remove`, `typing`, `burst {kind}`, `hand {up}`, `rename {name}`, `live-start {kind, tracks}`, `live-stop`, `rtc {link, kind: offer|answer|ice, …}`, `bye`.
- hôte → participant : `welcome {label, expiresAt, burn, hostLeave, agents, media, title?}` (`expiresAt: 0` = pas d'expiration), puis les `post` existants, `pin`, `live` ; ensuite `members`, `post` (création ou mise à jour : réactions, votes), `unpost`, `pin`, `typing-by`, `burst-by`, `settings {agents}`, `live`, `live-ok/live-fail`, `rtc`, `notice {code, retryMs?}`, `kick {reason: kicked|agents-off}`, `put-ok/put-fail`, `get-begin` + trames + `get-end/get-fail`, `destroy {reason}`.
- Chaque message est validé strictement (`parseWallMessage`) : champs, types et longueurs ; tout message invalide coupe la connexion.

Code : `ui/src/wall/` (`link.ts`, `crypto.ts`, `model.ts`, `feed.ts`, `markup.ts`, `emoji.ts`, `live.ts`, `signal.ts`, `host.ts`, `peer.ts`, `WallRoom.tsx`, `WallPanel.tsx`, `Markup.tsx`, `EmojiPicker.tsx`), CLI `cli/src/wall.ts`, relais `p2p-signal/server.js` (v2 inchangé ; octobre 2026 : `expiresAt` optionnel pour les murs sans expiration).

## Règles de vie

- **Pas de durée limite** (depuis octobre 2026) : à la création, l'hôte donne un nom au mur et doit cocher « J'ai compris qu'en quittant, le mur et toutes ses informations seront détruits » (le bouton « Créer » reste désactivé sinon). Un mur sans hôte depuis 1 h est fermé par le relais.
- **Expiration (anciens liens)** : contrôlée chaque seconde chez l'hôte et chez chaque participant (effacement local), et par le relais (fermeture de la salle).
- **Autodestruction après 1 téléchargement** : le premier « Télécharger », « Aperçu » ou « Révéler » par quelqu'un d'autre que l'auteur (hôte compris) retire l'élément du mur ; une confirmation est demandée avant. Celui qui l'a obtenu garde sa copie en mémoire (marquée « Copie locale ») jusqu'à la destruction du mur.
- **Détruire le mur** : l'hôte envoie `destroy` scellé à chaque participant (effacement + révocation des Blob URL), ferme les connexions, puis `wall-close` au relais.
- **Hôte déconnecté** (toujours activé pour les nouveaux murs) : fermeture du DataChannel → les participants effacent tout immédiatement ; le relais ferme la salle après la période de grâce.
- **Quitter** : un participant peut partir à tout moment ; sa copie est effacée.
- **Confirmation de fermeture** : fermer l'onglet (`beforeunload`), « ← Accueil », le logo, « Quitter le mur » ou « Détruire le mur » affichent la même confirmation partagée par tous les services (« Vous êtes sur le point de fermer la fenêtre… », Annuler / Quitter) tant que le mur est ouvert ; chez l'hôte, « Quitter » détruit le mur pour tous.

## Limites

| Limite | Valeur |
|---|---|
| Participants simultanés | 8 (relais `MAX_WALL_PEERS`) |
| Taille par élément | 256 Mio |
| Total par mur | 1 Gio, 200 éléments |
| Note / secret | 64 Kio de texte |
| Message | 4000 caractères ; fil : 1000 messages/sondages |
| Flux en direct | 2 par mur, 1 par participant, 2 pistes par flux |
| Médias en ligne automatiques | ≤ 32 Mio, murs sans autodestruction |
| Durée de vie | aucune : tant que l'hôte garde le mur ouvert (relais : mur sans hôte fermé après 1 h) |

Le contenu est gardé en RAM (`Blob`) : la mémoire de l'onglet hôte borne en pratique le volume.

## Aperçus

- Images (`<img>`, SVG compris : aucun script n'y est exécuté), vidéo et audio (`<video>/<audio>`) depuis des Blob URL, révoquées à la fermeture de l'aperçu, à l'effacement et au démontage. Texte (`.txt`, `.md`, `.json`, code, `.env`, HTML…) affiché via `textContent` dans un `<pre>` : jamais interprété.
- **PDF : pas d'aperçu**, téléchargement uniquement. Le lecteur PDF de Chromium refuse les iframes `sandbox` et peut exécuter le JavaScript du document ; pdf.js n'est pas embarqué. Plutôt qu'un aperçu non isolé, on l'indique clairement.
- Aucun contenu n'est écrit dans IndexedDB, localStorage, sessionStorage ou le cache. Révoquer une Blob URL et lâcher les références ne garantit pas un effacement immédiat de la RAM : c'est le ramasse-miettes du navigateur qui libère la mémoire.

## Confidentialité : ce qui est protégé, ce qui ne l'est pas

- Protégé : le contenu, les noms de fichiers, les notes, le mot de passe et la clé, vis-à-vis du relais, de l'hébergeur et de tout intermédiaire réseau (TURN compris).
- Le relais voit : un identifiant de mur opaque, l'expiration éventuelle (anciens liens), l'option « détruire si l'hôte part », le `hostSecret` de l'hôte (dont il ne vérifie que le hash), les paramètres WebRTC (SDP, candidats ICE, donc les adresses IP) et l'adresse IP de connexion, gardée **en mémoire** pour la limitation de débit. Il n'écrit aucune ligne par requête ; nginx a `access_log off` pour `/filenymous-signal/wall` (après déploiement, voir plus bas).
- **Ce n'est pas de l'anonymat** : en WebRTC l'hôte voit l'IP de chaque participant et chaque participant voit celle de l'hôte (sauf relais TURN). Tor Browser désactive WebRTC : pour masquer son IP, utiliser un VPN de confiance. Pour une source ou un lanceur d'alerte, le canal de signalement (asynchrone, utilisable via Tor) est le bon outil.
- **Agents IA** : ce qu'un agent lit sort du chiffrement de bout en bout vers le fournisseur de son modèle (désactivé par défaut, avertissement à l'activation et tant qu'un agent est là ; badge auto-déclaré).
- **En direct** : l'hôte reçoit et retransmet les flux ; les participants voient l'IP de l'hôte, pas celles des autres.
- Les participants peuvent enregistrer, copier ou photographier ce qu'ils ont vu : la destruction efface les copies en mémoire, pas ce qui a déjà été sauvegardé.
- Pas de mesure d'audience sur les pages `#wall…` (le garde Umami coupe l'envoi).
- Le lien hôte (avec `hostSecret`) est dans la barre d'adresse et l'historique de l'onglet hôte, comme pour la Dropzone ; le lien participant reste dans l'historique des participants jusqu'à la destruction du mur (il devient alors inutilisable).
- Le texte de l'interface est protégé par un test (`ui/src/wall/wall.test.ts`) qui interdit « anonymat absolu », « aucune IP », « zéro log », « certifié », etc. et exige les mentions IP/VPN/Tor/canal de signalement.

## CLI et agents IA (`filenymous` ≥ 0.4.1 pour les murs sans expiration, ≥ 0.4.2 pour les notes partagées)

```
npx filenymous wall create [--title <nom du mur>] [--ttl 15m|1h|24h] [--burn] [--keep-on-leave] [--allow-agents] [--name <nom>]
npx filenymous wall join "<lien>" [--name <nom>] [--http] [--files-root <dir>] [-o <dir>]
npx filenymous wall mcp "<lien>" | --create [...]
```

- **JSON Lines** : événements sur stdout (`ready`, `message`, `file`, `note`, `poll`, `poll.update`, `reaction`, `join`, `leave`, `removed`, `pin`, `live`, `notice`, `ended`), commandes sur stdin (`send`, `react`, `vote`, `poll`, `note`, `file`, `get`, `read`, `members`, `info`, `leave` ; hôte : `pin`, `kick`, `allow-agents`) ; `ref` est renvoyé dans le `result`. Mot de passe : `--password` ou `FILENYMOUS_PASSWORD`.
- `wall create` affiche le lien **participant** seulement (jamais le secret hôte) ; le processus détient le mur en mémoire et le détruit en quittant (sauf `--keep-on-leave`).
- **Pont HTTP/SSE local** (`--http`) : `127.0.0.1` seulement, jeton porteur aléatoire (ou `FILENYMOUS_HTTP_TOKEN`), refus des en-têtes `Host` non locaux et de toute requête `Origin` (navigateurs) ; `GET /events` (SSE), `/messages`, `/participants`, `/info`, `POST /send`, `/react`, `/file`, …
- **MCP (stdio)** : outils `wall_read_messages` (avec attente longue), `wall_send_message`, `wall_send_file`, `wall_react`, `wall_list_participants`, plus `wall_get_item` et `wall_info`. Configuration : voir [cli/README.md](../cli/README.md#agents-ia--sharewall).
- `wall send_file` lit uniquement sous `--files-root` (répertoire courant par défaut, liens symboliques résolus).

## Extension navigateur

Non incluse (pas triviale : il faudrait un onglet hôte persistant, or le service worker MV3 est suspendu). Inscrite à la feuille de route : « Créer un mur » depuis le menu de l'extension, qui ouvre `#wall-new` dans un onglet.

## Tests

- Relais : `cd p2p-signal && npm test` (inclut `wall.test.mjs` : secret hôte exigé, champs en trop refusés, routage en étoile et isolation des pairs, kill switch + pas de renaissance, destruction au départ de l'hôte après grâce, reconnexion dans la grâce, expiration imposée et non prolongeable, capacité 8).
- Unitaires : `cd ui && npx vitest run src/wall/` (liens, crypto/trames scellées, règles d'autodestruction/expiration/limites, validation des messages v2, fil/réactions/sondages/limites de débit, mise en forme sûre, mentions, emojis, message de jointure sans clé, garde de vocabulaire, mention du fournisseur pour les agents).
- CLI : `cd cli && npm test` (`wall.test.mjs` : hôte CLI + 2 agents en JSON Lines, refus par défaut, limite de débit, désactivation des agents, pont HTTP, mot de passe, autodestruction ; `mcp.test.mjs` : client MCP officiel `@modelcontextprotocol/sdk` sur stdio).
- E2E v2 : `e2e/sharewall-live.spec.ts` (caméra + micro d'un participant et écran de l'hôte avec médias simulés, 3ᵉ flux refusé, arrêt, aucun SDP média vers le relais), `e2e/sharewall-agents.spec.ts` (2 navigateurs + 2 agents CLI : refus par défaut, activation avec avertissement, badges IA, mentions, réponses, réactions, fichiers, limite de débit, déconnexion, désactivation) ; `sharewall.spec.ts` couvre aussi emojis, réactions, sondages, réponses, épinglage, médias en ligne.
- E2E : `cd ui && npx playwright test e2e/sharewall.spec.ts` (3 contextes : grille en direct, notes masquées/révélées/copiées, aperçus image/vidéo/texte, PDF sans aperçu, SHA-256 identiques, rien vers le relais ni dans le stockage, départ d'un pair, kill switch, mot de passe, autodestruction, expiration avec horloge simulée, destruction à la fermeture de l'onglet hôte).

## Déploiement (à faire, non exécuté par la PR)

La v2 ne modifie pas le relais (tout le nouveau protocole est dans le DataChannel scellé) : l'ordre ci-dessous est inchangé. La CLI 0.4.0 n'est pas publiée sur npm par la PR.

Ordre : **relais d'abord**, puis site. Un site déployé avant le relais afficherait le mur mais les connexions échoueraient (`/wall` inconnu de l'ancien relais : messages `wall-*` refusés).

1. **Relais (VPS openDPE)** : déployer le nouveau `p2p-signal/server.js` (+ `package.json`) via le workflow de déploiement du relais du dépôt openDPE (comme pour la Dropzone / le canal de signalement), puis `sudo systemctl restart filenymous-signal`. Variables facultatives dans `/etc/filenymous-signal.env` : `WALL_MAX_TTL_MS` (24 h + 60 s), `MAX_WALL_PEERS` (8), `WALL_HOST_GRACE_MS` (5000), `WALL_SWEEP_MS` (15000). Vérifier `GET https://www.opendpe.net/filenymous-signal/health` → champ `walls` présent.
2. **nginx (VPS)** : ajouter le bloc `location = /filenymous-signal/wall { access_log off; … }` de `p2p-signal/nginx-opendpe-location.conf` dans le `server` d'opendpe.net, puis `sudo nginx -t && sudo systemctl reload nginx`. Contrôle : ouvrir un mur, puis `sudo grep -c 'filenymous-signal/wall' /var/log/nginx/access.log` → `0`. Vérifier qu'aucun proxy/CDN en amont ne journalise ce chemin.
3. **Site (OVH)** : `deploy-ovh-ui.yml` sur `main` (téléverse aussi `.htaccess` avec la redirection `/wall`, `/wall/new` → `/app/#wall-new`). Puis `ovh-htaccess.yml` en mode `verify` (contrôles curl `/wall` ajoutés).
4. Tant que l'étape 2 n'est pas faite, la phrase « il ne tient pas de journal d'accès pour les murs » de l'interface serait inexacte : ne pas publier le site avant.
