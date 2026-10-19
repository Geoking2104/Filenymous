# Filenymous — security and threat model

Published at https://filenymous.eu/app/en/security/ (EN) and https://filenymous.eu/app/securite/ (FR). Source of truth for the text: `ui/seo/content.mjs` (`SECURITY`).

Code references checked for each claim: `ui/src/p2p/protocol.ts` (transfer: HKDF-SHA256 → AES-256-GCM, 64 KiB chunks, PBKDF2 310 000), `ui/src/p2p/dropzone/crypto.ts` and `ui/src/wall/crypto.ts` (HKDF session keys, PBKDF2 200 000), `ui/src/vault/crypto.ts` (one-time secrets), `ui/src/report/crypto.ts` (ECDH P-256 + HKDF + AES-256-GCM), `ui/src/p2p/config.ts` (STUN stun.l.google.com, TURN via /ice), `p2p-signal/vault.js` (TTL 24 h default / 7 days max, ciphertext + sha256(token)), `p2p-signal/reports.js` (90 / 365 days, HMAC(rotating key, IP) rate limiting), `p2p-signal/server.js` (in-memory IP rate limiting, no request logging).

Vulnerability reports: open a GitHub security advisory or issue on https://github.com/Geoking2104/Filenymous.

## Security model (EN)

This page honestly describes what Filenymous protects, what it does not, and what servers see. It is checked against the source code (MIT).

### Encryption used (browser WebCrypto)

- Direct transfer, streaming and extension: file key derived with HKDF-SHA256 from the link secret, AES-256-GCM in 64 KiB chunks with a unique IV per chunk and the header as authenticated data (no reordering or replay). This is on top of WebRTC’s DTLS.
- Optional transfer password: PBKDF2-SHA256 (310,000 iterations), HMAC challenge-response; the password never crosses the wire. An optional expiry is mixed into the key.
- Dropzone and Sharewall: session keys via HKDF-SHA256 (one key per contributor or per direction), optional password via PBKDF2-SHA256 (200,000 iterations), mutual proof before any exchange.
- One-time secret: AES-256-GCM, key via HKDF-SHA256, optional password via PBKDF2-SHA256 (310,000 iterations); the server keeps only the ciphertext and sha256(token).
- Whistleblowing channel: hybrid encryption with ephemeral ECDH P-256 + HKDF-SHA256 + AES-256-GCM to the organisation’s public key; the private key stays in the organisation’s browser (protected with PBKDF2-SHA256, 310,000 iterations).

### The key lives in the link fragment

- The key is after the # of the link. Browsers never send this fragment to the web server or the relay, and analytics never send it either.
- Consequence: anyone who gets the full link can open the share. Send it over a trusted channel, add a password sent another way, and beware of histories, screenshots and link previews.

### What servers see

