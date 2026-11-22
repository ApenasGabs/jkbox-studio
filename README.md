# jkbox-studio

Jukebox musical moderna, open-source e leve, empacotada via **Docker**, pensada para rodar facilmente em qualquer máquina de teste e também em notebooks antigos (e futuramente em um OS minimalista em modo Kiosk).

## Visão Geral (MVP v1 — Docker)

- **Busca Unificada (YouTube + Spotify + Acervo Local):** Adicione músicas colando links ou pesquisando por nome.
- **Download e Cache Local Automático (`yt-dlp` + `ffmpeg`):** Cada música pedida é baixada automaticamente para o volume persistente (`/data/music`). Se for pedida novamente, toca instantaneamente do disco (offline, sem travamentos e sem anúncios).
- **Playlist Compartilhada no Spotify:** Integração via Spotify Web API para criar e sincronizar automaticamente uma playlist colaborativa/compartilhada com as músicas da sessão (e importar músicas adicionadas nela).
- **Interface Web Moderna em Tempo Real (WebSockets):**
  - **Modo Tela / Kiosk (`/`):** Player HTML5 Audio no navegador (zero dor de cabeça com drivers ALSA/PulseAudio no Docker), capa do álbum, barra de progresso, fila ao vivo e **QR Code** para convidados.
  - **Modo Mobile / Convidado (`/remote`):** Acesso pelo celular sem precisar instalar app ou criar conta, com busca, fila justa e votação.
- **Pronto para Docker:** `Dockerfile` multi-stage enxuto e `docker-compose.yml` com volumes persistentes para músicas e banco SQLite.

## Roadmap

- **Fase 1 (Atual):** Aplicação completa via Docker Compose (YouTube + Spotify + cache local automático + playlist compartilhada + UI Kiosk/Mobile).
- **Fase 2 (Futuro):** Imagem Linux minimalista em Modo Kiosk dedicada para notebooks antigos (x86).

## Configuração Rápida

```bash
cp .env.example .env
docker compose up --build -d
```

> Funciona imediatamente com **YouTube + Acervo Local** mesmo sem credenciais do Spotify. Para habilitar busca e sincronização de playlist no Spotify, preencha `SPOTIFY_CLIENT_ID` e `SPOTIFY_CLIENT_SECRET` no `.env`.
