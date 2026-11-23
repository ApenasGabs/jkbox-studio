#!/usr/bin/env bash
set -euo pipefail

# Automounts USB drives into /data/music/usb-<dev> (read-only) and triggers /api/library/rescan.

ACTION="${1:-}"
RAW_DEV="${2:-}"

log() {
  printf '[jkbox-usb-mount] %s\n' "$*"
}

err() {
  printf '[jkbox-usb-mount] ERRO: %s\n' "$*" >&2
}

if [ "$ACTION" != "add" ] && [ "$ACTION" != "remove" ]; then
  err "Uso: $0 <add|remove> <devname>"
  exit 2
fi

DEV_NAME="${RAW_DEV#/dev/}"
if [ -z "$DEV_NAME" ] || [ "$DEV_NAME" = "." ] || [ "$DEV_NAME" = ".." ] || ! printf '%s' "$DEV_NAME" | grep -Eq '^[A-Za-z0-9._-]+$'; then
  err "Nome de dispositivo inválido: ${RAW_DEV}"
  exit 2
fi
case "$DEV_NAME" in
  *..*)
    err "Nome de dispositivo inválido: ${RAW_DEV}"
    exit 2
    ;;
esac

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
      PORT|HOST_PIN|DATA_DIR|MUSIC_DIR|JKBOX_USER|JKBOX_RESCAN_URL)
        if [ -z "${!key:-}" ]; then
          printf -v "$key" '%s' "$val"
        fi
        ;;
    esac
  done < "$env_file"
}

JKBOX_ENV_FILE="${JKBOX_ENV_FILE:-/etc/jkbox/jkbox.env}"
load_env_file "$JKBOX_ENV_FILE"

JKBOX_USER="${JKBOX_USER:-jkbox}"
JKBOX_DEV_DIR="${JKBOX_DEV_DIR:-/dev}"
JKBOX_MOUNT_CMD="${JKBOX_MOUNT_CMD:-mount}"
JKBOX_UMOUNT_CMD="${JKBOX_UMOUNT_CMD:-umount}"
JKBOX_MOUNTPOINT_CMD="${JKBOX_MOUNTPOINT_CMD:-mountpoint}"
JKBOX_BLKID_CMD="${JKBOX_BLKID_CMD:-blkid}"
JKBOX_CURL_CMD="${JKBOX_CURL_CMD:-curl}"

if [ -z "${MUSIC_DIR:-}" ]; then
  if [ -n "${DATA_DIR:-}" ]; then
    MUSIC_DIR="${DATA_DIR%/}/music"
  else
    MUSIC_DIR="/data/music"
  fi
fi

DEV_PATH="${JKBOX_DEV_DIR%/}/${DEV_NAME}"
MOUNT_POINT="${MUSIC_DIR%/}/usb-${DEV_NAME}"
RESCAN_URL="${JKBOX_RESCAN_URL:-http://127.0.0.1:${PORT:-3000}/api/library/rescan}"

validate_local_url() {
  local url="$1"
  printf '%s' "$url" | grep -Eq '^https?://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?(/|$)'
}

is_mounted() {
  "$JKBOX_MOUNTPOINT_CMD" -q "$MOUNT_POINT" 2>/dev/null
}

trigger_rescan() {
  if ! validate_local_url "$RESCAN_URL"; then
    err "URL de rescan inválida: ${RESCAN_URL}"
    return 1
  fi
  local curl_args=(-fsS --connect-timeout 2 --max-time 15 -X POST)
  if [ -n "${HOST_PIN:-}" ]; then
    curl_args+=(-H "x-host-pin: ${HOST_PIN}")
  fi
  if "$JKBOX_CURL_CMD" "${curl_args[@]}" "$RESCAN_URL" >/dev/null 2>&1; then
    log "Rescan automático disparado em ${RESCAN_URL}"
  else
    log "Aviso: servidor local indisponível em ${RESCAN_URL}; o acervo será indexado no próximo boot/rescan."
  fi
}

if [ "$ACTION" = "add" ]; then
  if [ ! -e "$DEV_PATH" ]; then
    err "Dispositivo não encontrado: ${DEV_PATH}"
    exit 1
  fi

  mkdir -p "$MOUNT_POINT"
  if is_mounted; then
    log "${MOUNT_POINT} já montado."
    trigger_rescan || true
    exit 0
  fi

  FS_TYPE="$("$JKBOX_BLKID_CMD" -o value -s TYPE "$DEV_PATH" 2>/dev/null || true)"
  JKBOX_UID="$(id -u "$JKBOX_USER" 2>/dev/null || printf '0')"
  JKBOX_GID="$(id -g "$JKBOX_USER" 2>/dev/null || printf '0')"

  MOUNT_OPTS="ro,nosuid,nodev,noexec"
  case "$FS_TYPE" in
    vfat|exfat|ntfs|ntfs3)
      MOUNT_OPTS="${MOUNT_OPTS},uid=${JKBOX_UID},gid=${JKBOX_GID},umask=022"
      ;;
  esac

  log "Montando ${DEV_PATH} (${FS_TYPE:-auto}) em ${MOUNT_POINT}..."
  if ! "$JKBOX_MOUNT_CMD" -o "$MOUNT_OPTS" "$DEV_PATH" "$MOUNT_POINT"; then
    rmdir "$MOUNT_POINT" 2>/dev/null || true
    err "Falha ao montar ${DEV_PATH} em ${MOUNT_POINT}"
    exit 1
  fi

  trigger_rescan || true
  exit 0
fi

# ACTION == remove
if is_mounted; then
  log "Desmontando ${MOUNT_POINT}..."
  "$JKBOX_UMOUNT_CMD" "$MOUNT_POINT" 2>/dev/null || "$JKBOX_UMOUNT_CMD" -l "$MOUNT_POINT" 2>/dev/null || true
fi
rmdir "$MOUNT_POINT" 2>/dev/null || true
log "Limpeza concluída para ${MOUNT_POINT}."
