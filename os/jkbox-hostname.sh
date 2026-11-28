#!/usr/bin/env bash
# Helper privilegiado para aplicar hostname mDNS (.local) no OS Kiosk do jkbox-studio.
# Chamado via sudoers restrito: NOPASSWD: /usr/local/bin/jkbox-hostname <hostname>
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Uso: jkbox-hostname <hostname>" >&2
  exit 2
fi

RAW_HOSTNAME="$1"
HOSTNAME_CLEAN="$(printf '%s' "$RAW_HOSTNAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/\.local\.?$//')"

if ! printf '%s' "$HOSTNAME_CLEAN" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'; then
  echo "Hostname inválido (RFC 1123): $RAW_HOSTNAME" >&2
  exit 2
fi

if [ "${#HOSTNAME_CLEAN}" -lt 2 ] || [ "${#HOSTNAME_CLEAN}" -gt 63 ]; then
  echo "Hostname deve ter entre 2 e 63 caracteres." >&2
  exit 2
fi

load_env_port() {
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
      PORT|KIOSK_PREFER_PORT_80)
        if [ -z "${!key:-}" ]; then
          printf -v "$key" '%s' "$val"
        fi
        ;;
    esac
  done < "$env_file"
}

JKBOX_ENV_FILE="${JKBOX_ENV_FILE:-/etc/jkbox/jkbox.env}"
JKBOX_ETC_HOSTNAME="${JKBOX_ETC_HOSTNAME:-/etc/hostname}"
JKBOX_ETC_HOSTS="${JKBOX_ETC_HOSTS:-/etc/hosts}"
JKBOX_AVAHI_SERVICE_FILE="${JKBOX_AVAHI_SERVICE_FILE:-/etc/avahi/services/jkbox.service}"
JKBOX_HOSTNAMECTL="${JKBOX_HOSTNAMECTL:-hostnamectl}"
JKBOX_SYSTEMCTL="${JKBOX_SYSTEMCTL:-systemctl}"

load_env_port "$JKBOX_ENV_FILE"

AVAHI_PORT="${PORT:-80}"
if ! printf '%s' "$AVAHI_PORT" | grep -Eq '^[0-9]+$' || [ "$AVAHI_PORT" -lt 1 ] || [ "$AVAHI_PORT" -gt 65535 ]; then
  AVAHI_PORT="80"
fi
case "${KIOSK_PREFER_PORT_80:-}" in
  1|true|TRUE|yes|YES|on|ON)
    AVAHI_PORT="80"
    ;;
esac

if command -v "$JKBOX_HOSTNAMECTL" >/dev/null 2>&1; then
  "$JKBOX_HOSTNAMECTL" set-hostname "$HOSTNAME_CLEAN" || true
fi

printf '%s\n' "$HOSTNAME_CLEAN" > "$JKBOX_ETC_HOSTNAME"

if [ -f "$JKBOX_ETC_HOSTS" ]; then
  if grep -Eq '^127\.0\.1\.1[[:space:]]' "$JKBOX_ETC_HOSTS"; then
    sed -i -E "s|^127\.0\.1\.1[[:space:]].*|127.0.1.1 ${HOSTNAME_CLEAN}.local ${HOSTNAME_CLEAN}|" "$JKBOX_ETC_HOSTS"
  else
    printf '127.0.1.1 %s.local %s\n' "$HOSTNAME_CLEAN" "$HOSTNAME_CLEAN" >> "$JKBOX_ETC_HOSTS"
  fi
fi

AVAHI_DIR="$(dirname "$JKBOX_AVAHI_SERVICE_FILE")"
if [ -d "$AVAHI_DIR" ] && [ -w "$AVAHI_DIR" ]; then
  cat > "$JKBOX_AVAHI_SERVICE_FILE" <<EOF
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">jkbox-studio (%h)</name>
  <service>
    <type>_http._tcp</type>
    <port>${AVAHI_PORT}</port>
    <txt-record>path=/</txt-record>
    <txt-record>app=jkbox</txt-record>
  </service>
</service-group>
EOF
fi

if command -v "$JKBOX_SYSTEMCTL" >/dev/null 2>&1; then
  "$JKBOX_SYSTEMCTL" reload-or-restart avahi-daemon.service >/dev/null 2>&1 || true
fi

printf '%s.local\n' "$HOSTNAME_CLEAN"
