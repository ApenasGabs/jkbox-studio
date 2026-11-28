# OS Minimalista Kiosk & Hardware (`jkbox-studio`)

Artefatos da **Fase 2** para transformar qualquer notebook ou mini-PC antigo rodando **Debian Minimal** (`bookworm` 12 ou `trixie` 13) em uma **jukebox dedicada** com boot direto no Kiosk, troca automática de saída de áudio, automount de pendrives USB, auto-atualização atômica e controle por teclado USB ou botões físicos arcade/HID.

---

## 1. Instalação em Notebook / PC Antigo (Passo a Passo)

### Pré-requisitos
1. Baixe a ISO **Debian Netinst** (`debian-12.x-amd64-netinst.iso` ou `debian-13.x-amd64-netinst.iso`).
2. Na etapa **Seleção de software** (`tasksel`), desmarque ambientes gráficos pesados (GNOME/KDE/XFCE) e deixe marcado apenas:
   - `utilitários padrão de sistema`
   - `SSH server` (opcional, útil para manutenção remota)
3. Conecte o notebook via cabo Ethernet (ou Wi-Fi durante a instalação) e entre como `root` (ou usuário com `sudo`).

### Executando o instalador idempotente

```bash
# 1. Instale git (se ainda não estiver presente) e clone o repositório
apt-get update && apt-get install -y git
git clone https://github.com/ApenasGabs/jkbox-studio.git /tmp/jkbox-studio
cd /tmp/jkbox-studio

# 2. (Opcional) Simule as etapas antes de aplicar
./os/install-kiosk.sh --dry-run

# 3. Execute a instalação completa (pode ser re-executada com segurança a qualquer momento)
sudo ./os/install-kiosk.sh
```

> **Instalação offline / a partir de build local:** se ainda não houver uma GitHub Release publicada, compile localmente (`npm ci && npm run build`) e rode:
> `sudo ./os/install-kiosk.sh --local-source /caminho/do/jkbox-studio`

### O que `os/install-kiosk.sh` configura automaticamente
- **Hardware & Memória:** habilita `non-free-firmware`, instala firmwares comuns de Wi-Fi/áudio (`firmware-linux`, `iwlwifi`, `realtek`, `atheros`, `brcm80211`) e configura `zram-tools` (`zstd`, 50% da RAM).
- **Kiosk sem Desktop Pesado:** instala `Xorg` + `Openbox` + `Chromium` (`--kiosk --autoplay-policy=no-user-gesture-required`), configura autologin no `tty1`, oculta o cursor ocioso (`unclutter`) e desativa proteção de tela, suspensão e fechamento de tampa (`HandleLidSwitch=ignore`).
- **Rede, mDNS & Hotspot Fallback:** configura `NetworkManager`, anuncia `http://jkbox.local` (porta `80` por padrão sem precisar informar `:3000`, mantendo escuta de compatibilidade opcional em `:3000` via `LEGACY_REDIRECT_PORT=3000`) via `avahi-daemon` e ativa o serviço `jkbox-wifi-fallback.service`, que sobe o hotspot **`jkbox-setup`** (senha padrão `jkboxsetup`) caso nenhum Wi-Fi salvo ou cabo Ethernet conecte em ~20s.
- **Áudio Plug & Play:** configura `PipeWire` + `WirePlumber` para alternar automaticamente entre P2, HDMI, DAC USB e Bluetooth A2DP.
- **Pendrive USB Plug & Play:** instala regra `udev` (`os/udev/99-jkbox-usb-music.rules`) + `jkbox-usb-mount@.service`, montando pendrives em `/data/music/usb-*` (somente leitura) e disparando `POST /api/library/rescan` no servidor local.
- **Execução Nativa & Auto-Updater:** instala o app em `/opt/jkbox/current`, cria `/etc/jkbox/jkbox.env` e habilita `jkbox.service`, `jkbox-update.timer` e `jkbox-buttons.service`.

Após finalizar, reinicie com `sudo reboot`. O Kiosk abrirá automaticamente em tela cheia!

---

## 2. Estrutura de Instalação no Sistema

```text
/opt/jkbox/
├── releases/
│   ├── v0.1.0/
│   └── v0.2.0/
└── current -> /opt/jkbox/releases/v0.2.0

/etc/jkbox/
├── jkbox.env       # PORT, DATA_DIR, MUSIC_DIR=/data/music, HOST_PIN, Spotify, Hotspot
└── buttons.json    # Mapeamento evdev de teclas/botões físicos -> comandos Kiosk/wpctl

/data/music/        # Acervo local e montagens automáticas /data/music/usb-*
/var/lib/jkbox/     # Banco SQLite (jkbox.db) e cache de mídia (StateDirectory=jkbox)
```

---

