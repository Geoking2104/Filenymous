# Extension navigateur Filenymous (Chrome / Firefox)

Partage chiffré de bout en bout **en 2 clics**, sans ouvrir le site :

| Clic droit sur… | Ce qui se passe | Stockage |
|---|---|---|
| un **texte sélectionné** | « Partager la sélection en lien secret » : le texte est chiffré dans l'extension (AES-256-GCM, même schéma que `filenymous.eu/app`), envoyé au coffre de secrets, et le lien `…/app/#s:<id>/<clé>` est **copié aussitôt** dans le presse-papier. Lecture unique : le secret s'autodétruit à la première lecture (bouton « Afficher le secret »). | Chiffré seulement, 7 jours max, sur le relais |
| une **image**, une **vidéo / un son** | « Envoyer … en direct » : l'extension récupère le fichier et ouvre un partage **pair-à-pair** (WebRTC). Le lien `…/app/#p2p:<code>/<secret>/e<expiration>` est copié aussitôt. | Rien : les octets vont directement au destinataire |
| un **lien** | « Envoyer le fichier de ce lien en direct » (P2P), ou « Partager l'adresse de ce lien en secret » (coffre). | idem |

La fenêtre de l'extension (icône dans la barre d'outils) permet aussi de **glisser-déposer ou choisir des fichiers** (avec mot de passe, durée 15 min / 1 h / 24 h, 1 ou plusieurs téléchargements), de créer un **secret** (lecture unique ou 24 h / 7 j, mot de passe optionnel), et de suivre les partages en cours (état, progression, copier, arrêter).

