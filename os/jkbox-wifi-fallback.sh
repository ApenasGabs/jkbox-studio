#!/usr/bin/env bash
set -euo pipefail

# Fallback Wi-Fi Hotspot (jkbox-setup) when no Ethernet or saved Wi-Fi connects after boot.

log() {
  printf '[jkbox-wifi-fallback] %s\n' "$*"
}

err() {
  printf '[jkbox-wifi-fallback] ERRO: %s\n' "$*" >&2
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
      PORT|JKBOX_HOTSPOT_SSID|JKBOX_HOTSPOT_PASSWORD|JKBOX_HOTSPOT_CON|JKBOX_WIFI_WAIT_SEC)
        if [ -z "${!key:-}" ]; then
          printf -v "$key" '%s' "$val"
        fi
        ;;
    esac
  done < "$env_file"
}

JKBOX_ENV_FILE="${JKBOX_ENV_FILE:-/etc/jkbox/jkbox.env}"
load_env_file "$JKBOX_ENV_FILE"

JKBOX_NMCLI="${JKBOX_NMCLI:-nmcli}"
JKBOX_HOTSPOT_SSID="${JKBOX_HOTSPOT_SSID:-jkbox-setup}"
JKBOX_HOTSPOT_PASSWORD="${JKBOX_HOTSPOT_PASSWORD:-jkboxsetup}"
JKBOX_HOTSPOT_CON="${JKBOX_HOTSPOT_CON:-jkbox-setup}"
JKBOX_WIFI_WAIT_SEC="${JKBOX_WIFI_WAIT_SEC:-20}"
JKBOX_SLEEP_CMD="${JKBOX_SLEEP_CMD:-sleep}"

if ! command -v "$JKBOX_NMCLI" >/dev/null 2>&1; then
  err "nmcli não encontrado (${JKBOX_NMCLI})"
  exit 1
fi

has_active_network() {
  "$JKBOX_NMCLI" -t -f TYPE,STATE dev 2>/dev/null | grep -Eq '^(ethernet|wifi):connected$'
}

hotspot_already_active() {
  "$JKBOX_NMCLI" -t -f NAME con show --active 2>/dev/null | grep -Fxq "$JKBOX_HOTSPOT_CON"
}

if hotspot_already_active; then
  log "Hotspot ${JKBOX_HOTSPOT_CON} já está ativo."
  exit 0
fi

elapsed=0
while [ "$elapsed" -lt "$JKBOX_WIFI_WAIT_SEC" ]; do
  if has_active_network; then
    log "Conexão de rede ativa detectada; hotspot de fallback não necessário."
    exit 0
  fi
  "$JKBOX_SLEEP_CMD" 1
  elapsed=$((elapsed + 1))
done

if has_active_network; then
  log "Conexão de rede ativa detectada; hotspot de fallback não necessário."
  exit 0
fi

WIFI_IF="$("$JKBOX_NMCLI" -t -f DEVICE,TYPE dev 2>/dev/null | awk -F: '$2 == "wifi" { print $1; exit }')"
if [ -z "$WIFI_IF" ]; then
  log "Nenhuma interface Wi-Fi detectada; pulando hotspot de fallback."
  exit 0
fi

if [ "${#JKBOX_HOTSPOT_PASSWORD}" -lt 8 ]; then
  err "JKBOX_HOTSPOT_PASSWORD deve ter ao menos 8 caracteres para WPA2."
  exit 1
fi

PORT="${PORT:-80}"
if [ "$PORT" = "80" ]; then
  HOTSPOT_URL="http://10.42.0.1"
else
  HOTSPOT_URL="http://10.42.0.1:${PORT}"
fi

log "Sem rede ativa após ${JKBOX_WIFI_WAIT_SEC}s. Iniciando hotspot ${JKBOX_HOTSPOT_SSID} na interface ${WIFI_IF}..."
"$JKBOX_NMCLI" con delete "$JKBOX_HOTSPOT_CON" >/dev/null 2>&1 || true
"$JKBOX_NMCLI" dev wifi hotspot ifname "$WIFI_IF" con-name "$JKBOX_HOTSPOT_CON" ssid "$JKBOX_HOTSPOT_SSID" password "$JKBOX_HOTSPOT_PASSWORD"
"$JKBOX_NMCLI" con modify "$JKBOX_HOTSPOT_CON" connection.autoconnect no >/dev/null 2>&1 || true
log "Hotspot ${JKBOX_HOTSPOT_SSID} ativo! Conecte-se para configurar o Wi-Fi ou acessar ${HOTSPOT_URL}."
