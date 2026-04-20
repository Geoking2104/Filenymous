//! Filenymous backend — two responsibilities:
//!
//! 1. POST /send-email  — send notification email via lettre/SMTP
//! 2. GET  /relay/{id}  — WebSocket relay (Syncthing-style)
//!
//! The relay simply forwards raw bytes between two WebSocket clients that
//! share the same session ID.  All content is AES-256-GCM encrypted in the
//! browser — the relay is blind to file data.
//!
//! Secrets (Secrets.toml locally, `cargo shuttle secret set` in prod):
//!   SMTP_HOST / SMTP_PORT / SMTP_USERNAME / SMTP_PASSWORD
//!   FROM_EMAIL / FROM_NAME
//!   ALLOWED_ORIGIN   (e.g. https://geoking2104.github.io)

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::{HeaderValue, Method, StatusCode},
    routing::{get, post},
    Json, Router,
};
use futures::{sink::SinkExt, stream::StreamExt};
use lettre::{
    message::header::ContentType,
    transport::smtp::authentication::Credentials,
    AsyncSmtpTransport, AsyncTransport, Message as Email, Tokio1Executor,
};
use serde::{Deserialize, Serialize};
use shuttle_runtime::SecretStore;
use tokio::sync::{mpsc, oneshot};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing::{info, warn};

// ── Relay session store ───────────────────────────────────────────────────────

/// One slot in the relay map: the first peer that connected, waiting for a partner.
struct WaitingPeer {
    /// Channel to forward messages TO this peer (from its future partner)
    to_peer: mpsc::UnboundedSender<Message>,
    /// Oneshot: second peer sends its own tx here to complete the handshake
    on_join: oneshot::Sender<mpsc::UnboundedSender<Message>>,
    /// When this session was created (for TTL cleanup)
    created: Instant,
}

type RelayStore = Arc<Mutex<HashMap<String, WaitingPeer>>>;

// ── Shared app state ──────────────────────────────────────────────────────────

#[derive(Clone)]
struct AppState {
    mailer:     Arc<AsyncSmtpTransport<Tokio1Executor>>,
    from_email: String,
    from_name:  String,
    relay:      RelayStore,
}

// ── Email DTOs ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct EmailRequest {
    to:            String,
    from_name:     String,
    from_contact:  String,
    file_names:    String,
    transfer_link: String,
    #[serde(default)]
    lang: String,
}

#[derive(Serialize)]
struct EmailResponse {
    ok:      bool,
    message: String,
}

// ── Email handler ─────────────────────────────────────────────────────────────

async fn handle_send_email(
    State(state): State<AppState>,
    Json(req): Json<EmailRequest>,
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
             — Filenymous (AES-256-GCM bout-en-bout, aucun serveur ne voit votre fichier)",
            req.from_name, req.from_contact, req.file_names, req.transfer_link
        )
    } else {
        format!(
            "Hi,\n\n\
             {} ({}) is sending you: {}\n\n\
             Click this link to download.\n\
             ⚠️  Session valid for 120 seconds — open it now.\n\n\
             {}\n\n\
             Keep the sender's tab open during the transfer.\n\n\
             — Filenymous (AES-256-GCM end-to-end encryption, no server sees your file)",
            req.from_name, req.from_contact, req.file_names, req.transfer_link
        )
    };

    let from_addr = format!("{} <{}>", state.from_name, state.from_email);
    let email = match Email::builder()
        .from(from_addr.parse().unwrap())
        .to(match req.to.parse() {
            Ok(a) => a,
            Err(e) => return (
                StatusCode::BAD_REQUEST,
                Json(EmailResponse { ok: false, message: format!("Invalid address: {e}") }),
            ),
        })
        .subject(subject)
        .header(ContentType::TEXT_PLAIN)
        .body(body)
    {
        Ok(m) => m,
        Err(e) => return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(EmailResponse { ok: false, message: e.to_string() }),
        ),
    };

    match state.mailer.send(email).await {
        Ok(_) => {
            info!("✓ Email → {}", req.to);
            (StatusCode::OK, Json(EmailResponse { ok: true, message: "Email sent".into() }))
        }
        Err(e) => {
            warn!("SMTP error: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR,
             Json(EmailResponse { ok: false, message: e.to_string() }))
        }
    }
}

// ── WebSocket relay ───────────────────────────────────────────────────────────

async fn ws_relay_handler(
    Path(id): Path<String>,
    State(state): State<AppState>,
    ws: WebSocketUpgrade,
) -> axum::response::Response {
    ws.on_upgrade(move |socket| relay_session(socket, id, state.relay))
}

