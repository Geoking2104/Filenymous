# Filenymous Mailer

Minimal Rust HTTP server (Axum + [lettre](https://docs.rs/lettre/latest/lettre/)) that sends notification emails when a Filenymous transfer is initiated.

The frontend POSTs to `POST /send-email` and this service sends the email via SMTP — no popup, no visible browser action.

## Stack

| Layer     | Crate                                        |
|-----------|----------------------------------------------|
| HTTP      | [axum 0.7](https://docs.rs/axum)             |
| Email     | [lettre 0.11](https://docs.rs/lettre)        |
| Async     | [tokio 1](https://docs.rs/tokio)             |
| CORS      | [tower-http](https://docs.rs/tower-http)     |

## Quick start (local)

```bash
cd mailer
cp .env.example .env
# Edit .env with your SMTP credentials
cargo run
# → Listening on http://0.0.0.0:3000
```

Test it:
```bash
curl -X POST http://localhost:3000/send-email \
  -H 'Content-Type: application/json' \
  -d '{"to":"dest@example.com","from_name":"Alice","from_contact":"alice@example.com","file_names":"photo.jpg","transfer_link":"https://example.com/?r=abc#key","lang":"fr"}'
```

## Deploy on Fly.io (recommended, free tier)

```bash
cd mailer
fly launch --name filenymous-mailer --no-deploy
fly secrets set \
  SMTP_HOST=smtp.gmail.com \
  SMTP_PORT=587 \
  SMTP_USERNAME=you@gmail.com \
  SMTP_PASSWORD="xxxx xxxx xxxx xxxx" \
  FROM_EMAIL=you@gmail.com \
  FROM_NAME=Filenymous \
  ALLOWED_ORIGIN=https://geoking2104.github.io
fly deploy
```

Then set `MAILER_API_URL = 'https://filenymous-mailer.fly.dev'` in `demo/index.html`.

## Deploy on Railway

1. Push this repo to GitHub
2. New project → Deploy from GitHub → select the repo, set root to `mailer/`
3. Add env vars from `.env.example`
4. Copy the Railway URL → paste into `MAILER_API_URL` in `demo/index.html`

## SMTP providers

| Provider     | SMTP_HOST              | Port | Notes                        |
|--------------|------------------------|------|------------------------------|
| Gmail        | smtp.gmail.com         | 587  | Use an App Password          |
| OVH          | ssl0.ovh.net           | 587  | Standard credentials         |
| Mailgun      | smtp.mailgun.org       | 587  | Free 100 emails/day          |
| Brevo        | smtp-relay.brevo.com   | 587  | Free 300 emails/day          |
| Resend       | smtp.resend.com        | 587  | Free 100 emails/day          |

## API

### POST /send-email

```json
{
  "to":            "recipient@example.com",
  "from_name":     "Alice Dupont",
  "from_contact":  "alice@example.com",
  "file_names":    "rapport.pdf, photo.jpg",
  "transfer_link": "https://geoking2104.github.io/Filenymous/?r=abc&sn=Alice&sc=alice%40example.com#key",
  "lang":          "fr"
}
```

Response:
```json
{ "ok": true, "message": "Email sent" }
```

### GET /health

Returns `ok` — use for uptime monitoring.
