FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server.js ./
COPY scripts ./scripts
ENV NODE_ENV=production
ENV PORT=3091
EXPOSE 3091
CMD ["node", "server.js"]
