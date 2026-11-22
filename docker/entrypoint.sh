#!/bin/sh
set -e

DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR/music"

if [ "$(id -u)" = "0" ]; then
  # YouTube changes often; keep yt-dlp fresh unless disabled (non-fatal when offline).
  if [ "${YTDLP_AUTO_UPDATE:-true}" = "true" ]; then
    timeout 60 yt-dlp -U >/dev/null 2>&1 && echo "[jkbox] yt-dlp $(yt-dlp --version)" || echo "[jkbox] yt-dlp: atualização ignorada"
  fi
  # Bind mounts (./data) are often created by root on the host: hand them to the app user.
  if [ "$(stat -c %u "$DATA_DIR")" != "$(id -u node)" ] || [ "$(stat -c %u "$DATA_DIR/music")" != "$(id -u node)" ]; then
    chown -R node:node "$DATA_DIR"
  fi
  exec su-exec node "$@"
fi

exec "$@"
