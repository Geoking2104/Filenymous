# Feuille de route Filenymous

| Fonctionnalité | Effort | Cible | Valeur ajoutée | Statut |
|---|---|---|---|---|
| Secrets Vault | Faible | Dev & IT | Partage de mots de passe et clés API à lecture unique, la clé ne quitte jamais le navigateur | ✅ Livré |
| Mode WebRTC P2P | Élevé | Tous | Transfert direct chiffré de bout en bout, sans stockage serveur | ✅ Livré |
| Dropzone de collecte | Moyen | PME, indépendants | Recevoir des fichiers de n'importe qui sans compte, avec mot de passe et expiration | ✅ Livré |
| CLI & API DevOps (CI/CD) | Moyen | DevOps, équipes CI | `filenymous upload app.zip --ttl 1h` : liens éphémères pour builds, logs et sauvegardes, aucun bucket S3 à mal configurer | 🔜 Bientôt |
| Espace Client-Prestataire | Faible (réutilise la Dropzone) | Avocats, comptables, freelances | Une Dropzone par projet pour collecter les documents confidentiels des clients, sans infrastructure | 🟠 Pro (via Dropzone) |
| Canal de signalement (lanceurs d'alerte) | Élevé | Journalistes, conformité, audit interne | Dépôt chiffré anonyme : aucune IP conservée, compatible Tor, métadonnées (EXIF/PDF) supprimées dans le navigateur, clé de suivi sans e-mail. Pensé pour les exigences RGPD et de la directive lanceurs d'alerte (sans certification revendiquée) | 🔜 Bientôt |
| Partage streamé | Moyen | Vidéastes, studios, podcasteurs | Lecture vidéo/audio pendant le téléchargement (Media Source Extensions), revue de rushes sans saturer le disque | 🔜 Bientôt |

Notes :
- Le canal de signalement ne masque pas l'adresse IP de l'utilisateur ; pour cela, utiliser Tor Browser.
- Aucune conformité (RGPD, NIS2, ISO 27001) n'est revendiquée tant qu'un audit n'a pas eu lieu.