> **Gardez le navigateur ouvert** jusqu'à ce que le destinataire ait téléchargé (ou jusqu'à l'expiration du lien), comme avec la CLI : les fichiers partent directement de votre ordinateur. L'extension l'indique dans la notification, la fenêtre et le badge de l'icône (nombre de partages actifs, ou pourcentage pendant l'envoi). Par défaut, un partage s'arrête après le premier téléchargement terminé ou au bout d'1 h.

Les destinataires ouvrent les liens dans l'application web habituelle (`https://filenymous.eu/app/`), sans rien installer.

## Architecture

```
extension/
  build.mjs                 un seul code → dist/chrome (MV3) et dist/firefox (MV2) + zips
  src/background.ts         menus contextuels, notifications, badge, demande d'accès à un site
  src/background-chrome.ts  service worker Chrome : crée le document offscreen
  src/offscreen.ts          Chrome : document offscreen (raisons WEB_RTC + CLIPBOARD) qui héberge les partages
  src/background-firefox.ts Firefox : page d'arrière-plan persistante (héberge directement les partages)
  src/host.ts               partages : P2PSender et coffre de secrets de ui/src, réutilisés tels quels
  src/popup.ts              fenêtre (fichiers, secret, partages en cours) ; aussi en onglet (popup.html?tab=1)
  src/grant.ts              demande d'accès à un seul site (permissions.request, sur clic)
  src/fetchTarget.ts        récupère l'image / le fichier ciblé (nom, taille max 1 Go, erreurs)
```

- **Même cryptographie que le site** : `ui/src/vault/crypto.ts` (HKDF + AES-GCM, jeton d'accès dérivé) et `ui/src/p2p/session.ts` / `protocol.ts` (blocs AES-GCM, code + secret dans le fragment, expiration liée au lien) sont **bundlés tels quels** par esbuild, comme pour la CLI. Seul le libellé d'appareil change : le destinataire voit « Extension Filenymous · Chrome 140 · Windows ».
- **Pourquoi un document offscreen (Chrome)** : un service worker MV3 n'a ni WebRTC ni presse-papier et s'arrête après ~30 s d'inactivité. Le document offscreen (raisons `WEB_RTC` et `CLIPBOARD`) garde la connexion pair-à-pair ouverte jusqu'au téléchargement, puis se ferme 5 min après le dernier partage.
- **Pourquoi Manifest V2 pour Firefox** : en MV3, Firefox n'a que des pages d'arrière-plan non persistantes (suspendues après inactivité), ce qui couperait les transferts. Firefox continue de prendre en charge MV2 ; la page d'arrière-plan persistante y joue le rôle du document offscreen.
- **Popup ↔ hôte** : `BroadcastChannel` entre pages de l'extension (même origine). Les objets `File` y passent par clonage structuré, sans copie en mémoire.

## Permissions

| Permission | Pourquoi |
|---|---|
| `contextMenus` | Les entrées du clic droit. |
| `clipboardWrite` | Copier le lien automatiquement. |
| `notifications` | « Lien copié », « Téléchargement terminé », erreurs. |
| `offscreen` (Chrome) | Héberger WebRTC et la copie du lien hors du service worker. |
| `activeTab` + `scripting` (Chrome) / `activeTab` (Firefox) | Lire le texte sélectionné **dans l'onglet où vous avez fait clic droit, au moment du clic**, en gardant les retours à la ligne (le `selectionText` du menu les supprime). Aucun script permanent dans les pages. |
| **Aucune permission d'hôte obligatoire** | Le relais et le coffre (`www.opendpe.net/filenymous-signal/`) répondent en CORS à l'origine de l'extension ; les images servies avec CORS (la plupart des CDN) se récupèrent aussi sans permission. |
| `optional_host_permissions` `http(s)://*/*` (Chrome) / `optional_permissions` (Firefox) | **Facultatif, site par site.** Si une image ou un fichier n'est pas récupérable sans accès au site (pas de CORS, ou page connectée), une petite fenêtre « Autoriser l'accès à ce site » demande l'accès **à ce seul site** (`https://ce-site/*`), puis lance le partage. Révocable dans les réglages de l'extension. |

## Prérequis côté relais

Le relais refuse les origines inconnues (`ALLOWED_ORIGIN`). Pour l'extension, il accepte désormais deux entrées spéciales :

- `chrome-extension://*` et `moz-extension://*` : n'importe quel identifiant de ce schéma (Firefox donne un UUID aléatoire par installation, une liste d'identifiants est donc impossible). Une page web ne peut pas envoyer ces origines : le relais reste fermé aux autres sites.
- ou un identifiant exact, ex. `chrome-extension://<id du Chrome Web Store>` (à privilégier pour Chrome une fois l'extension publiée).

En production : ajouter `,chrome-extension://*,moz-extension://*` à `ALLOWED_ORIGIN` (voir `p2p-signal/filenymous-signal.service`) **et redéployer le relais**. Sans cela, l'extension affiche « relais Filenymous injoignable (… ou extension non autorisée par le relais) ».

## Construire

```bash
cd extension
npm ci
npm run build        # dist/chrome, dist/firefox, dist/filenymous-chrome-<v>.zip, dist/filenymous-firefox-<v>.zip
npm run typecheck
npm test             # tests unitaires (+ build)
npm run test:e2e     # Chromium headless : extension + relais local + site en dev (installer d'abord ui/ : cd ../ui && npm ci)
```

Variables : `FN_APP_URL` (défaut `https://filenymous.eu/app/`), `FN_SIGNAL_URL` (défaut `wss://www.opendpe.net/filenymous-signal/`).

## Installer sans store (mode développeur)

- **Chrome / Edge / Brave** : `chrome://extensions` → activer « Mode développeur » → « Charger l'extension non empaquetée » → choisir `extension/dist/chrome`.
- **Firefox** : `about:debugging#/runtime/this-firefox` → « Charger un module complémentaire temporaire » → choisir `extension/dist/firefox/manifest.json` (retiré au redémarrage de Firefox ; pour une installation durable, il faut la signature Mozilla, voir ci-dessous).

## Publication

### Chrome Web Store

1. Compte développeur (frais unique de 5 $) sur <https://chrome.google.com/webstore/devconsole>.
2. « Nouvel élément » → téléverser `dist/filenymous-chrome-<version>.zip`.
3. Fiche : description en français, captures 1280×800, icône 128 px, catégorie « Productivité ».
4. Onglet **Confidentialité** : objectif unique (« partager un fichier ou un texte chiffré de bout en bout en 2 clics ») ; justifier chaque permission avec le tableau ci-dessus ; « aucune donnée utilisateur collectée ou vendue » (le contenu est chiffré dans le navigateur, le relais ne voit que du chiffré) ; lien vers la politique de confidentialité de filenymous.eu.
5. Après publication : relever l'identifiant de l'extension et remplacer `chrome-extension://*` par `chrome-extension://<id>` dans `ALLOWED_ORIGIN`.

### Firefox (addons.mozilla.org)

1. Compte sur <https://addons.mozilla.org/developers/>.
2. « Soumettre un nouveau module » → `dist/filenymous-firefox-<version>.zip`.
3. Le code est bundlé (esbuild, non minifié) : joindre le **code source** demandé par AMO (archive du dépôt) avec les instructions `cd extension && npm ci && npm run build`.
4. L'identifiant `extension@filenymous.eu` est fixé dans le manifeste ; `data_collection_permissions: none` y est déclaré (à confirmer lors de la revue).

Avant chaque soumission : augmenter `version` dans `package.json`, puis `npm run build`.

## Limites connues

- **Le navigateur doit rester ouvert** pour les fichiers (pas de stockage serveur). Le texte, lui, passe par le coffre et n'a pas cette contrainte.
- Le clic droit sur un fichier charge celui-ci en mémoire (1 Go maximum). Pour un gros fichier local, utilisez la fenêtre de l'extension (glisser-déposer ou « Choisir des fichiers »), qui lit le fichier à la demande.
- Les images `blob:` (souvent les vidéos en streaming adaptatif), `file:` et les pages internes du navigateur ne sont pas récupérables.
- Firefox : la fenêtre de l'extension se ferme à l'ouverture du sélecteur de fichiers ; « Choisir des fichiers » ouvre donc la même interface dans un onglet.
- Chrome : la lecture de la sélection est impossible dans le lecteur PDF intégré et sur les pages du Chrome Web Store ; l'extension se rabat alors sur le texte fourni par le menu (sans retours à la ligne).
- Les partages en cours sont perdus si l'extension est rechargée ou mise à jour.
- Testé automatiquement sous Chromium (headless) ; la version Firefox passe `web-ext lint` mais n'a pas de test automatisé de bout en bout.
