#!/usr/bin/env bash
set -euo pipefail

# Launches Chromium in fullscreen kiosk mode after the local jkbox backend is healthy.

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
      PORT|JKBOX_KIOSK_URL)
        if [ -z "${!key:-}" ]; then
          printf -v "$key" '%s' "$val"
        fi
        ;;
    esac
  done < "$env_file"
}

JKBOX_ENV_FILE="${JKBOX_ENV_FILE:-/etc/jkbox/jkbox.env}"
load_env_file "$JKBOX_ENV_FILE"

PORT="${PORT:-3000}"
KIOSK_URL="${JKBOX_KIOSK_URL:-http://127.0.0.1:${PORT}/}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"

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

for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
    break
  fi
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
    "$KIOSK_URL" || true
  sleep 2
done
