# Sharewall — mur de partage instantané

Un mur éphémère, partagé par lien ou QR code, sur lequel plusieurs personnes déposent fichiers, notes et secrets que tout le groupe voit en direct ; à l'expiration (15 min, 1 h ou 24 h), à la destruction par l'hôte, ou (option) quand l'hôte se déconnecte, tout est effacé. 100 % pair-à-pair, chiffré de bout en bout, **rien n'est stocké côté serveur**.

Entrées : `https://filenymous.eu/app/#wall-new` (raccourci `https://filenymous.eu/wall/new` → redirection 301 statique, sans secret).

## Cas d'usage

- **Journalisme et sources** : échange ponctuel de documents pendant un rendez-vous, mur détruit à la fin. Pour un signalement *sensible* (anonymat réseau nécessaire), le [canal de signalement](../ui/src/report) reste l'outil adapté : il fonctionne avec Tor Browser, alors que le mur (WebRTC) non.
- **Développeurs** : passer une clé d'API, un `.env`, un certificat de test pendant un appel ; notes masquées, autodestruction après une lecture.
- **Due diligence / data room éclair** : un mur de 24 h avec mot de passe, pour que plusieurs parties déposent et consultent des pièces le temps d'une réunion, puis bouton « Détruire le mur ».
- **Documents personnels** : envoyer pièces d'identité, justificatifs, photos entre ses propres appareils ou à un proche, sans les laisser sur un cloud.

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
| Hôte | `/app/#wall-host:<secretHôte>/<clé>/<expiration>/<options>` | uniquement l'onglet de l'hôte (permet de reprendre après rechargement) |
| Création | `/app/#wall-new`, `/wall`, `/wall/new` | public, sans secret |

- `clé` : 32 octets aléatoires (base64url, 43 caractères), générés dans le navigateur de l'hôte. Elle n'existe que dans le **fragment** (après `#`), que les navigateurs n'envoient jamais au serveur web ni au relais.
- `wallId` = `wall-` + 24 premiers caractères hex de `SHA-256(secretHôte)` : le relais vérifie cette égalité, donc seul le détenteur du lien hôte peut prendre le rôle d'hôte. Le lien participant ne contient pas `secretHôte`.
- `expiration` : secondes Unix en base 36 (obligatoire, ≤ 24 h).
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
| `wall-join` hôte | `wallId`, `role:"host"`, `hostSecret`, `expiresAt`, `destroyOnHostLeave` |
| `wall-join` participant | `wallId`, `role:"peer"`, `peerId` (aléatoire) |
| `wall-signal` | `payload` (offre/réponse/ICE), `to` (hôte uniquement) |
| `wall-close` | hôte uniquement : ferme la salle pour tous (pierre tombale : la salle ne peut pas renaître) |
| `wall-leave` | quitter |