/// Core relay logic — inspired by Syncthing's relay protocol:
/// - First peer to connect waits (sends {"type":"waiting"})
/// - Second peer triggers full-duplex byte forwarding (sends {"type":"connected"} to both)
/// - Relay is content-blind: AES-256-GCM encryption happens in the browser
async fn relay_session(socket: WebSocket, id: String, store: RelayStore) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    // Channel: messages addressed TO this peer (forwarded from partner)
    let (my_tx, mut my_rx) = mpsc::unbounded_channel::<Message>();

    // ── Try to join an existing session or create one ─────────────────────────
    enum Role {
        First(oneshot::Receiver<mpsc::UnboundedSender<Message>>),
        Second(mpsc::UnboundedSender<Message>),
    }

    let role = {
        let mut map = store.lock().unwrap();

        // Evict stale sessions (>130 s) while we hold the lock
        map.retain(|_, v| v.created.elapsed() < Duration::from_secs(130));

        if let Some(waiting) = map.remove(&id) {
            // Second peer — notify the waiting first peer of our channel
            let _ = waiting.on_join.send(my_tx.clone());
            Role::Second(waiting.to_peer)
        } else {
            // First peer — register ourselves and wait
            let (join_tx, join_rx) = oneshot::channel();
            map.insert(id.clone(), WaitingPeer {
                to_peer: my_tx.clone(),
                on_join: join_tx,
                created: Instant::now(),
            });
            Role::First(join_rx)
        }
    };

    // ── Role: first peer (waiting) ────────────────────────────────────────────
    let partner_tx = match role {
        Role::First(join_rx) => {
            // Tell sender the relay is ready
            let _ = ws_tx.send(msg_json(r#"{"type":"waiting"}"#)).await;

            tokio::select! {
                // Partner arrived
                Ok(partner_tx) = join_rx => {
                    info!("Relay {} — connected", id);
                    partner_tx
                }
                // Timeout — first peer waited too long
                _ = tokio::time::sleep(Duration::from_secs(130)) => {
                    store.lock().unwrap().remove(&id);
                    let _ = ws_tx.send(msg_json(r#"{"type":"timeout"}"#)).await;
                    info!("Relay {} — timeout", id);
                    return;
                }
                // First peer disconnected while waiting
                _ = ws_rx.next() => {
                    store.lock().unwrap().remove(&id);
                    return;
                }
            }
        }
        Role::Second(partner_tx) => partner_tx,
    };

    // ── Both peers connected — notify and forward ─────────────────────────────
    let _ = partner_tx.send(msg_json(r#"{"type":"connected"}"#));
    let _ = ws_tx.send(msg_json(r#"{"type":"connected"}"#)).await;

    // Bidirectional forwarding loop
    loop {
        tokio::select! {
            // Message from partner → our WebSocket
            incoming = my_rx.recv() => {
                match incoming {
                    Some(m) => { if ws_tx.send(m).await.is_err() { break; } }
                    None    => break,
                }
            }
            // Message from our WebSocket → partner
            outgoing = ws_rx.next() => {
                match outgoing {
                    Some(Ok(m)) => { if partner_tx.send(m).is_err() { break; } }
                    _           => break,
                }
            }
        }
    }

    // Tell the partner this peer left
    let _ = partner_tx.send(msg_json(r#"{"type":"disconnected"}"#));
    info!("Relay {} — peer left", id);
}

fn msg_json(s: &str) -> Message {
    Message::Text(s.to_string())
}

// ── Health check ──────────────────────────────────────────────────────────────

async fn health() -> &'static str { "ok" }

// ── Shuttle entry point ───────────────────────────────────────────────────────

#[shuttle_runtime::main]
async fn main(
    #[shuttle_runtime::Secrets] secrets: SecretStore,
) -> shuttle_axum::ShuttleAxum {

    tracing_subscriber::fmt()
        .with_env_filter("filenymous_mailer=info,tower_http=warn")
        .init();

    let smtp_host  = secret(&secrets, "SMTP_HOST");
    let smtp_port: u16 = secrets.get("SMTP_PORT")
        .unwrap_or_else(|| "587".into())
        .parse().expect("SMTP_PORT must be u16");
    let smtp_user  = secret(&secrets, "SMTP_USERNAME");
    let smtp_pass  = secret(&secrets, "SMTP_PASSWORD");
    let from_email = secrets.get("FROM_EMAIL").unwrap_or_else(|| smtp_user.clone());
    let from_name  = secrets.get("FROM_NAME").unwrap_or_else(|| "Filenymous".into());
    let allowed    = secrets.get("ALLOWED_ORIGIN").unwrap_or_else(|| "*".into());

    let creds  = Credentials::new(smtp_user, smtp_pass);
    let mailer = AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&smtp_host)
        .expect("SMTP relay build failed")
        .port(smtp_port)
        .credentials(creds)
        .build();

    let state = AppState {
        mailer:     Arc::new(mailer),
        from_email,
        from_name,
        relay:      Arc::new(Mutex::new(HashMap::new())),
    };

    let cors = build_cors(&allowed);

    let router = Router::new()
        .route("/send-email",  post(handle_send_email))
        .route("/relay/:id",   get(ws_relay_handler))
        .route("/health",      get(health))
        .layer(cors)
        .with_state(state);

    Ok(router.into())
}

fn build_cors(origin: &str) -> CorsLayer {
    if origin == "*" {
        CorsLayer::new()
            .allow_origin(tower_http::cors::Any)
            .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
            .allow_headers(tower_http::cors::Any)
    } else {
        let hv: HeaderValue = origin.parse().expect("Invalid ALLOWED_ORIGIN");
        CorsLayer::new()
            .allow_origin(AllowOrigin::exact(hv))
            .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
            .allow_headers(tower_http::cors::Any)
    }
}

fn secret(store: &SecretStore, key: &str) -> String {
    store.get(key).unwrap_or_else(|| panic!("Secret '{key}' is required"))
}
