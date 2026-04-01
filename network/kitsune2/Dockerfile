# ── kitsune2-bootstrap-srv (bootstrap + SBD signal) ───────────────────────
#
# Builds the official kitsune2 bootstrap/signal server from source.
# Source: https://github.com/holochain/kitsune2
#
# A single binary handles both:
#   - Peer discovery (bootstrap, HTTP/HTTPS REST)
#   - WebRTC signaling & relay (SBD, WS/WSS)
# on the same port 443 (production) or a custom port (dev/test).
#
# TLS is managed internally by the binary (rustls) — no external TLS
# termination needed for this service. Mount your PEM certificates.
#
# CLI flags of interest:
#   --production          Enforce TLS + stricter limits
#   --listen [::]:443     Bind address (default: 443)
#   --tls-cert <path>     TLS certificate (PEM)
#   --tls-key  <path>     TLS private key (PEM)
#   --sbd-*               SBD-specific tuning params (e.g. --sbd-limit-clients)
#
# Environment:
#   RUST_LOG=info         Log verbosity

FROM rust:1.93-bookworm AS builder

WORKDIR /usr/src/kitsune2

# Clone the kitsune2 workspace and build only the bootstrap_srv crate
# with the sbd feature (combines peer discovery + WebRTC relay).
# Pin to the latest stable tag — update when Holochain bumps its dependency.
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev git && \
    rm -rf /var/lib/apt/lists/*

ARG KITSUNE2_TAG=v0.4.0-dev.6
RUN git clone --depth 1 --branch ${KITSUNE2_TAG} \
    https://github.com/holochain/kitsune2.git .

# Build the bootstrap server with the SBD (signal/relay) backend
RUN cargo install \
    --path ./crates/bootstrap_srv \
    --bin kitsune2-bootstrap-srv \
    --no-default-features \
    --features sbd \
    --locked

# ── Runtime image ──────────────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libssl3 && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/cargo/bin/kitsune2-bootstrap-srv /usr/local/bin/

# Directory for TLS certificates (mount as a volume or Docker secret)
RUN mkdir -p /etc/kitsune2

# Both HTTPS (bootstrap REST) and WSS (SBD signal) run on port 443
EXPOSE 443

ENV RUST_LOG=info

# Production: TLS required.
# For dev (no TLS), override CMD: ["kitsune2-bootstrap-srv", "--listen", "[::]:8787"]
CMD ["kitsune2-bootstrap-srv", \
     "--production", \
     "--listen", "[::]:443", \
     "--tls-cert", "/etc/kitsune2/cert.pem", \
     "--tls-key",  "/etc/kitsune2/key.pem"]
