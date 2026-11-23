#!/usr/bin/env bash
set -euo pipefail

# Idempotent Debian Minimal (bookworm/trixie) Kiosk installer for jkbox-studio.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

DRY_RUN=0
SKIP_APT=0
SKIP_RELEASE=0
JKBOX_USER="${JKBOX_USER:-jkbox}"
JKBOX_HOSTNAME="${JKBOX_HOSTNAME:-jkbox}"
JKBOX_PORT="${PORT:-3000}"
JKBOX_MUSIC_DIR="${MUSIC_DIR:-/data/music}"
JKBOX_BASE_DIR="${JKBOX_BASE_DIR:-/opt/jkbox}"
JKBOX_DATA_DIR="${DATA_DIR:-/var/lib/jkbox}"
JKBOX_REPO="${JKBOX_REPO:-ApenasGabs/jkbox-studio}"
JKBOX_TAG="${JKBOX_TAG:-}"
JKBOX_LOCAL_SOURCE="${JKBOX_LOCAL_SOURCE:-}"
JKBOX_HOTSPOT_SSID="${JKBOX_HOTSPOT_SSID:-jkbox-setup}"
JKBOX_HOTSPOT_PASSWORD="${JKBOX_HOTSPOT_PASSWORD:-jkboxsetup}"

usage() {
  cat <<'EOF'
Uso: sudo ./os/install-kiosk.sh [opções]

Instalador idempotente para transformar um notebook/PC com Debian Minimal (bookworm/trixie)
em uma jukebox Kiosk dedicada do jkbox-studio.

Opções:
  --dry-run                    Exibe as etapas sem modificar arquivos, pacotes ou serviços
  --user <nome>                Usuário de sistema/kiosk (padrão: jkbox)
  --hostname <nome>            Hostname mDNS (.local) (padrão: jkbox)
  --port <porta>               Porta HTTP do backend (padrão: 3000)
  --music-dir <dir>            Diretório do acervo local/USB (padrão: /data/music)
  --hotspot-ssid <ssid>        SSID do hotspot fallback (padrão: jkbox-setup)
  --hotspot-password <senha>   Senha WPA2 do hotspot fallback (mín. 8 chars, padrão: jkboxsetup)
  --repo <owner/repo>          Repositório GitHub de releases (padrão: ApenasGabs/jkbox-studio)
  --tag <tag>                  Instala release específica em vez da última
  --local-source <dir>         Instala a partir de um build local em vez da GitHub Release
  --skip-apt                   Pula etapa de apt-get e instalação de Node/yt-dlp
  --skip-release               Pula download/instalação do pacote da aplicação
  -h, --help                   Exibe esta ajuda
EOF
}

log() {
  printf '[install-kiosk] %s\n' "$*"
}

err() {
  printf '[install-kiosk] ERRO: %s\n' "$*" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --skip-apt)
      SKIP_APT=1
      shift
      ;;
    --skip-release)
      SKIP_RELEASE=1
      shift
      ;;
    --user)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { err "--user requer valor"; exit 2; }
      JKBOX_USER="$2"
      shift 2
      ;;
    --hostname)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { err "--hostname requer valor"; exit 2; }
      JKBOX_HOSTNAME="$2"
      shift 2
      ;;
    --port)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { err "--port requer valor"; exit 2; }
      JKBOX_PORT="$2"
      shift 2
      ;;
    --music-dir)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { err "--music-dir requer valor"; exit 2; }
      JKBOX_MUSIC_DIR="$2"
      shift 2
      ;;
    --hotspot-ssid)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { err "--hotspot-ssid requer valor"; exit 2; }
      JKBOX_HOTSPOT_SSID="$2"
      shift 2
      ;;
    --hotspot-password)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { err "--hotspot-password requer valor"; exit 2; }
      JKBOX_HOTSPOT_PASSWORD="$2"
      shift 2
      ;;
    --repo)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { err "--repo requer valor"; exit 2; }
      JKBOX_REPO="$2"
      shift 2
      ;;
    --tag)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { err "--tag requer valor"; exit 2; }
      JKBOX_TAG="$2"
      shift 2
      ;;
    --local-source)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { err "--local-source requer valor"; exit 2; }
      JKBOX_LOCAL_SOURCE="$2"
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