- Signaling relay (wss://www.opendpe.net/filenymous-signal/): pairs browsers. It sees IP addresses, the share code, WebRTC parameters (ICE candidates, SDP) and timing. It does not store them; it uses IPs in memory for rate limiting (for the whistleblowing channel, only as an HMAC with a rotating key).
- TURN relay (fallback when a direct connection fails): sees IPs and forwards already-encrypted bytes. The public STUN server (Google) used for address discovery also sees your IP.
- Redis (on the server) holds encrypted data only: one-time secrets (24 h by default, 7 days max) and reports (90 days; organisation mailboxes 365 days), without the keys.
- Web server and proxy access logs may record IPs like on any website; the application itself does not log request content.
- Analytics: self-hosted cookieless Umami, page path only, disabled on secret, report and Sharewall pages.

### What other participants see

- Peer-to-peer, each peer sees the other’s IP address (that is how WebRTC works), unless the connection goes through TURN.
- To hide your IP, use a VPN. Tor Browser disables WebRTC, so peer-to-peer transfers don’t work there.

### AI agents

- An AI agent that reads a Sharewall (CLI or MCP) sends everything it reads to its model provider. It can only join if the host ticked “Allow AI agents”.
- A secret created by an AI assistant is seen in plain text by the assistant and its provider: create real secrets yourself in your browser.

### Threats not covered

- A compromised device (malware, malicious extension) on the sender or recipient side.
- Leak or sharing of the full link, or a weak password.
- A compromised web server serving modified JavaScript: like any web app, you trust the code delivered on each visit (the source is public, but served files are not signed).
- Traffic analysis and metadata (who talks to whom, when, approximate size) by the relay, the host or the network.
- A recipient copying or republishing what they received.

### Audit

- No external security audit has been carried out yet. The code is open source (MIT) and vulnerability reports are welcome via GitHub.

## Modèle de sécurité (FR)

Cette page décrit honnêtement ce que Filenymous protège, ce qu’il ne protège pas, et ce que voient les serveurs. Elle est vérifiée par rapport au code source (MIT).

### Chiffrement utilisé (WebCrypto du navigateur)

- Transfert direct, streaming et extension : clé de fichier dérivée par HKDF-SHA256 du secret du lien, chiffrement AES-256-GCM par blocs de 64 Kio avec un IV unique par bloc et l’en-tête en données authentifiées (pas de réordonnancement ni de rejeu). Ce chiffrement s’ajoute au DTLS de WebRTC.
- Mot de passe optionnel d’un transfert : PBKDF2-SHA256 (310 000 itérations), défi-réponse HMAC ; le mot de passe ne circule jamais. Une date d’expiration éventuelle est mêlée à la clé.
- Dropzone et Sharewall : clés de session par HKDF-SHA256 (une clé par contributeur ou par sens de communication), mot de passe optionnel via PBKDF2-SHA256 (200 000 itérations), preuve mutuelle avant tout échange.
- Secret à usage unique : AES-256-GCM, clé par HKDF-SHA256, mot de passe optionnel via PBKDF2-SHA256 (310 000 itérations) ; le serveur ne garde que le texte chiffré et sha256(jeton).
- Canal de signalement : chiffrement hybride ECDH P-256 éphémère + HKDF-SHA256 + AES-256-GCM vers la clé publique de l’organisation ; la clé privée reste dans le navigateur de l’organisation (protégée par PBKDF2-SHA256, 310 000 itérations).

### La clé est dans le fragment du lien

- La clé se trouve après le # du lien. Les navigateurs n’envoient jamais ce fragment au serveur web ni au relais, et la mesure d’audience ne l’envoie pas non plus.
- Conséquence : quiconque obtient le lien complet peut ouvrir le partage. Transmettez-le par un canal de confiance, ajoutez un mot de passe envoyé par un autre canal, et méfiez-vous des historiques, captures d’écran et aperçus de liens.

### Ce que voient les serveurs

- Relais de signalisation (wss://www.opendpe.net/filenymous-signal/) : il met les navigateurs en relation. Il voit les adresses IP, le code de partage, les paramètres WebRTC (candidats ICE, SDP) et l’heure. Il ne stocke pas ces données ; il utilise l’IP en mémoire pour limiter les abus (pour le canal de signalement, seulement sous forme de HMAC à clé tournante).
- Relais TURN (repli quand la connexion directe échoue) : il voit les IP et transporte des octets déjà chiffrés. Le serveur STUN public (Google) utilisé pour la découverte d’adresse voit aussi votre IP.
- Redis (sur le serveur) contient uniquement des données chiffrées : secrets à usage unique (24 h par défaut, 7 jours maximum) et signalements (90 jours ; boîtes de l’organisation 365 jours), sans les clés.
- Les journaux d’accès du serveur web et du proxy peuvent enregistrer les IP comme pour tout site ; l’application elle-même ne journalise pas le contenu des requêtes.
- Mesure d’audience : Umami auto-hébergé, sans cookie, chemin de page uniquement, désactivé sur les pages de secret, de signalement et de Sharewall.

### Ce que voient les autres participants

- En pair-à-pair, chaque pair voit l’adresse IP de l’autre (c’est le fonctionnement de WebRTC), sauf si la connexion passe par TURN.
- Pour masquer votre IP, utilisez un VPN. Tor Browser désactive WebRTC : les transferts pair-à-pair n’y fonctionnent pas.

### Agents IA

- Un agent IA qui lit un Sharewall (CLI ou MCP) envoie tout ce qu’il lit à son fournisseur de modèle. Il ne peut rejoindre que si l’hôte a coché « Autoriser les agents IA ».
- Un secret créé par un assistant IA est vu en clair par l’assistant et son fournisseur : créez vos vrais secrets vous-même dans le navigateur.

### Menaces non couvertes

- Appareil compromis (malware, extension malveillante) côté expéditeur ou destinataire.
- Fuite ou partage du lien complet, ou mot de passe faible.
- Serveur web compromis qui servirait un code JavaScript modifié : comme toute application web, vous faites confiance au code livré à chaque visite (le code source est public, mais les fichiers servis ne sont pas signés).
- Analyse de trafic et métadonnées (qui parle à qui, quand, taille approximative) par le relais, l’hébergeur ou le réseau.
- Destinataire qui copie ou republie ce qu’il a reçu.

### Audit

- Aucun audit de sécurité externe n’a encore été réalisé. Le code est open source (MIT) et les rapports de vulnérabilité sont bienvenus via GitHub.
