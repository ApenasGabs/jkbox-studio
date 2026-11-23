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

if command -v hostnamectl >/dev/null 2>&1; then
  hostnamectl set-hostname "$HOSTNAME_CLEAN" || true
fi

printf '%s\n' "$HOSTNAME_CLEAN" > /etc/hostname

if [ -f /etc/hosts ]; then
  if grep -Eq '^127\.0\.1\.1[[:space:]]' /etc/hosts; then
    sed -i -E "s|^127\.0\.1\.1[[:space:]].*|127.0.1.1 ${HOSTNAME_CLEAN}.local ${HOSTNAME_CLEAN}|" /etc/hosts
  else
    printf '127.0.1.1 %s.local %s\n' "$HOSTNAME_CLEAN" "$HOSTNAME_CLEAN" >> /etc/hosts
  fi
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl reload-or-restart avahi-daemon.service >/dev/null 2>&1 || true
fi

printf '%s.local\n' "$HOSTNAME_CLEAN"
