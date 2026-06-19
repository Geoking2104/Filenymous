# ── Bridge — relay WebSocket + email (Resend) ──────────────────────────────
# Stateless : aucune base de données, relay en mémoire.

# ── Build stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
# Installer TOUTES les dépendances (y compris devDeps pour tsc)
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

# Compiler TypeScript → dist/
RUN npx tsc

# Réinstaller uniquement les dépendances de production
RUN npm ci --omit=dev

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist         ./dist

# Exécution en non-root
RUN addgroup -S filenymous && adduser -S filenymous -G filenymous
USER filenymous

EXPOSE 3001

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:${PORT:-3001}/health || exit 1

CMD ["node", "dist/index.js"]
