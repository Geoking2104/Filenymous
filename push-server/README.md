# Filenymous Push Server

Backend Web Push (VAPID) pour les notifications hors-ligne / onglet fermé.

## Démarrage

```bash
cd push-server
npm install
npm run vapid          # génère les clés VAPID
# copier les clés dans .env puis :
npm start
```

## Endpoints

| Méthode | Chemin | Auth | Description |
|---------|--------|------|-------------|
| GET | `/health` | — | Santé + nb abonnements |
| GET | `/api/push/vapid-public-key` | — | Clé publique VAPID |
| POST | `/api/push/subscribe` | — | Enregistre un `PushSubscription` |
| DELETE | `/api/push/unsubscribe` | — | Retire un endpoint |
| POST | `/api/push/send` | Bearer `PUSH_API_SECRET` | Envoie une notif |

### Subscribe

```json
{
  "subscription": { "endpoint": "https://…", "keys": { "p256dh": "…", "auth": "…" } },
  "userId": "contact-hash-or-peer-id",
  "topics": ["rooms", "transfers"]
}
```

### Send

```bash
curl -X POST http://localhost:3091/api/push/send \
  -H "Authorization: Bearer change-me-push-secret" \
  -H "Content-Type: application/json" \
  -d '{"userId":"alice","title":"Nouveau fichier","body":"rapport.pdf","tab":"receive","kind":"transfer"}'
```

Cibles possibles : `endpoint`, `userId`, `topic`, ou `broadcast: true`.

## UI

```env
VITE_VAPID_PUBLIC_KEY=<public>
VITE_PUSH_API_URL=http://localhost:3091
```

Après permission navigateur, le client s’abonne et POST le subscription sur le serveur.
