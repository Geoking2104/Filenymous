# Filenymous Push Server

Backend Web Push (VAPID) pour les notifications hors-ligne / onglet fermé.

## Démarrage local (Windows PowerShell)

```powershell
cd push-server
npm install
npm run vapid

# Créer .env (lu automatiquement au démarrage)
@"
PORT=3091
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
PUSH_API_SECRET=change-me-push-secret
CORS_ORIGIN=http://localhost:5173,https://filenymous.eu,https://geoking2104.github.io
VAPID_SUBJECT=mailto:contact@filenymous.eu
"@ | Set-Content -Path .env -Encoding utf8

npm start
```

## Docker

```bash
docker build -t filenymous-push .
docker run -p 3091:3091 --env-file .env filenymous-push
```

## Endpoints

| Méthode | Chemin | Auth | Description |
|---------|--------|------|-------------|
| GET | `/health` | — | Santé + nb abonnements |
| GET | `/api/push/vapid-public-key` | — | Clé publique VAPID |
| POST | `/api/push/subscribe` | — | Enregistre un `PushSubscription` |
| DELETE | `/api/push/unsubscribe` | — | Retire un endpoint |
| POST | `/api/push/send` | Bearer `PUSH_API_SECRET` | Envoie une notif |

### Send

```bash
curl -X POST http://localhost:3091/api/push/send \
  -H "Authorization: Bearer change-me-push-secret" \
  -H "Content-Type: application/json" \
  -d '{"userId":"anonymous","title":"Nouveau fichier","body":"rapport.pdf","tab":"receive","kind":"transfer"}'
```

Cibles : `endpoint`, `userId`, `topic`, ou `broadcast: true`.

## UI

```env
VITE_VAPID_PUBLIC_KEY=<public>
VITE_PUSH_API_URL=http://localhost:3091
# en prod, ex: https://push.filenymous.eu
```