## 3. Controle Físico (`os/jkbox-buttons`) & Troca de Teclado por Botões Reais

O `jkbox-studio` opera com **6 comandos abstratos** (`UP`, `DOWN`, `LEFT`, `RIGHT`, `SELECT`, `PLAY`) mais ações derivadas e controle de volume:
- **Clique curto `SELECT`:** confirmar / selecionar / adicionar à fila.
- **Clique longo `SELECT` (1,0 s):** `BACK` (voltar / fechar modal).
- **Clique curto `PLAY`:** tocar / pausar.
- **Clique longo `PLAY` (1,5 s):** `SKIP` (pular faixa).
- **Combo `LEFT + RIGHT` (2,0 s):** `MENU` (abrir Menu do Host).
- **Volume:** teclas multimídia ou botões configurados ajustam o áudio do sistema diretamente via `wpctl`.

### Usando com Teclado USB (Padrão)
Funciona imediatamente após a instalação:
- **Setas (`↑ ↓ ← →`):** navegação espacial
- **`Enter`:** `SELECT` (segure 1s = `BACK`)
- **`Espaço`:** `PLAY` (segure 1,5s = `SKIP`)
- **`Esc` / `Backspace`:** `BACK` direto
- **Teclas de Volume (`Vol+` / `Vol-` / `Mute`):** controle via `wpctl`

### Trocando para Botões Físicos (Zero Delay USB Arcade ou RP2040/Arduino HID)
1. Conecte os microswitches dos botões físicos (ex: 4 direcionais + `SELECT` + `PLAY` + opcionais `VOL+`/`VOL-`/`MENU`) ao encoder **Zero Delay USB Arcade** ou placa **RP2040 (GP2040-CE / HID)**.
2. Plugue o encoder na USB do notebook. O daemon `jkbox-buttons` detecta automaticamente novos dispositivos `evdev` em `/dev/input/event*` (hotplug a cada 3s) com debounce de hardware configurável (padrão `40 ms`).
3. Para confirmar os dispositivos detectados:
   ```bash
   sudo node /opt/jkbox/current/os/jkbox-buttons --list-devices
   ```
4. Para mapear exatamente cada botão físico instalado no seu gabinete, execute o **assistente interativo de calibração**:
   ```bash
   sudo node /opt/jkbox/current/os/jkbox-buttons --calibrate
   ```
   Pressione cada botão conforme solicitado (ou aperte `ENTER` no teclado para pular comandos opcionais como `BACK`/`MENU`/`SKIP` dedicados). Ao final, o arquivo `/etc/jkbox/buttons.json` é gravado com o perfil `custom`.
5. Reinicie o daemon para aplicar o novo mapeamento:
   ```bash
   sudo systemctl restart jkbox-buttons
   sudo journalctl -u jkbox-buttons -f
   ```

---

## 4. Auto-Updater Atômico (`os/jkbox-update.sh`)

```bash
# Simulação sem alterar arquivos ou reiniciar serviços
/opt/jkbox/current/os/jkbox-update.sh --dry-run

# Atualização manual (valida SHA256SUMS, alterna symlink atomicamente e faz rollback se /api/health falhar)
sudo /opt/jkbox/current/os/jkbox-update.sh
```

Units `systemd` incluídos em `os/systemd/`:
- `jkbox.service` — servidor Node.js principal sem privilégio de root (`User=jkbox` com `AmbientCapabilities=CAP_NET_BIND_SERVICE` para bind seguro na porta `80` e compatibilidade na porta `3000`).
- `jkbox-buttons.service` — micro-daemon `evdev` (`SupplementaryGroups=input audio`).
- `jkbox-update.service` & `jkbox-update.timer` — atualização automática periódica.
- `jkbox-usb-mount@.service` — automount de pendrives USB + rescan via API local.
- `jkbox-wifi-fallback.service` — ativa hotspot `jkbox-setup` quando sem rede após boot.

---

## 5. Controle Touchless por Gestos via Webcam (`MediaPipe` Offline)

Notebooks antigos em modo Kiosk podem usar a webcam integrada (0.3 MP / 1.3 MP) como **4ª fonte de input** sem exigir internet nem HTTPS externo:
- `os/jkbox-kiosk-browser.sh` inicia o Chromium em `http://127.0.0.1/` (Contexto Seguro nativo na porta `80` padrão) com `--use-fake-ui-for-media-stream` (auto-permissão sem popup).
- Os binários `.wasm` e o modelo `gesture_recognizer.task` são empacotados localmente em `web/dist/mediapipe/` durante o build.
- Ative o recurso em **`⚙︎ Host → Controle por Gestos (Webcam)`** (desativado por padrão, com stand-by a 4 FPS, filtro de proximidade anti-festa e modo privacidade exibindo apenas os 21 pontos da mão).
