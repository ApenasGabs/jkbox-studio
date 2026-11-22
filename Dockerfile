# syntax=docker/dockerfile:1

# ---- Build: frontend (Vite) + backend (tsc) ---------------------------------
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY server server
COPY web web
RUN npm run build

# ---- Production dependencies only (server is pure JS: express + ws) ---------
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace server --no-audit --no-fund

# ---- Runtime ----------------------------------------------------------------
FROM node:24-alpine AS runtime
ARG YTDLP_VERSION=latest
# ffmpeg: audio extraction/conversion · python3: runs the yt-dlp zipapp
# su-exec: drop root after fixing volume permissions · tini: proper PID 1
RUN apk add --no-cache ffmpeg python3 ca-certificates tini su-exec \
  && if [ "$YTDLP_VERSION" = "latest" ]; then \
       url=https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp; \
     else \
       url=https://github.com/yt-dlp/yt-dlp/releases/download/$YTDLP_VERSION/yt-dlp; \
     fi \
  && wget -qO /usr/local/bin/yt-dlp "$url" \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && yt-dlp --version

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    WEB_DIR=/app/web/dist

COPY --from=deps /app/node_modules ./node_modules
COPY server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && mkdir -p /data/music && chown -R node:node /data

VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "server/dist/index.js"]