if ! printf '%s' "$JKBOX_USER" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$'; then
  err "Nome de usuário inválido: ${JKBOX_USER}"
  exit 2
fi

if ! printf '%s' "$JKBOX_HOSTNAME" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$'; then
  err "Hostname inválido: ${JKBOX_HOSTNAME}"
  exit 2
fi

if ! printf '%s' "$JKBOX_PORT" | grep -Eq '^[0-9]+$' || [ "$JKBOX_PORT" -lt 1 ] || [ "$JKBOX_PORT" -gt 65535 ]; then
  err "Porta inválida: ${JKBOX_PORT}"
  exit 2
fi

if [ "${#JKBOX_HOTSPOT_PASSWORD}" -lt 8 ]; then
  err "Senha do hotspot deve ter ao menos 8 caracteres (WPA2)."
  exit 2
fi

if [ "$DRY_RUN" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
  err "Execute como root (ex: sudo $0)."
  exit 1
fi

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] $*"
    return 0
  fi
  "$@"
}

write_file() {
  local target="$1"
  if [ "$DRY_RUN" -eq 1 ]; then
    cat >/dev/null
    log "[dry-run] Escreveria ${target}"
    return 0
  fi
  mkdir -p "$(dirname "$target")"
  cat > "$target"
}

ensure_non_free_firmware() {
  log "Verificando repositórios apt (non-free-firmware)..."
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] Garantiria componente non-free-firmware em /etc/apt/sources.list(.d)"
    return 0
  fi

  if [ -f /etc/apt/sources.list ]; then
    local tmp_list
    tmp_list="$(mktemp)"
    awk '
      /^[[:space:]]*#/ || /^[[:space:]]*$/ || /cdrom:/ { print; next }
      /^(deb|deb-src)[[:space:]]/ {
        has_nff = 0
        for (i = 1; i <= NF; i++) {
          if ($i == "non-free-firmware") has_nff = 1
        }
        if (!has_nff) {
          $0 = $0 " non-free-firmware"
        }
      }
      { print }
    ' /etc/apt/sources.list > "$tmp_list"
    mv "$tmp_list" /etc/apt/sources.list
  fi

  local src
  shopt -s nullglob
  for src in /etc/apt/sources.list.d/*.sources; do
    if grep -Eq '^Components:' "$src" && ! grep -Eq '^Components:.*\bnon-free-firmware\b' "$src"; then
      sed -i -E 's/^(Components:.*)$/\1 non-free-firmware/' "$src"
    fi
  done
  shopt -u nullglob
}

apt_install_optional() {
  local pkg
  for pkg in "$@"; do
    if apt-cache show "$pkg" >/dev/null 2>&1; then
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$pkg" || \
        log "Aviso: falha opcional ao instalar ${pkg}; continuando."
    fi
  done
}

node_meets_minimum() {
  command -v node >/dev/null 2>&1 || return 1
  local ver major minor
  ver="$(node -v 2>/dev/null || true)"
  ver="${ver#v}"
  major="${ver%%.*}"
  minor="${ver#*.}"
  minor="${minor%%.*}"
  if [ -z "$major" ] || [ -z "$minor" ]; then
    return 1
  fi
  if [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 13 ]; }; then
    return 0
  fi
  return 1
}

ensure_nodejs() {
  if node_meets_minimum; then
    log "Node.js compatível já instalado: $(node -v)"
    return 0
  fi
  log "Instalando Node.js 24 LTS (>= 22.13)..."
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] Configuraria NodeSource 24.x e instalaria pacote nodejs"
    return 0
  fi
  local setup_script
  setup_script="$(mktemp)"
  curl -fsSL https://deb.nodesource.com/setup_24.x -o "$setup_script"
  bash "$setup_script"
  rm -f "$setup_script"
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs
}

ensure_ytdlp() {
  if [ -x /usr/local/bin/yt-dlp ]; then
    log "yt-dlp já presente em /usr/local/bin/yt-dlp"
    return 0
  fi
  log "Instalando binário oficial yt-dlp em /usr/local/bin/yt-dlp..."
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] Baixaria yt-dlp para /usr/local/bin/yt-dlp"
    return 0
  fi
  curl -fsSL -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
  chmod 0755 /usr/local/bin/yt-dlp
}

install_packages() {
  if [ "$SKIP_APT" -eq 1 ]; then
    log "Pulando etapa apt (--skip-apt)."
    return 0
  fi

  ensure_non_free_firmware
  log "Atualizando índice apt e instalando pacotes base, Xorg/Openbox, NetworkManager, Avahi, PipeWire e zram..."
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] apt-get update && apt-get install pacotes kiosk/audio/rede/zram/udev"
    ensure_nodejs
    ensure_ytdlp
    return 0
  fi

  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    curl ca-certificates tar util-linux ffmpeg sqlite3 python3 sudo dbus \
    zram-tools \
    xserver-xorg x11-xserver-utils xinit openbox unclutter \
    fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
    network-manager avahi-daemon libnss-mdns dnsmasq-base \
    pipewire pipewire-pulse pipewire-alsa wireplumber libspa-0.2-bluetooth bluez alsa-utils \
    udev ntfs-3g exfatprogs dosfstools

  apt_install_optional \
    polkitd policykit-1 \
    chromium chromium-browser \
    firmware-linux firmware-linux-nonfree firmware-misc-nonfree \
    firmware-iwlwifi firmware-realtek firmware-atheros firmware-brcm80211

  ensure_nodejs
  ensure_ytdlp
}

configure_zram() {
  log "Configurando zram-tools..."
  write_file /etc/default/zramswap <<'EOF'
ALGO=zstd
PERCENT=50
PRIORITY=100
EOF
  if [ "$DRY_RUN" -eq 0 ] && systemctl list-unit-files zramswap.service >/dev/null 2>&1; then
    systemctl enable zramswap.service >/dev/null 2>&1 || true
    systemctl restart zramswap.service >/dev/null 2>&1 || true
  fi
}

configure_user_and_dirs() {
  log "Configurando usuário ${JKBOX_USER} e diretórios..."
  if [ "$DRY_RUN" -eq 0 ]; then
    if ! id -u "$JKBOX_USER" >/dev/null 2>&1; then
      useradd -m -s /bin/bash "$JKBOX_USER"
    fi
    local grp
    for grp in audio video input plugdev netdev bluetooth; do
      if getent group "$grp" >/dev/null 2>&1; then
        usermod -aG "$grp" "$JKBOX_USER"
      fi
    done

    mkdir -p "$JKBOX_BASE_DIR/releases" "$JKBOX_DATA_DIR" "$JKBOX_MUSIC_DIR" /etc/jkbox
    chown -R "${JKBOX_USER}:${JKBOX_USER}" "$JKBOX_DATA_DIR" "$JKBOX_MUSIC_DIR"

    if [ ! -e "${JKBOX_DATA_DIR}/music" ]; then
      ln -s "$JKBOX_MUSIC_DIR" "${JKBOX_DATA_DIR}/music"
    fi
  else
    log "[dry-run] Criaria usuário ${JKBOX_USER} (grupos audio,video,input,plugdev,netdev,bluetooth) e diretórios ${JKBOX_BASE_DIR}, ${JKBOX_DATA_DIR}, ${JKBOX_MUSIC_DIR}, /etc/jkbox"
  fi

  if [ ! -f /etc/jkbox/jkbox.env ]; then
    write_file /etc/jkbox/jkbox.env <<EOF
PORT=${JKBOX_PORT}
DATA_DIR=${JKBOX_DATA_DIR}
MUSIC_DIR=${JKBOX_MUSIC_DIR}
WEB_DIR=${JKBOX_BASE_DIR}/current/web/dist
AUDIO_FORMAT=m4a
VIDEO_MODE=cache
VIDEO_MAX_HEIGHT=720
YTDLP_AUTO_UPDATE=false
JKBOX_HOTSPOT_SSID=${JKBOX_HOTSPOT_SSID}
JKBOX_HOTSPOT_PASSWORD=${JKBOX_HOTSPOT_PASSWORD}
EOF
  else
    log "/etc/jkbox/jkbox.env já existe; preservando configurações atuais."
  fi

  if [ ! -f /etc/jkbox/buttons.json ] && [ -f "${SCRIPT_DIR}/buttons.default.json" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      log "[dry-run] Copiaria ${SCRIPT_DIR}/buttons.default.json para /etc/jkbox/buttons.json"
    else
      cp "${SCRIPT_DIR}/buttons.default.json" /etc/jkbox/buttons.json
      chmod 0644 /etc/jkbox/buttons.json
    fi
  fi
}

install_application() {
  if [ "$SKIP_RELEASE" -eq 1 ]; then
    log "Pulando instalação da aplicação (--skip-release)."
    return 0
  fi

  if [ -n "$JKBOX_LOCAL_SOURCE" ]; then
    log "Instalando build local de ${JKBOX_LOCAL_SOURCE} em ${JKBOX_BASE_DIR}..."
    if [ "$DRY_RUN" -eq 1 ]; then
      log "[dry-run] Copiaria build local para ${JKBOX_BASE_DIR}/releases/local e apontaria ${JKBOX_BASE_DIR}/current"
      return 0
    fi
    local target="${JKBOX_BASE_DIR}/releases/local"
    if [ ! -f "${JKBOX_LOCAL_SOURCE}/server/dist/index.js" ] || [ ! -f "${JKBOX_LOCAL_SOURCE}/web/dist/index.html" ]; then
      err "Build local incompleto em ${JKBOX_LOCAL_SOURCE} (execute npm run build antes)."
      exit 1
    fi
    rm -rf "$target"
    mkdir -p "$target/server" "$target/web"
    cp -r "${JKBOX_LOCAL_SOURCE}/server/dist" "$target/server/dist"
    cp "${JKBOX_LOCAL_SOURCE}/server/package.json" "$target/server/package.json"
    if [ -d "${JKBOX_LOCAL_SOURCE}/node_modules" ]; then
      cp -r "${JKBOX_LOCAL_SOURCE}/node_modules" "$target/node_modules"
    fi
    if [ -d "${JKBOX_LOCAL_SOURCE}/server/node_modules" ]; then
      cp -r "${JKBOX_LOCAL_SOURCE}/server/node_modules" "$target/server/node_modules"
    fi
    cp -r "${JKBOX_LOCAL_SOURCE}/web/dist" "$target/web/dist"
    cp -r "${JKBOX_LOCAL_SOURCE}/os" "$target/os"
    [ -f "${JKBOX_LOCAL_SOURCE}/.env.example" ] && cp "${JKBOX_LOCAL_SOURCE}/.env.example" "$target/.env.example"
    printf 'local\n' > "$target/VERSION"
    ln -sfn "$target" "${JKBOX_BASE_DIR}/current"
  elif [ ! -e "${JKBOX_BASE_DIR}/current" ] || [ -n "$JKBOX_TAG" ]; then
    log "Instalando release do GitHub (${JKBOX_REPO}) via jkbox-update.sh..."
    if [ "$DRY_RUN" -eq 1 ]; then
      log "[dry-run] Executaria ${SCRIPT_DIR}/jkbox-update.sh --no-restart para instalar em ${JKBOX_BASE_DIR}"
      return 0
    fi
    local upd_args=(--no-restart)
    [ -n "$JKBOX_TAG" ] && upd_args+=(--tag "$JKBOX_TAG")
    JKBOX_REPO="$JKBOX_REPO" \
    JKBOX_BASE_DIR="$JKBOX_BASE_DIR" \
    JKBOX_ENV_FILE="/etc/jkbox/jkbox.env" \
      bash "${SCRIPT_DIR}/jkbox-update.sh" "${upd_args[@]}" || {
        err "Falha ao baixar release do GitHub (${JKBOX_REPO}). Use --local-source <dir> para instalação offline."
        exit 1
      }
  else
    log "Aplicação já instalada em ${JKBOX_BASE_DIR}/current."
  fi

  if [ "$DRY_RUN" -eq 0 ] && [ -d "${JKBOX_BASE_DIR}/current/os" ]; then
    chmod +x "${JKBOX_BASE_DIR}/current/os/"*.sh "${JKBOX_BASE_DIR}/current/os/jkbox-buttons" 2>/dev/null || true
  fi
}

configure_network_mdns() {
  log "Configurando hostname (${JKBOX_HOSTNAME}.local), NetworkManager e avahi-daemon..."
  if [ "$DRY_RUN" -eq 0 ]; then
    if command -v hostnamectl >/dev/null 2>&1; then
      hostnamectl set-hostname "$JKBOX_HOSTNAME" || true
    fi
    printf '%s\n' "$JKBOX_HOSTNAME" > /etc/hostname

    if [ -f /etc/hosts ]; then
      if grep -Eq '^127\.0\.1\.1[[:space:]]' /etc/hosts; then
        sed -i -E "s/^127\.0\.1\.1[[:space:]].*/127.0.1.1\t${JKBOX_HOSTNAME} ${JKBOX_HOSTNAME}.local/" /etc/hosts
      else
        printf '127.0.1.1\t%s %s.local\n' "$JKBOX_HOSTNAME" "$JKBOX_HOSTNAME" >> /etc/hosts
      fi
    fi
  else
    log "[dry-run] Definiria hostname ${JKBOX_HOSTNAME} e /etc/hosts (${JKBOX_HOSTNAME}.local)"
  fi

  write_file /etc/NetworkManager/conf.d/10-jkbox-managed.conf <<'EOF'