Événements serveur : `wall-joined`, `wall-peer-joined/left` (à l'hôte seulement), `wall-host-online/offline`, `wall-signal`, `wall-closed {reason: destroyed|host-left|expired}`. Les participants ne reçoivent jamais l'identifiant des autres participants. Expiration plafonnée (`WALL_MAX_TTL_MS`), non prolongeable ; capacité `MAX_WALL_PEERS` ; si `destroyOnHostLeave`, la salle est fermée après `WALL_HOST_GRACE_MS` sans hôte (5 s, pour tolérer un rechargement).

DataChannel (tout scellé après la poignée de main) :

- participant → hôte : `put {uid, kind, name, size, mime}` + trames de données (flux `uid`) + `put-end {uid, chunks}` ; `get {rid, id}` ; `bye`.
- hôte → participant : `welcome {label, expiresAt, burn, hostLeave}`, `state {items, peers}`, `put-ok/put-fail`, `get-begin {rid, item}` + trames (flux `rid`) + `get-end`/`get-fail`, `destroy {reason}`.

Code : `ui/src/wall/` (`link.ts`, `crypto.ts`, `model.ts`, `signal.ts`, `host.ts`, `peer.ts`, `WallPanel.tsx`), relais `p2p-signal/server.js`.

## Règles de vie

- **Expiration** : contrôlée chaque seconde chez l'hôte et chez chaque participant (effacement local), et par le relais (fermeture de la salle).
- **Autodestruction après 1 téléchargement** : le premier « Télécharger », « Aperçu » ou « Révéler » par quelqu'un d'autre que l'auteur (hôte compris) retire l'élément du mur ; une confirmation est demandée avant. Celui qui l'a obtenu garde sa copie en mémoire (marquée « Copie locale ») jusqu'à la destruction du mur.
- **Détruire le mur** : l'hôte envoie `destroy` scellé à chaque participant (effacement + révocation des Blob URL), ferme les connexions, puis `wall-close` au relais.
- **Hôte déconnecté** (option) : fermeture du DataChannel → les participants effacent tout immédiatement ; le relais ferme la salle après la période de grâce.
- **Quitter** : un participant peut partir à tout moment ; sa copie est effacée.
- **Garde anti-fermeture** : tant qu'au moins un participant est connecté, fermer l'onglet hôte demande confirmation (`beforeunload`).

## Limites

| Limite | Valeur |
|---|---|
| Participants simultanés | 8 (relais `MAX_WALL_PEERS`) |
| Taille par élément | 256 Mio |
| Total par mur | 1 Gio, 200 éléments |
| Note / secret | 64 Kio de texte |
| Durée de vie | 15 min, 1 h ou 24 h |

Le contenu est gardé en RAM (`Blob`) : la mémoire de l'onglet hôte borne en pratique le volume.

## Aperçus

- Images (`<img>`, SVG compris : aucun script n'y est exécuté), vidéo et audio (`<video>/<audio>`) depuis des Blob URL, révoquées à la fermeture de l'aperçu, à l'effacement et au démontage. Texte (`.txt`, `.md`, `.json`, code, `.env`, HTML…) affiché via `textContent` dans un `<pre>` : jamais interprété.
- **PDF : pas d'aperçu**, téléchargement uniquement. Le lecteur PDF de Chromium refuse les iframes `sandbox` et peut exécuter le JavaScript du document ; pdf.js n'est pas embarqué. Plutôt qu'un aperçu non isolé, on l'indique clairement.
- Aucun contenu n'est écrit dans IndexedDB, localStorage, sessionStorage ou le cache. Révoquer une Blob URL et lâcher les références ne garantit pas un effacement immédiat de la RAM : c'est le ramasse-miettes du navigateur qui libère la mémoire.

## Confidentialité : ce qui est protégé, ce qui ne l'est pas

- Protégé : le contenu, les noms de fichiers, les notes, le mot de passe et la clé, vis-à-vis du relais, de l'hébergeur et de tout intermédiaire réseau (TURN compris).
- Le relais voit : un identifiant de mur opaque, l'expiration, l'option « détruire si l'hôte part », le `hostSecret` de l'hôte (dont il ne vérifie que le hash), les paramètres WebRTC (SDP, candidats ICE, donc les adresses IP) et l'adresse IP de connexion, gardée **en mémoire** pour la limitation de débit. Il n'écrit aucune ligne par requête ; nginx a `access_log off` pour `/filenymous-signal/wall` (après déploiement, voir plus bas).
- **Ce n'est pas de l'anonymat** : en WebRTC l'hôte voit l'IP de chaque participant et chaque participant voit celle de l'hôte (sauf relais TURN). Tor Browser désactive WebRTC : pour masquer son IP, utiliser un VPN de confiance. Pour une source ou un lanceur d'alerte, le canal de signalement (asynchrone, utilisable via Tor) est le bon outil.
- Les participants peuvent enregistrer, copier ou photographier ce qu'ils ont vu : la destruction efface les copies en mémoire, pas ce qui a déjà été sauvegardé.
- Pas de mesure d'audience sur les pages `#wall…` (le garde Umami coupe l'envoi).
- Le lien hôte (avec `hostSecret`) est dans la barre d'adresse et l'historique de l'onglet hôte, comme pour la Dropzone ; le lien participant reste dans l'historique des participants jusqu'à expiration (il devient alors inutilisable).
- Le texte de l'interface est protégé par un test (`ui/src/wall/wall.test.ts`) qui interdit « anonymat absolu », « aucune IP », « zéro log », « certifié », etc. et exige les mentions IP/VPN/Tor/canal de signalement.

## CLI (spécification, non implémentée)

```
npx filenymous wall [--ttl 15m|1h|24h] [--burn] [--host-leave] [--password <pw>|--password-stdin] [--json]
```

- Héberge un mur depuis le terminal (même protocole, `node-datachannel` comme `upload`), affiche le lien participant, le QR code (texte) et le code du mur ; `--json` émet des événements (`peer-joined`, `item`, `destroyed`).
- `filenymous wall add <fichier...>` / `filenymous wall note` (stdin) pour déposer, `filenymous wall get <id>` pour télécharger ; `Ctrl+C` = détruire le mur.
- `npx filenymous wall join "<lien>"` : rejoindre en participant (lecture + dépôt).
- Même règle que la CLI actuelle : le processus doit rester actif ; pas de stockage serveur.

## Extension navigateur

Non incluse (pas triviale : il faudrait un onglet hôte persistant, or le service worker MV3 est suspendu). Inscrite à la feuille de route : « Créer un mur » depuis le menu de l'extension, qui ouvre `#wall-new` dans un onglet.

## Tests

- Relais : `cd p2p-signal && npm test` (inclut `wall.test.mjs` : secret hôte exigé, champs en trop refusés, routage en étoile et isolation des pairs, kill switch + pas de renaissance, destruction au départ de l'hôte après grâce, reconnexion dans la grâce, expiration imposée et non prolongeable, capacité 8).
- Unitaires : `cd ui && npx vitest run src/wall/wall.test.ts` (liens, crypto/trames scellées, règles d'autodestruction/expiration/limites, validation des messages, message de jointure sans clé, garde de vocabulaire).
- E2E : `cd ui && npx playwright test e2e/sharewall.spec.ts` (3 contextes : grille en direct, notes masquées/révélées/copiées, aperçus image/vidéo/texte, PDF sans aperçu, SHA-256 identiques, rien vers le relais ni dans le stockage, départ d'un pair, kill switch, mot de passe, autodestruction, expiration avec horloge simulée, destruction à la fermeture de l'onglet hôte).

## Déploiement (à faire, non exécuté par la PR)

Ordre : **relais d'abord**, puis site. Un site déployé avant le relais afficherait le mur mais les connexions échoueraient (`/wall` inconnu de l'ancien relais : messages `wall-*` refusés).

1. **Relais (VPS openDPE)** : déployer le nouveau `p2p-signal/server.js` (+ `package.json`) via le workflow de déploiement du relais du dépôt openDPE (comme pour la Dropzone / le canal de signalement), puis `sudo systemctl restart filenymous-signal`. Variables facultatives dans `/etc/filenymous-signal.env` : `WALL_MAX_TTL_MS` (24 h + 60 s), `MAX_WALL_PEERS` (8), `WALL_HOST_GRACE_MS` (5000), `WALL_SWEEP_MS` (15000). Vérifier `GET https://www.opendpe.net/filenymous-signal/health` → champ `walls` présent.
2. **nginx (VPS)** : ajouter le bloc `location = /filenymous-signal/wall { access_log off; … }` de `p2p-signal/nginx-opendpe-location.conf` dans le `server` d'opendpe.net, puis `sudo nginx -t && sudo systemctl reload nginx`. Contrôle : ouvrir un mur, puis `sudo grep -c 'filenymous-signal/wall' /var/log/nginx/access.log` → `0`. Vérifier qu'aucun proxy/CDN en amont ne journalise ce chemin.
3. **Site (OVH)** : `deploy-ovh-ui.yml` sur `main` (téléverse aussi `.htaccess` avec la redirection `/wall`, `/wall/new` → `/app/#wall-new`). Puis `ovh-htaccess.yml` en mode `verify` (contrôles curl `/wall` ajoutés).
4. Tant que l'étape 2 n'est pas faite, la phrase « il ne tient pas de journal d'accès pour les murs » de l'interface serait inexacte : ne pas publier le site avant.
