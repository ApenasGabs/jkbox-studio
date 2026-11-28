#!/usr/bin/env bash
set -euo pipefail

# Launches Chromium in fullscreen kiosk mode after the local jkbox backend is healthy.

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
fi

format_local_http_url() {
  local port="$1"
  local suffix="${2:-/}"
  if [ "$port" = "80" ]; then
    printf 'http://127.0.0.1%s' "$suffix"
  else
    printf 'http://127.0.0.1:%s%s' "$port" "$suffix"
  fi
}

load_env_file() {
  local env_file="$1"
  [ -f "$env_file" ] && [ -r "$env_file" ] || return 0
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    [ -z "$line" ] || [[ "$line" == \#* ]] && continue
    if [[ "$line" == export\ * ]]; then
      line="${line#export }"
      line="${line#"${line%%[![:space:]]*}"}"
    fi
    [[ "$line" != *=* ]] && continue
    key="${line%%=*}"
    key="${key%"${key##*[![:space:]]}"}"
    val="${line#*=}"
    val="${val#"${val%%[![:space:]]*}"}"
    val="${val%"${val##*[![:space:]]}"}"
    if [[ "$val" =~ ^\"(.*)\"$ ]] || [[ "$val" =~ ^\'(.*)\'$ ]]; then
      val="${BASH_REMATCH[1]}"
    fi
    case "$key" in
      PORT|LEGACY_REDIRECT_PORT|KIOSK_PREFER_PORT_80|JKBOX_KIOSK_URL)
        if [ -z "${!key:-}" ]; then
          printf -v "$key" '%s' "$val"
        fi
        ;;
    esac
  done < "$env_file"
}

JKBOX_ENV_FILE="${JKBOX_ENV_FILE:-/etc/jkbox/jkbox.env}"
load_env_file "$JKBOX_ENV_FILE"

PORT="${PORT:-80}"
PRIMARY_PORT="$PORT"
case "${KIOSK_PREFER_PORT_80:-}" in
  1|true|TRUE|yes|YES|on|ON)
    PRIMARY_PORT="80"
    ;;
esac

KIOSK_URL="${JKBOX_KIOSK_URL:-$(format_local_http_url "$PRIMARY_PORT" "/")}"
HEALTH_URL="$(format_local_http_url "$PRIMARY_PORT" "/api/health")"

if [ "$DRY_RUN" -eq 1 ]; then
  printf 'KIOSK_URL=%s\nHEALTH_URL=%s\n' "$KIOSK_URL" "$HEALTH_URL"
  exit 0
fi

find_browser() {
  for candidate in chromium chromium-browser google-chrome; do
    if command -v "$candidate" >/dev/null 2>&1; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

clear_crash_flags() {
  local prefs="${HOME}/.config/chromium/Default/Preferences"
  if [ -f "$prefs" ] && command -v sed >/dev/null 2>&1; then
    sed -i 's/"exited_cleanly":false/"exited_cleanly":true/g; s/"exit_type":"Crashed"/"exit_type":"Normal"/g' "$prefs" 2>/dev/null || true
  fi
}

BROWSER_BIN="$(find_browser || true)"
if [ -z "$BROWSER_BIN" ]; then
  printf '[jkbox-kiosk-browser] ERRO: Chromium não encontrado no PATH.\n' >&2
  exit 1
fi

CANDIDATE_PORTS=("$PRIMARY_PORT")
if [ "$PORT" != "$PRIMARY_PORT" ]; then
  CANDIDATE_PORTS+=("$PORT")
fi
if [ -n "${LEGACY_REDIRECT_PORT:-}" ] && [ "${LEGACY_REDIRECT_PORT}" != "0" ] && [ "${LEGACY_REDIRECT_PORT}" != "$PRIMARY_PORT" ] && [ "${LEGACY_REDIRECT_PORT}" != "$PORT" ]; then
  CANDIDATE_PORTS+=("$LEGACY_REDIRECT_PORT")
fi

for _ in $(seq 1 30); do
  for candidate_port in "${CANDIDATE_PORTS[@]}"; do
    candidate_health="$(format_local_http_url "$candidate_port" "/api/health")"
    if curl -fsS --max-time 2 "$candidate_health" >/dev/null 2>&1; then
      if [ -z "${JKBOX_KIOSK_URL:-}" ]; then
        KIOSK_URL="$(format_local_http_url "$candidate_port" "/")"
      fi
      break 2
    fi
  done
  sleep 1
done

while true; do
  clear_crash_flags
  "$BROWSER_BIN" \
    --kiosk \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --disable-features=TranslateUI \
    --no-first-run \
    --check-for-update-interval=31536000 \
    --autoplay-policy=no-user-gesture-required \
    --use-fake-ui-for-media-stream \
    --ignore-gpu-blocklist \
    --enable-webgl \
    "$KIOSK_URL" || true
  sleep 2
done