[ifupdown]
managed=true
EOF

  if [ "$DRY_RUN" -eq 0 ]; then
    systemctl enable NetworkManager.service avahi-daemon.service >/dev/null 2>&1 || true
    systemctl restart NetworkManager.service avahi-daemon.service >/dev/null 2>&1 || true
  fi
}

configure_pipewire_audio() {
  log "Configurando PipeWire + WirePlumber (auto-switch P2/HDMI/USB/Bluetooth)..."
  if [ "$DRY_RUN" -eq 0 ]; then
    loginctl enable-linger "$JKBOX_USER" >/dev/null 2>&1 || true
  else
    log "[dry-run] loginctl enable-linger ${JKBOX_USER}"
  fi

  # WirePlumber 0.5+ (Debian Trixie / Bookworm backports)
  write_file /etc/wireplumber/wireplumber.conf.d/50-jkbox-autoswitch.conf <<'EOF'
wireplumber.settings = {
  bluetooth.autoswitch-to-headset-profile = false
}

monitor.bluez.properties = {
  bluez5.enable-sbc-xq = true
  bluez5.enable-msbc = false
  bluez5.roles = [ a2dp_sink a2dp_source ]
  bluez5.autoswitch-profile = true
}
EOF

  # WirePlumber 0.4 Lua fallback (Debian Bookworm)
  write_file /etc/wireplumber/bluetooth.lua.d/51-jkbox-bluez.lua <<'EOF'
bluez_monitor.properties = {
  ["bluez5.enable-sbc-xq"] = true,
  ["bluez5.enable-msbc"] = false,
  ["bluez5.roles"] = "[ a2dp_sink a2dp_source ]",
  ["bluez5.autoswitch-profile"] = true,
}
EOF
}

