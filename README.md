# Filenymous

Application web P2P pour envoyer et recevoir des fichiers chiffres, sans compte, sans installateur natif et sans conducteur Holochain local obligatoire.

- Site OVH : https://filenymous.eu/
- GitHub Pages : https://geoking2104.github.io/Filenymous/
- Releases : https://github.com/Geoking2104/Filenymous/releases/latest

## Positionnement

Filenymous reste une application web. Les fichiers Windows, macOS et Linux publies dans les releases sont des archives web portables qui contiennent `Filenymous.html`; elles s'ouvrent dans un navigateur moderne.

Le projet ne publie plus de `.exe`, `.dmg` ni `.AppImage` tant que l'architecture native n'est pas redevenue necessaire et stable.

## Fonctionnement

1. L'expediteur selectionne un fichier dans le navigateur.
2. Le fichier est chiffre localement avec WebCrypto.
3. Filenymous cree un code a usage unique, un lien chiffre autonome ou une session P2P WebRTC.
4. Le destinataire ouvre le lien ou saisit le code.
5. Le dechiffrement reste local cote navigateur.

Pour les petits fichiers, le lien autonome reste le chemin le plus simple. Pour les fichiers plus lourds, le flux P2P direct garde les deux navigateurs ouverts pendant le transfert.

## Architecture cible

- **WebCrypto** : chiffrement local AES-256-GCM.
- **WebRTC DataChannel** : transfert navigateur a navigateur quand les pairs peuvent se joindre.
- **Signalisation web** : echange minimal de rendez-vous, sans stockage du fichier en clair.
- **Iroh / iroh-blobs** : trajectoire pour les gros fichiers verifiables et les relais chiffres.
- **Holochain / Holo Web Conductor** : option avancee pour identite, contacts, DHT et coordination, sans imposer de conducteur local au grand public.

## Telechargements

Les releases GitHub publient uniquement des paquets web :

- `filenymous-public-web.zip`
- `filenymous-windows-web.zip`
- `filenymous-macos-web.zip`
- `filenymous-linux-web.zip`
- `ui.zip`

Les archives par systeme contiennent la meme application web avec un court README adapte a la plateforme.

## Developpement

```bash
cd ui
npm install
npm run dev
```

Pour construire l'UI Vite :

```bash
cd ui
npm run build
```

Les artefacts Holochain restent presents dans le depot pour les modules avances et les validations Rust, mais ils ne constituent plus le mode d'installation public.

## Securite

- Chiffrement local avant transfert.
- Aucun compte requis.
- Code a usage unique pour les sessions de reception.
- Historique et cles stockes localement dans le navigateur.
- Pas de stockage serveur du fichier en clair.
- Wallet BTC/ETH local verrouille par defaut.

## Licence

MIT.
