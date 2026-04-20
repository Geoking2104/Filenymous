# Filenymous Mailer

Minimal Rust HTTP service (Axum + [lettre](https://docs.rs/lettre/latest/lettre/)) deployed on [Shuttle.rs](https://shuttle.rs) — free, no Docker, no server to manage.

The frontend POSTs to `POST /send-email` and this service sends the notification email via SMTP in the background.

## Stack

| Layer    | Crate                                         |
|----------|-----------------------------------------------|
| Runtime  | [shuttle-runtime 0.48](https://docs.shuttle.rs) |
| HTTP     | [axum 0.7](https://docs.rs/axum)              |
| Email    | [lettre 0.11](https://docs.rs/lettre)         |
| Async    | [tokio 1](https://docs.rs/tokio)              |
| CORS     | [tower-http](https://docs.rs/tower-http)      |

---

## Deploy on Shuttle.rs (free)

### 1 — Install cargo-shuttle

```powershell
cargo install cargo-shuttle
```

### 2 — Login

```powershell
cargo shuttle login
```

### 3 — Create the project (once)

```powershell
cd mailer
cargo shuttle project new --name filenymous-mailer
```

### 4 — Set secrets in production

```powershell
cargo shuttle secret set SMTP_HOST smtp.gmail.com
cargo shuttle secret set SMTP_PORT 587
cargo shuttle secret set SMTP_USERNAME you@gmail.com
cargo shuttle secret set SMTP_PASSWORD "xxxx xxxx xxxx xxxx"
cargo shuttle secret set FROM_EMAIL you@gmail.com
cargo shuttle secret set FROM_NAME Filenymous
cargo shuttle secret set ALLOWED_ORIGIN https://geoking2104.github.io
```

### 5 — Deploy

```powershell
cargo shuttle deploy
```

Shuttle gives you a URL like `https://filenymous-mailer.shuttleapp.rs`.

### 6 — Wire up the frontend

Open `demo/index.html` and set:

```javascript
const MAILER_API_URL = 'https://filenymous-mailer.shuttleapp.rs';
```

Then commit + push → GitHub Pages picks it up automatically.

---

## Local development

```powershell
cp Secrets.toml.example Secrets.toml
# Edit Secrets.toml with your SMTP credentials
cargo shuttle run
# → http://localhost:8000
```

Test:
```powershell
curl -X POST http://localhost:8000/send-email `
  -H "Content-Type: application/json" `
  -d '{"to":"dest@example.com","from_name":"Alice","from_contact":"alice@example.com","file_names":"photo.jpg","transfer_link":"https://example.com/?r=abc#key","lang":"fr"}'
```

---

## SMTP providers

| Provider  | SMTP_HOST               | Port | Free quota            |
|-----------|-------------------------|------|-----------------------|
| Gmail     | smtp.gmail.com          | 587  | Use an App Password   |
| Brevo     | smtp-relay.brevo.com    | 587  | 300 emails/day        |
| Resend    | smtp.resend.com         | 587  | 100 emails/day        |
| Mailgun   | smtp.mailgun.org        | 587  | 100 emails/day        |
| OVH       | ssl0.ovh.net            | 587  | Standard credentials  |

---

## API reference

### `POST /send-email`

```json
{
  "to":            "recipient@example.com",
  "from_name":     "Alice Dupont",
  "from_contact":  "alice@example.com",
  "file_names":    "rapport.pdf",
  "transfer_link": "https://geoking2104.github.io/Filenymous/?r=abc&sn=Alice&sc=alice%40...#key",
  "lang":          "fr"
}
```

**Response:**
```json
{ "ok": true, "message": "Email sent" }
```

### `GET /health`

Returns `ok` — use for uptime checks.
