//! Filenymous Mailer — Axum + lettre, deployed on Shuttle.rs
//!
//! Secrets (local: Secrets.toml  |  prod: cargo shuttle secret set):
//!   SMTP_HOST        e.g. smtp.gmail.com
//!   SMTP_PORT        default 587
//!   SMTP_USERNAME    your SMTP login
//!   SMTP_PASSWORD    app-password (not your real password)
//!   FROM_EMAIL       optional — defaults to SMTP_USERNAME
//!   FROM_NAME        optional — defaults to "Filenymous"
//!   ALLOWED_ORIGIN   e.g. https://geoking2104.github.io

use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderValue, Method, StatusCode},
    routing::{get, post},
    Json, Router,
};
use lettre::{
    message::header::ContentType,
    transport::smtp::authentication::Credentials,
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
};
use serde::{Deserialize, Serialize};
use shuttle_runtime::SecretStore;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing::info;

// ── Shared state ─────────────────────────────────────────────────────────────

#[derive(Clone)]
struct AppState {
    mailer:     Arc<AsyncSmtpTransport<Tokio1Executor>>,
    from_email: String,
    from_name:  String,
}

// ── DTOs ─────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct EmailRequest {
    to:            String,
    from_name:     String,
    from_contact:  String,
    file_names:    String,
    transfer_link: String,
    #[serde(default)]
    lang:          String,
}

#[derive(Serialize)]
struct EmailResponse {
    ok:      bool,
    message: String,
}

// ── Handlers ─────────────────────────────────────────────────────────────────

async fn handle_send_email(
    State(state): State<AppState>,
    Json(req):    Json<EmailRequest>,
) -> (StatusCode, Json<EmailResponse>) {
    let fr = req.lang == "fr";

    let subject = if fr {
        format!("{} vous envoie un fichier via Filenymous", req.from_name)
    } else {
        format!("{} is sending you a file via Filenymous", req.from_name)
    };

    let body = if fr {
        format!(
            "Bonjour,\n\n\
             {} ({}) vous envoie : {}\n\n\
             Cliquez ce lien pour télécharger :\n\
             ⚠️  Session valable 120 secondes — ouvrez-le maintenant.\n\n\
             {}\n\n\
             Gardez l'onglet de l'expéditeur ouvert pendant le transfert.\n\n\
             — Filenymous (AES-256-GCM, bout-en-bout, aucun serveur ne voit votre fichier)",
            req.from_name, req.from_contact, req.file_names, req.transfer_link
        )
    } else {
        format!(
            "Hi,\n\n\
             {} ({}) is sending you: {}\n\n\
             Click the link below to download.\n\
             ⚠️  Session valid for 120 seconds — open it now.\n\n\
             {}\n\n\
             Keep the sender's tab open during the transfer.\n\n\
             — Filenymous (AES-256-GCM end-to-end encryption, no server sees your file)",
            req.from_name, req.from_contact, req.file_names, req.transfer_link
        )
    };

    let from_addr = format!("{} <{}>", state.from_name, state.from_email);

    let email = match Message::builder()
        .from(from_addr.parse().unwrap())
        .to(match req.to.parse() {
            Ok(a)  => a,
            Err(e) => return (
                StatusCode::BAD_REQUEST,
                Json(EmailResponse { ok: false, message: format!("Invalid address: {e}") }),
            ),
        })
        .subject(subject)
        .header(ContentType::TEXT_PLAIN)
        .body(body)
    {
        Ok(m)  => m,
        Err(e) => return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(EmailResponse { ok: false, message: e.to_string() }),
        ),
    };

    match state.mailer.send(email).await {
        Ok(_) => {
            info!("✓ Email sent to {}", req.to);
            (StatusCode::OK, Json(EmailResponse { ok: true, message: "Email sent".into() }))
        }
        Err(e) => {
            tracing::error!("SMTP error: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR,
             Json(EmailResponse { ok: false, message: e.to_string() }))
        }
    }
}

async fn health() -> &'static str { "ok" }

// ── Shuttle entry point ───────────────────────────────────────────────────────

#[shuttle_runtime::main]
async fn main(
    #[shuttle_runtime::Secrets] secrets: SecretStore,
) -> shuttle_axum::ShuttleAxum {

    // Read secrets (defined in Secrets.toml locally, or via CLI in prod)
    let smtp_host    = secret(&secrets, "SMTP_HOST");
    let smtp_port: u16 = secrets.get("SMTP_PORT")
        .unwrap_or_else(|| "587".into())
        .parse().expect("SMTP_PORT must be a number");
    let smtp_user    = secret(&secrets, "SMTP_USERNAME");
    let smtp_pass    = secret(&secrets, "SMTP_PASSWORD");
    let from_email   = secrets.get("FROM_EMAIL").unwrap_or_else(|| smtp_user.clone());
    let from_name    = secrets.get("FROM_NAME").unwrap_or_else(|| "Filenymous".into());
    let allowed_origin = secrets.get("ALLOWED_ORIGIN").unwrap_or_else(|| "*".into());

    // Build async SMTP transport
    let creds  = Credentials::new(smtp_user, smtp_pass);
    let mailer = AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&smtp_host)
        .expect("SMTP relay build failed")
        .port(smtp_port)
        .credentials(creds)
        .build();

    let state = AppState {
        mailer: Arc::new(mailer),
        from_email,
        from_name,
    };

    // CORS
    let cors = if allowed_origin == "*" {
        CorsLayer::new()
            .allow_origin(tower_http::cors::Any)
            .allow_methods([Method::POST, Method::OPTIONS])
            .allow_headers(tower_http::cors::Any)
    } else {
        let origin: HeaderValue = allowed_origin.parse().expect("Invalid ALLOWED_ORIGIN");
        CorsLayer::new()
            .allow_origin(AllowOrigin::exact(origin))
            .allow_methods([Method::POST, Method::OPTIONS])
            .allow_headers(tower_http::cors::Any)
    };

    let router = Router::new()
        .route("/send-email", post(handle_send_email))
        .route("/health",     get(health))
        .layer(cors)
        .with_state(state);

    Ok(router.into())
}

fn secret(store: &SecretStore, key: &str) -> String {
    store.get(key).unwrap_or_else(|| panic!("Secret '{key}' is required"))
}
