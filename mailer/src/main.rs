//! Filenymous Mailer — minimal Axum HTTP server that relays notification
//! emails via lettre/SMTP.  The frontend (GitHub Pages static app) POSTs to
//! POST /send-email and this service sends the email in the background.
//!
//! Environment variables (see .env.example):
//!   SMTP_HOST        e.g. smtp.gmail.com
//!   SMTP_PORT        default 587 (STARTTLS)
//!   SMTP_USERNAME    your email address / SMTP login
//!   SMTP_PASSWORD    app password (never your real password!)
//!   FROM_EMAIL       optional — defaults to SMTP_USERNAME
//!   FROM_NAME        optional — defaults to "Filenymous"
//!   ALLOWED_ORIGIN   e.g. https://geoking2104.github.io  (or * for dev)
//!   PORT             default 3000

use std::{net::SocketAddr, sync::Arc};

use axum::{
    extract::State,
    http::{HeaderValue, Method, StatusCode},
    routing::post,
    Json, Router,
};
use lettre::{
    message::header::ContentType,
    transport::smtp::authentication::Credentials,
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
};
use serde::{Deserialize, Serialize};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing::{error, info};

// ── State shared across handlers ────────────────────────────────────────────

#[derive(Clone)]
struct AppState {
    mailer:     Arc<AsyncSmtpTransport<Tokio1Executor>>,
    from_email: String,
    from_name:  String,
}

// ── Request / response DTOs ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct EmailRequest {
    /// Recipient email address
    to:           String,
    /// Sender's full name (shown in email body)
    from_name:    String,
    /// Sender's email or phone (shown in email body)
    from_contact: String,
    /// Comma-separated file names
    file_names:   String,
    /// The Filenymous share URL (contains the peer-id + AES fragment)
    transfer_link: String,
    /// Optional language hint ("fr" | "en" | …)
    #[serde(default)]
    lang:         String,
}

#[derive(Serialize)]
struct EmailResponse {
    ok:      bool,
    message: String,
}

// ── Email handler ────────────────────────────────────────────────────────────

async fn handle_send_email(
    State(state): State<AppState>,
    Json(req):    Json<EmailRequest>,
) -> (StatusCode, Json<EmailResponse>) {

    let lang = req.lang.as_str();

    let subject = if lang == "fr" {
        format!("{} vous envoie un fichier via Filenymous", req.from_name)
    } else {
        format!("{} is sending you a file via Filenymous", req.from_name)
    };

    let body = if lang == "fr" {
        format!(
            "Bonjour,\n\n\
             {} ({}) vous envoie : {}\n\n\
             Cliquez ce lien pour télécharger\n\
             ⚠️  La session est valable 120 secondes — ouvrez-le maintenant :\n\n\
             {}\n\n\
             L'onglet de l'expéditeur doit rester ouvert pendant le transfert.\n\n\
             — Filenymous (chiffrement AES-256-GCM bout-en-bout, aucun serveur ne voit votre fichier)",
            req.from_name, req.from_contact, req.file_names, req.transfer_link
        )
    } else {
        format!(
            "Hi,\n\n\
             {} ({}) is sending you: {}\n\n\
             Click the link below to download.\n\
             ⚠️  The session is valid for 120 seconds — open it now:\n\n\
             {}\n\n\
             Keep the sender's tab open during the transfer.\n\n\
             — Filenymous (AES-256-GCM end-to-end encryption, no server sees your file)",
            req.from_name, req.from_contact, req.file_names, req.transfer_link
        )
    };

    // Parse addresses
    let from_addr = format!("{} <{}>", state.from_name, state.from_email);
    let to_addr   = req.to.clone();

    let email = match Message::builder()
        .from(from_addr.parse().unwrap_or_else(|_| state.from_email.parse().unwrap()))
        .to(match to_addr.parse() {
            Ok(a) => a,
            Err(e) => {
                error!("Invalid to address {}: {}", to_addr, e);
                return (
                    StatusCode::BAD_REQUEST,
                    Json(EmailResponse { ok: false, message: format!("Invalid to address: {e}") }),
                );
            }
        })
        .subject(subject)
        .header(ContentType::TEXT_PLAIN)
        .body(body)
    {
        Ok(m)  => m,
        Err(e) => {
            error!("Message build error: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(EmailResponse { ok: false, message: e.to_string() }),
            );
        }
    };

    match state.mailer.send(email).await {
        Ok(_) => {
            info!("Email sent to {}", req.to);
            (StatusCode::OK, Json(EmailResponse { ok: true, message: "Email sent".into() }))
        }
        Err(e) => {
            error!("SMTP error: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(EmailResponse { ok: false, message: e.to_string() }),
            )
        }
    }
}

// ── Health check ─────────────────────────────────────────────────────────────

async fn health() -> &'static str { "ok" }

// ── Main ─────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "filenymous_mailer=info".into()),
        )
        .init();

    dotenvy::dotenv().ok();

    let smtp_host = env("SMTP_HOST");
    let smtp_port: u16 = std::env::var("SMTP_PORT")
        .unwrap_or_else(|_| "587".to_string())
        .parse()
        .expect("SMTP_PORT must be a number");
    let smtp_user = env("SMTP_USERNAME");
    let smtp_pass = env("SMTP_PASSWORD");
    let from_email = std::env::var("FROM_EMAIL").unwrap_or_else(|_| smtp_user.clone());
    let from_name  = std::env::var("FROM_NAME").unwrap_or_else(|_| "Filenymous".to_string());
    let allowed_origin = std::env::var("ALLOWED_ORIGIN").unwrap_or_else(|_| "*".to_string());
    let port: u16 = std::env::var("PORT")
        .unwrap_or_else(|_| "3000".to_string())
        .parse()
        .expect("PORT must be a number");

    // Build async SMTP transport (STARTTLS on port 587)
    let creds   = Credentials::new(smtp_user, smtp_pass);
    let mailer  = AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&smtp_host)
        .expect("SMTP relay build failed")
        .port(smtp_port)
        .credentials(creds)
        .build();

    let state = AppState {
        mailer: Arc::new(mailer),
        from_email,
        from_name,
    };

    // CORS — restrict to the GitHub Pages origin in production
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

    let app = Router::new()
        .route("/send-email", post(handle_send_email))
        .route("/health",     axum::routing::get(health))
        .layer(cors)
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!("Filenymous mailer listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn env(key: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| panic!("{key} environment variable is required"))
}
