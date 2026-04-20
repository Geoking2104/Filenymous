# ── Build stage ──────────────────────────────────────────────────────────────
FROM rust:1.78-slim AS builder

RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY Cargo.toml ./
# Pre-fetch dependencies (layer cache)
RUN mkdir src && echo 'fn main(){}' > src/main.rs && cargo build --release && rm -rf src

COPY src ./src
# Touch main.rs so cargo rebuilds it
RUN touch src/main.rs && cargo build --release

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/filenymous-mailer /usr/local/bin/filenymous-mailer

EXPOSE 3000

CMD ["filenymous-mailer"]
