#!/usr/bin/env bash
set -euo pipefail

# Atomic native auto-updater for jkbox-studio (GitHub Releases -> /opt/jkbox).

DRY_RUN=0
FORCE=0
NO_RESTART=0
TARGET_TAG="${JKBOX_TARGET_TAG:-}"

usage() {
  cat <<'EOF'
Uso: jkbox-update.sh [opções]

Opções:
  --dry-run        Consulta a release e exibe o plano sem alterar arquivos ou serviços
  --force          Reinstala mesmo que a versão instalada já corresponda à última release
  --no-restart     Baixa, valida e atualiza o symlink sem reiniciar o serviço (bootstrap)
  --tag <tag>      Atualiza para uma tag específica em vez de /releases/latest
  -h, --help       Exibe esta ajuda

Variáveis de ambiente suportadas:
  JKBOX_REPO              Repositório GitHub (padrão: ApenasGabs/jkbox-studio)
  JKBOX_BASE_DIR          Diretório base de instalação (padrão: /opt/jkbox)
  JKBOX_RELEASES_DIR      Diretório das releases extraídas (padrão: $JKBOX_BASE_DIR/releases)
  JKBOX_CURRENT_LINK      Symlink ativo da aplicação (padrão: $JKBOX_BASE_DIR/current)
  JKBOX_API_URL           URL da API de release (override para testes/mirrors)
  JKBOX_HEALTH_URL        URL do healthcheck (padrão: http://127.0.0.1:${PORT:-3000}/api/health)
  JKBOX_HEALTH_TIMEOUT    Timeout em segundos do healthcheck (padrão: 20)
  JKBOX_HEALTH_INTERVAL   Intervalo em segundos entre checagens (padrão: 1)
  JKBOX_ENV_FILE          Arquivo de ambiente lido se vars não estiverem definidas (padrão: /etc/jkbox/jkbox.env)
  JKBOX_SERVICE_NAME      Nome da unit systemd (padrão: jkbox.service)
  JKBOX_SYSTEMCTL         Binário systemctl (padrão: systemctl)
  JKBOX_NODE              Binário Node.js (padrão: node)
  JKBOX_KEEP_RELEASES     Quantidade de releases mantidas após sucesso (padrão: 3)
  JKBOX_LOCK_FILE         Arquivo de lock contra execuções simultâneas
EOF
}

log() {
  printf '[jkbox-update] %s\n' "$*"
}

err() {
  printf '[jkbox-update] ERRO: %s\n' "$*" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --no-restart)
      NO_RESTART=1
      shift
      ;;
    --tag)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        err "Opção --tag requer um valor"
        exit 2
      fi
      TARGET_TAG="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      err "Argumento desconhecido: $1"
      usage >&2
      exit 2
      ;;
  esac
done

validate_tag() {
  local tag="$1"
  if [ -z "$tag" ] || [ "$tag" = "." ] || [ "$tag" = ".." ]; then
    return 1
  fi
  if ! printf '%s' "$tag" | grep -Eq '^[A-Za-z0-9._-]+$'; then
    return 1
  fi
  case "$tag" in
    *..*) return 1 ;;
  esac
  return 0
}

validate_tar_name() {
  local name="$1"
  if [ -z "$name" ] || [ "$name" = "." ] || [ "$name" = ".." ]; then
    return 1
  fi
  if ! printf '%s' "$name" | grep -Eq '^jkbox-studio-[A-Za-z0-9._-]+\.tar\.gz$'; then
    return 1
  fi
  case "$name" in
    *..*) return 1 ;;
  esac
  return 0
}

validate_url() {
  local url="$1"
  if [ -z "$url" ]; then
    return 1
  fi
  if printf '%s' "$url" | grep -Eq '[[:space:]]'; then
    return 1
  fi
  if printf '%s' "$url" | grep -Eq '^https://'; then
    return 0
  fi
  if printf '%s' "$url" | grep -Eq '^http://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?(/|$)'; then
    return 0
  fi
  return 1
}

