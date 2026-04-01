# ── Signal / proxy server (kitsune2-sbd-server) ───────────────────────────
# Provides WebRTC signaling and TURN-like relaying for agents behind NAT.
# Without this, peers on different networks cannot establish direct connections.
#
# SBD = "Simple Broker for Data" — lightweight relay server from Holochain.

FROM rust:1.81-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev && \
    rm -rf /var/lib/apt/lists/*

RUN cargo install kitsune2-sbd-server \
    --version "0.2" \
    --locked \
    --root /usr/local

# ── Runtime image ──────────────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libssl3 && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/bin/kitsune2-sbd-server /usr/local/bin/

# TLS certificate paths — mount as volumes or use a sidecar (e.g. Caddy)
# When running behind a TLS-terminating proxy, set ALLOW_PLAIN=true
ENV ALLOW_PLAIN=false
ENV BIND=0.0.0.0:8788

EXPOSE 8788

CMD ["kitsune2-sbd-server"]