configure_kiosk_session() {
  log "Configurando autologin tty1, Xorg + Openbox + Chromium Kiosk (sem suspensão/screensaver)..."

  write_file /etc/systemd/system/getty@tty1.service.d/autologin.conf <<EOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin ${JKBOX_USER} --noclear %I \$TERM
EOF

  write_file /etc/systemd/logind.conf.d/jkbox-lid.conf <<'EOF'
[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
IdleAction=ignore
EOF

  if [ "$DRY_RUN" -eq 0 ]; then
    systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null 2>&1 || true
  else
    log "[dry-run] systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target"
  fi

  local user_home
  user_home="$(getent passwd "$JKBOX_USER" 2>/dev/null | cut -d: -f6 || true)"
  user_home="${user_home:-/home/${JKBOX_USER}}"

  write_file "${user_home}/.bash_profile" <<'EOF'
# Inicia o servidor X automaticamente no tty1 sem desktop completo.
if [ -f "${HOME}/.bashrc" ]; then
  . "${HOME}/.bashrc"
fi

if [ -z "${DISPLAY:-}" ] && [ "$(tty 2>/dev/null || true)" = "/dev/tty1" ]; then
  exec startx -- -nocursor
fi
EOF

  write_file "${user_home}/.xinitrc" <<'EOF'
#!/usr/bin/env bash
exec openbox-session
EOF

  write_file "${user_home}/.config/openbox/autostart" <<EOF
# Desabilita proteção de tela e economia de energia (DPMS)
xset s off || true
xset -dpms || true
xset s noblank || true

# Oculta o cursor do mouse após 2s de inatividade
unclutter -idle 2 -root &

# Inicia o Chromium Kiosk apontando para o backend local
${JKBOX_BASE_DIR}/current/os/jkbox-kiosk-browser.sh &
EOF

  if [ "$DRY_RUN" -eq 0 ]; then
    chmod 0755 "${user_home}/.xinitrc" "${user_home}/.config/openbox/autostart"
    chown -R "${JKBOX_USER}:${JKBOX_USER}" "${user_home}/.bash_profile" "${user_home}/.xinitrc" "${user_home}/.config"
  fi
}

configure_udev_and_systemd() {
  log "Instalando regras udev e units systemd..."
  local os_src="${JKBOX_BASE_DIR}/current/os"
  if [ ! -d "$os_src" ]; then
    os_src="$SCRIPT_DIR"
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] Instalaria /etc/udev/rules.d/99-jkbox-usb-music.rules e units systemd de ${os_src}"
    return 0
  fi

  cp "${os_src}/udev/99-jkbox-usb-music.rules" /etc/udev/rules.d/99-jkbox-usb-music.rules
  chmod 0644 /etc/udev/rules.d/99-jkbox-usb-music.rules
  udevadm control --reload-rules >/dev/null 2>&1 || true

  local unit
  for unit in jkbox.service jkbox-update.service jkbox-update.timer jkbox-buttons.service jkbox-usb-mount@.service jkbox-wifi-fallback.service; do
    if [ -f "${os_src}/systemd/${unit}" ]; then
      cp "${os_src}/systemd/${unit}" "/etc/systemd/system/${unit}"
      chmod 0644 "/etc/systemd/system/${unit}"
    fi
  done

  systemctl daemon-reload
  systemctl enable jkbox.service jkbox-update.timer jkbox-buttons.service jkbox-wifi-fallback.service

  if [ -e "${JKBOX_BASE_DIR}/current/server/dist/index.js" ]; then
    systemctl restart jkbox.service
    systemctl restart jkbox-buttons.service || true
  fi
  systemctl start jkbox-update.timer || true
}

main() {
  log "Iniciando instalação idempotente do jkbox-studio Kiosk (usuário=${JKBOX_USER}, porta=${JKBOX_PORT})..."
  install_packages
  configure_zram
  configure_user_and_dirs
  install_application
  configure_network_mdns
  configure_pipewire_audio
  configure_kiosk_session
  configure_udev_and_systemd
  log "Instalação concluída! Acesse http://${JKBOX_HOSTNAME}.local:${JKBOX_PORT} (ou reinicie para iniciar o Kiosk no tty1)."
}

main
