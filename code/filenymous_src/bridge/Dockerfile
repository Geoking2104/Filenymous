# ── Bridge — notification micro-service ───────────────────────────────────
# Fastify server: OTP (TOTP), email (SendGrid), SMS (Twilio)
# Stateless — no database — safe to run multiple replicas behind a load balancer.

# ── Build stage ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript → dist/
RUN npx tsc

# ── Runtime stage ──────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Only production node_modules
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist         ./dist

# Run as non-root
RUN addgroup -S filenymous && adduser -S filenymous -G filenymous
USER filenymous

# Port exposed by Fastify (override with PORT env var)
EXPOSE 3001

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:${PORT:-3001}/health || exit 1

CMD ["node", "dist/index.js"]
