# ── Bootstrap server (kitsune-p2p-bootstrap) ──────────────────────────────
# Handles peer discovery: agents register their network addresses here so
# other nodes can find them on the public internet.
#
# The binary is shipped with Holochain's release artifacts.
# We install it from Cargo to keep the image self-contained.

FROM rust:1.81-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev && \
    rm -rf /var/lib/apt/lists/*

# Pin to the same kitsune2 version used by the Holochain conductor
RUN cargo install kitsune2-bootstrap-srv \
    --version "0.2" \
    --locked \
    --root /usr/local

# ── Runtime image ──────────────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libssl3 && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/bin/kitsune2-bootstrap-srv /usr/local/bin/

# Default port — override with -p at `docker run` time
EXPOSE 8787

# Serve bootstrap on 0.0.0.0:8787 (no TLS; terminate SSL at reverse proxy)
CMD ["kitsune2-bootstrap-srv", "--listen", "0.0.0.0:8787"]