load_env_file() {
  local env_file="$1"
  if [ ! -f "$env_file" ] || [ ! -r "$env_file" ]; then
    return 0
  fi

  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    # Trim leading whitespace
    line="${line#"${line%%[![:space:]]*}"}"
    if [ -z "$line" ] || [[ "$line" == \#* ]]; then
      continue
    fi
    if [[ "$line" == export\ * ]]; then
      line="${line#export }"
      line="${line#"${line%%[![:space:]]*}"}"
    fi
    if [[ "$line" != *=* ]]; then
      continue
    fi

    key="${line%%=*}"
    key="${key%"${key##*[![:space:]]}"}"
    val="${line#*=}"
    val="${val#"${val%%[![:space:]]*}"}"
    val="${val%"${val##*[![:space:]]}"}"

    if [[ "$val" =~ ^\"(.*)\"$ ]]; then
      val="${BASH_REMATCH[1]}"
    elif [[ "$val" =~ ^\'(.*)\'$ ]]; then
      val="${BASH_REMATCH[1]}"
    fi

    case "$key" in
      PORT|JKBOX_TARGET_TAG|JKBOX_REPO|JKBOX_BASE_DIR|JKBOX_RELEASES_DIR|JKBOX_CURRENT_LINK|JKBOX_API_URL|JKBOX_HEALTH_URL|JKBOX_HEALTH_TIMEOUT|JKBOX_HEALTH_INTERVAL|JKBOX_SERVICE_NAME|JKBOX_SYSTEMCTL|JKBOX_NODE|JKBOX_KEEP_RELEASES|JKBOX_LOCK_FILE|JKBOX_GITHUB_TOKEN)
        if [ -z "${!key:-}" ]; then
          printf -v "$key" '%s' "$val"
        fi
        ;;
    esac
  done < "$env_file"
}

JKBOX_ENV_FILE="${JKBOX_ENV_FILE:-/etc/jkbox/jkbox.env}"
load_env_file "$JKBOX_ENV_FILE"

if [ -z "$TARGET_TAG" ] && [ -n "${JKBOX_TARGET_TAG:-}" ]; then
  TARGET_TAG="$JKBOX_TARGET_TAG"
fi

if [ -n "$TARGET_TAG" ] && ! validate_tag "$TARGET_TAG"; then
  err "Tag alvo inválida: ${TARGET_TAG}"
  exit 2
fi

JKBOX_REPO="${JKBOX_REPO:-ApenasGabs/jkbox-studio}"
JKBOX_BASE_DIR="${JKBOX_BASE_DIR:-/opt/jkbox}"
JKBOX_RELEASES_DIR="${JKBOX_RELEASES_DIR:-${JKBOX_BASE_DIR}/releases}"
JKBOX_CURRENT_LINK="${JKBOX_CURRENT_LINK:-${JKBOX_BASE_DIR}/current}"
if [ -z "${JKBOX_API_URL:-}" ]; then
  if [ -n "$TARGET_TAG" ]; then
    JKBOX_API_URL="https://api.github.com/repos/${JKBOX_REPO}/releases/tags/${TARGET_TAG}"
  else
    JKBOX_API_URL="https://api.github.com/repos/${JKBOX_REPO}/releases/latest"
  fi
fi
JKBOX_HEALTH_PORT="${PORT:-3000}"
JKBOX_HEALTH_URL="${JKBOX_HEALTH_URL:-http://127.0.0.1:${JKBOX_HEALTH_PORT}/api/health}"
JKBOX_HEALTH_TIMEOUT="${JKBOX_HEALTH_TIMEOUT:-20}"
JKBOX_HEALTH_INTERVAL="${JKBOX_HEALTH_INTERVAL:-1}"
JKBOX_SERVICE_NAME="${JKBOX_SERVICE_NAME:-jkbox.service}"
JKBOX_SYSTEMCTL="${JKBOX_SYSTEMCTL:-systemctl}"
JKBOX_NODE="${JKBOX_NODE:-node}"
JKBOX_KEEP_RELEASES="${JKBOX_KEEP_RELEASES:-3}"
JKBOX_LOCK_FILE="${JKBOX_LOCK_FILE:-${JKBOX_BASE_DIR}/.update.lock}"

normalize_ver() {
  printf '%s' "${1#v}"
}

get_installed_version() {
  if [ ! -e "$JKBOX_CURRENT_LINK" ]; then
    return 0
  fi
  if [ -f "${JKBOX_CURRENT_LINK}/VERSION" ]; then
    tr -d '[:space:]' < "${JKBOX_CURRENT_LINK}/VERSION"
    return 0
  fi
  if [ -L "$JKBOX_CURRENT_LINK" ]; then
    local target
    target="$(readlink -f "$JKBOX_CURRENT_LINK" 2>/dev/null || readlink "$JKBOX_CURRENT_LINK" 2>/dev/null || true)"
    if [ -n "$target" ]; then
      basename "$target"
      return 0
    fi
  fi
  if [ -f "${JKBOX_CURRENT_LINK}/server/package.json" ]; then
    "$JKBOX_NODE" -e '
      const fs = require("node:fs");
      const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (pkg && typeof pkg.version === "string") process.stdout.write("v" + pkg.version.trim());
    ' "${JKBOX_CURRENT_LINK}/server/package.json" 2>/dev/null || true
    return 0
  fi
  return 0
}

swap_symlink() {
  local target="$1"
  local parent_dir
  parent_dir="$(dirname "$JKBOX_CURRENT_LINK")"
  mkdir -p "$parent_dir"
  local tmp_link="${JKBOX_CURRENT_LINK}.next.$$"
  ln -sfn "$target" "$tmp_link"
  mv -Tf "$tmp_link" "$JKBOX_CURRENT_LINK"
}

TMP_DIR=""
STAGING_DIR=""
BACKUP_DIR=""

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
  if [ -n "$STAGING_DIR" ] && [ -d "$STAGING_DIR" ]; then
    rm -rf "$STAGING_DIR"
  fi
  if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
    if [ ! -e "$TARGET_DIR" ]; then
      mv "$BACKUP_DIR" "$TARGET_DIR" 2>/dev/null || true
      if [ -d "$TARGET_DIR" ]; then
        swap_symlink "$TARGET_DIR" 2>/dev/null || true
      fi
    else
      rm -rf "$BACKUP_DIR"
    fi
  fi
}
trap cleanup EXIT

if ! command -v "$JKBOX_NODE" >/dev/null 2>&1; then
  err "Node.js não encontrado (${JKBOX_NODE})"
  exit 1
fi

if ! validate_url "$JKBOX_API_URL"; then
  err "URL da API inválida ou insegura: ${JKBOX_API_URL}"
  exit 1
fi

if ! validate_url "$JKBOX_HEALTH_URL"; then
  err "URL de healthcheck inválida ou insegura: ${JKBOX_HEALTH_URL}"
  exit 1
fi

if [ "$DRY_RUN" -eq 0 ] && command -v flock >/dev/null 2>&1; then
  mkdir -p "$(dirname "$JKBOX_LOCK_FILE")"
  exec 9>"$JKBOX_LOCK_FILE"
  if ! flock -n 9; then
    log "Outra execução do jkbox-update já está ativa; ignorando."
    exit 0
  fi
fi

log "Consultando release em ${JKBOX_API_URL}..."
CURL_API_ARGS=(-fsSL --connect-timeout 10 --max-time 30 -H "Accept: application/vnd.github+json" -H "User-Agent: jkbox-update")
if [ -n "${JKBOX_GITHUB_TOKEN:-}" ] && printf '%s' "$JKBOX_API_URL" | grep -Eq '^https://api\.github\.com/'; then
  CURL_API_ARGS+=(-H "Authorization: Bearer ${JKBOX_GITHUB_TOKEN}")
fi

RELEASE_JSON="$(curl "${CURL_API_ARGS[@]}" "$JKBOX_API_URL")" || {
  err "Falha ao consultar API de releases em ${JKBOX_API_URL}"
  exit 1
}

RELEASE_META="$(printf '%s' "$RELEASE_JSON" | "$JKBOX_NODE" -e '
  const fs = require("node:fs");
  let data;
  try {
    data = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    process.exit(1);
  }
  const tag = typeof data?.tag_name === "string" ? data.tag_name.trim() : "";
  const assets = Array.isArray(data?.assets) ? data.assets : [];
  const expectedTar = `jkbox-studio-${tag}.tar.gz`;
  const tarAsset =
    assets.find((a) => a && a.name === expectedTar) ||
    assets.find((a) => a && typeof a.name === "string" && /^jkbox-studio-.*\.tar\.gz$/.test(a.name));
  const sumAsset = assets.find((a) => a && a.name === "SHA256SUMS");
  if (!tag || !tarAsset?.browser_download_url || !sumAsset?.browser_download_url) {
    process.exit(1);
  }
  process.stdout.write([tag, tarAsset.name, tarAsset.browser_download_url, sumAsset.browser_download_url].join("\t"));
')" || {
  err "Resposta da API não contém tag_name, tarball jkbox-studio-*.tar.gz ou SHA256SUMS"
  exit 1
}

IFS=$'\t' read -r LATEST_TAG TAR_NAME TAR_URL SUM_URL <<< "$RELEASE_META"

if ! validate_tag "$LATEST_TAG"; then
  err "Tag de release inválida: ${LATEST_TAG}"
  exit 1
fi

if ! validate_tar_name "$TAR_NAME"; then
  err "Nome de artefato inválido: ${TAR_NAME}"
  exit 1
fi

if ! validate_url "$TAR_URL" || ! validate_url "$SUM_URL"; then
  err "URL de artefato inválida ou insegura"
  exit 1
fi

INSTALLED_VER="$(get_installed_version || true)"
log "Versão instalada: ${INSTALLED_VER:-nenhuma} | Última release: ${LATEST_TAG}"

if [ "$FORCE" -eq 0 ] && [ -n "$INSTALLED_VER" ] && [ "$(normalize_ver "$INSTALLED_VER")" = "$(normalize_ver "$LATEST_TAG")" ]; then
  log "Já atualizado (${LATEST_TAG})."
  exit 0
fi

TARGET_DIR="${JKBOX_RELEASES_DIR}/${LATEST_TAG}"

if [ "$DRY_RUN" -eq 1 ]; then
  log "[dry-run] Atualização disponível: ${INSTALLED_VER:-nenhuma} -> ${LATEST_TAG}"
  log "[dry-run] Baixaria SHA256SUMS: ${SUM_URL}"
  log "[dry-run] Baixaria tarball: ${TAR_URL}"
  log "[dry-run] Extrairia em: ${TARGET_DIR}"
  log "[dry-run] Trocaria symlink ${JKBOX_CURRENT_LINK} -> ${TARGET_DIR}"
  log "[dry-run] Reiniciaria ${JKBOX_SERVICE_NAME} e validaria ${JKBOX_HEALTH_URL} (timeout ${JKBOX_HEALTH_TIMEOUT}s)"
  exit 0
fi

TMP_DIR="$(mktemp -d)"

log "Baixando SHA256SUMS..."
curl -fsSL --retry 2 --connect-timeout 10 --max-time 60 -o "${TMP_DIR}/SHA256SUMS" "$SUM_URL" || {
  err "Falha ao baixar SHA256SUMS"
  exit 1
}

log "Baixando ${TAR_NAME}..."
curl -fsSL --retry 2 --connect-timeout 10 --max-time 300 -o "${TMP_DIR}/${TAR_NAME}" "$TAR_URL" || {
  err "Falha ao baixar ${TAR_NAME}"
  exit 1
}

SUM_LINE="$(awk -v f="$TAR_NAME" '$2 == f || $2 == ("*" f) { print; found=1; exit } END { if (!found) exit 1 }' "${TMP_DIR}/SHA256SUMS")" || {
  err "Entrada para ${TAR_NAME} ausente no arquivo SHA256SUMS"
  exit 1
}

if ! (cd "$TMP_DIR" && printf '%s\n' "$SUM_LINE" | sha256sum -c - >/dev/null 2>&1); then
  err "Checksum SHA256 inválido para ${TAR_NAME}; atualização abortada"
  exit 1
fi
log "Checksum SHA256 verificado com sucesso."

PREV_TARGET=""
if [ -L "$JKBOX_CURRENT_LINK" ]; then
  PREV_TARGET="$(readlink -f "$JKBOX_CURRENT_LINK" 2>/dev/null || readlink "$JKBOX_CURRENT_LINK" 2>/dev/null || true)"
elif [ -d "$JKBOX_CURRENT_LINK" ]; then
  PREV_TARGET="$JKBOX_CURRENT_LINK"
fi

mkdir -p "$JKBOX_RELEASES_DIR"
CANON_RELEASES_DIR="$(readlink -f "$JKBOX_RELEASES_DIR" 2>/dev/null || printf '%s' "$JKBOX_RELEASES_DIR")"
CANON_TARGET_DIR="${CANON_RELEASES_DIR}/${LATEST_TAG}"
STAGING_DIR="${JKBOX_RELEASES_DIR}/.staging-${LATEST_TAG}-$$"
mkdir -p "$STAGING_DIR"

log "Extraindo pacote em diretório temporário..."
tar -xzf "${TMP_DIR}/${TAR_NAME}" -C "$STAGING_DIR"

# Support archives wrapped in a single top-level directory as well as flat tarballs.
if [ ! -f "${STAGING_DIR}/server/dist/index.js" ]; then
  SUB_ENTRY=""
  COUNT=0
  for entry in "$STAGING_DIR"/*; do
    [ -e "$entry" ] || continue
    COUNT=$((COUNT + 1))
    SUB_ENTRY="$entry"
  done
  if [ "$COUNT" -eq 1 ] && [ -d "$SUB_ENTRY" ] && [ -f "${SUB_ENTRY}/server/dist/index.js" ]; then
    shopt -s dotglob nullglob
    mv "$SUB_ENTRY"/* "$STAGING_DIR"/
    shopt -u dotglob nullglob
    rmdir "$SUB_ENTRY"
  else
    err "Pacote inválido: server/dist/index.js não encontrado após extração"
    exit 1
  fi
fi

if [ ! -f "${STAGING_DIR}/VERSION" ]; then
  printf '%s\n' "$LATEST_TAG" > "${STAGING_DIR}/VERSION"
fi
for os_bin in jkbox-update.sh install-kiosk.sh jkbox-usb-mount.sh jkbox-wifi-fallback.sh jkbox-kiosk-browser.sh jkbox-buttons; do
  if [ -f "${STAGING_DIR}/os/${os_bin}" ]; then
    chmod +x "${STAGING_DIR}/os/${os_bin}"
  fi
done
chmod -R a+rX "$STAGING_DIR"

if [ -e "$TARGET_DIR" ]; then
  if [ -n "$PREV_TARGET" ] && [ "$CANON_TARGET_DIR" = "$PREV_TARGET" ]; then
    BACKUP_DIR="${TARGET_DIR}.bak-$$"
    rm -rf "$BACKUP_DIR"
    cp -a "$TARGET_DIR" "$BACKUP_DIR"
    swap_symlink "$BACKUP_DIR"
    rm -rf "$TARGET_DIR"
  else
    rm -rf "$TARGET_DIR"
  fi
fi

mv "$STAGING_DIR" "$TARGET_DIR"
STAGING_DIR=""

wait_for_health() {
  local deadline=$(( $(date +%s) + JKBOX_HEALTH_TIMEOUT ))
  while true; do
    local body=""
    if body="$(curl -fsS --max-time 2 "$JKBOX_HEALTH_URL" 2>/dev/null)"; then
      if printf '%s' "$body" | "$JKBOX_NODE" -e '
        const fs = require("node:fs");
        const data = JSON.parse(fs.readFileSync(0, "utf8"));
        process.exit(data && data.ok === true ? 0 : 1);
      ' 2>/dev/null; then
        return 0
      fi
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      return 1
    fi
    sleep "$JKBOX_HEALTH_INTERVAL"
  done
}

rollback() {
  if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
    log "Executando rollback para ${TARGET_DIR}..."
    swap_symlink "$BACKUP_DIR"
    rm -rf "$TARGET_DIR"
    cp -a "$BACKUP_DIR" "$TARGET_DIR"
    swap_symlink "$TARGET_DIR"
    rm -rf "$BACKUP_DIR"
    BACKUP_DIR=""
    if ! "$JKBOX_SYSTEMCTL" restart "$JKBOX_SERVICE_NAME"; then
      err "Falha ao reiniciar ${JKBOX_SERVICE_NAME} durante rollback"
    fi
    return 0
  fi

  if [ -n "$PREV_TARGET" ] && [ -d "$PREV_TARGET" ]; then
    log "Executando rollback para ${PREV_TARGET}..."
    swap_symlink "$PREV_TARGET"
    if ! "$JKBOX_SYSTEMCTL" restart "$JKBOX_SERVICE_NAME"; then
      err "Falha ao reiniciar ${JKBOX_SERVICE_NAME} durante rollback"
    fi
  else
    log "Nenhuma release anterior para rollback; removendo symlink ${JKBOX_CURRENT_LINK}."
    rm -f "$JKBOX_CURRENT_LINK"
  fi

  if [ -d "$TARGET_DIR" ] && [ "$CANON_TARGET_DIR" != "$PREV_TARGET" ]; then
    rm -rf "$TARGET_DIR"
  fi
}

log "Alternando symlink ${JKBOX_CURRENT_LINK} -> ${TARGET_DIR}..."
swap_symlink "$TARGET_DIR"

if [ "$NO_RESTART" -eq 0 ]; then
  log "Reiniciando ${JKBOX_SERVICE_NAME}..."
  if ! "$JKBOX_SYSTEMCTL" restart "$JKBOX_SERVICE_NAME"; then
    err "Falha ao reiniciar ${JKBOX_SERVICE_NAME}"
    rollback
    exit 1
  fi

  log "Validando healthcheck em ${JKBOX_HEALTH_URL} (timeout ${JKBOX_HEALTH_TIMEOUT}s)..."
  if ! wait_for_health; then
    err "Healthcheck falhou em ${JKBOX_HEALTH_URL} após ${JKBOX_HEALTH_TIMEOUT}s"
    rollback
    exit 1
  fi
else
  log "Modo --no-restart ativo; serviço será iniciado posteriormente."
fi

if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
  rm -rf "$BACKUP_DIR"
  BACKUP_DIR=""
fi

# Prune older releases beyond JKBOX_KEEP_RELEASES, preserving active and previous rollback target.
if [ "$JKBOX_KEEP_RELEASES" -gt 0 ] 2>/dev/null; then
  mapfile -t ALL_RELEASES < <(ls -1dt "${JKBOX_RELEASES_DIR}"/*/ 2>/dev/null || true)
  if [ "${#ALL_RELEASES[@]}" -gt "$JKBOX_KEEP_RELEASES" ]; then
    for (( idx=JKBOX_KEEP_RELEASES; idx<${#ALL_RELEASES[@]}; idx++ )); do
      old_dir="${ALL_RELEASES[$idx]%/}"
      old_dir_canon="$(readlink -f "$old_dir" 2>/dev/null || printf '%s' "$old_dir")"
      if [ "$old_dir_canon" = "$CANON_TARGET_DIR" ] || { [ -n "$PREV_TARGET" ] && [ "$old_dir_canon" = "$PREV_TARGET" ]; }; then
        continue
      fi
      log "Removendo release antiga: ${old_dir}"
      rm -rf "$old_dir"
    done
  fi
fi

log "Atualização para ${LATEST_TAG} concluída com sucesso."
