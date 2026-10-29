# ---- build the web console
FROM node:24-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./web
RUN npm run build:web

# ---- runtime
FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    MEDIA_ROOTS=/music \
    PORT=8080 \
    PUBLIC_PORT=8081
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server ./server
COPY --from=web /app/web/dist ./web/dist
VOLUME ["/data"]
EXPOSE 8080 8081
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["tini", "--"]
CMD ["node", "server/main.ts"]
