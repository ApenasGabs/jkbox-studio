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

## Configuração Rápida

```bash
cp .env.example .env
# edite PUBLIC_URL com o IP da máquina na rede, ex.: http://192.168.0.10:3000
docker compose up --build -d
```

1. Abra `http://<ip-da-maquina>:3000/` na tela principal (TV/notebook) e toque em **“Toque para iniciar”** (os navegadores exigem uma interação antes de tocar áudio).
2. Os convidados escaneiam o **QR Code** (ou abrem `/remote`), buscam ou colam um link e adicionam à fila.
3. A música é baixada em segundo plano para `./data/music` e começa a tocar na tela principal assim que estiver pronta.

> Funciona imediatamente com **YouTube + Acervo Local** mesmo sem credenciais do Spotify. Para habilitar busca e sincronização de playlist no Spotify, preencha `SPOTIFY_CLIENT_ID` e `SPOTIFY_CLIENT_SECRET` no `.env`.

## Como funciona

```
 Celulares (/remote) ──┐  REST + WebSocket   ┌──────────── container ────────────┐
                       ├────────────────────►│ Node.js (Express + ws + SQLite)   │
 Tela (/) <audio> ─────┘◄── /api/tracks/:id/stream (HTTP Range)                  │
                                             │  yt-dlp + ffmpeg ─► /data/music   │
                                             │  Spotify Web API (opcional)       │
                                             └───────────────────────────────────┘
```

- **Fila justa:** as músicas com mais votos sobem; em caso de empate, a fila alterna entre quem pediu (a 1ª música de cada pessoa vem antes da 2ª de qualquer um), evitando que alguém “domine” a jukebox. Pedir uma música que já está na fila conta como voto.
- **Cache inteligente:** cada faixa é registrada no SQLite (`/data/jkbox.db`). Se o arquivo já existe no disco, a faixa fica pronta na hora, sem novo download. Faixas do Spotify que caem no mesmo vídeo do YouTube compartilham o mesmo arquivo.
- **Acervo local:** arquivos de áudio colocados manualmente em `./data/music` (de preferência `Artista - Título.mp3`) são importados ao iniciar ou pelo botão **Reescanear acervo** no painel do host.
- **Reprodução no navegador:** o backend só serve arquivos; quem toca é o `<audio>` da tela principal, que reporta o progresso via WebSocket para todos os celulares.

## Variáveis de ambiente

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `PORT` | `3000` | Porta HTTP. |
| `PUBLIC_URL` | _(vazio)_ | URL acessível pelos celulares (QR Code e callback do Spotify). Vazio = URL atual do navegador. |
| `DATA_DIR` | `./data` (`/data` no Docker) | Músicas (`music/`) e banco SQLite (`jkbox.db`). |
| `AUDIO_FORMAT` | `m4a` | Formato padronizado dos downloads: `m4a`, `mp3` ou `opus`. |
| `DOWNLOAD_CONCURRENCY` | `2` | Downloads simultâneos. |
| `HOST_PIN` | _(vazio)_ | PIN do **Controlador Principal (Host)**. Se definido, nunca é sobrescrito. Se vazio, um PIN de 4 dígitos é gerado e salvo automaticamente (visível/editável/desativável em `⚙︎ Host` na TV), e convidados via QR padrão (`/remote`) entram sempre em Modo Convidado. O QR exclusivo `/remote?pin=<PIN>` ativa o Controlador Principal no celular. |
| `HOST_PIN_AUTO` | `true` | `false` desativa a geração automática do PIN quando `HOST_PIN` está vazio (comportamento legado: todos são Host). |
| `YTDLP_AUTO_UPDATE` | `true` | Atualiza o `yt-dlp` ao iniciar o container. |
| `YTDLP_EXTRA_ARGS` | _(vazio)_ | Argumentos extras para o `yt-dlp` (ex.: `--cookies /data/cookies.txt`). |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | _(vazio)_ | Credenciais do app Spotify (opcional). |
| `SPOTIFY_REDIRECT_URI` | `${PUBLIC_URL}/api/spotify/callback` | Redirect URI cadastrada no Spotify. |
| `SPOTIFY_PLAYLIST_NAME` | `jkbox-studio` | Nome da playlist compartilhada criada. |
| `SPOTIFY_IMPORT_INTERVAL` | `60` | Segundos entre importações da playlist (0 desativa). |

## Configurando o Spotify (opcional)

1. Acesse o [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) e crie um app (Web API).
2. Em **Redirect URIs**, cadastre exatamente a URL de callback:
   - com `PUBLIC_URL` definido: `http://192.168.0.10:3000/api/spotify/callback`;
   - acesso local: `http://127.0.0.1:3000/api/spotify/callback` (o Spotify não aceita mais `localhost`).
3. Copie **Client ID** e **Client Secret** para o `.env` e reinicie (`docker compose up -d`).
4. Na tela principal, abra **⚙︎ Host → Conectar Spotify** e autorize. Uma playlist **colaborativa** chamada `SPOTIFY_PLAYLIST_NAME` é criada (ou reutilizada).

Com o Spotify configurado:

- A busca no catálogo funciona mesmo antes do login (client credentials).
- Links de faixas, álbuns e playlists do Spotify podem ser colados no `/remote`. O áudio é localizado no YouTube (`"Artista - Título audio"`, abordagem do spotDL) e baixado via `yt-dlp`.
- Toda música adicionada à fila é sincronizada na playlist compartilhada (músicas do YouTube são casadas com o catálogo do Spotify quando possível).
- Faixas adicionadas à playlist pelo app do Spotify são importadas para a fila automaticamente (`SPOTIFY_IMPORT_INTERVAL`) ou pelo botão **Importar da playlist**.

> Apps em _Development Mode_ do Spotify só funcionam para usuários cadastrados em **User Management** no dashboard, e a leitura de playlists só é permitida para playlists das quais o usuário é dono ou colaborador.

## API

| Método | Rota | Descrição |
| --- | --- | --- |
| `GET` | `/api/health` | Healthcheck. |
| `GET` | `/api/config` | Configuração pública (PUBLIC_URL, status do Spotify). |
| `GET` | `/api/state` | Estado atual (tocando agora + fila ordenada). |
| `GET` | `/api/search?q=&source=all\|youtube\|spotify\|local` | Busca unificada; links do YouTube/Spotify são resolvidos. |
| `GET` | `/api/library?q=` | Acervo local (faixas no disco). |
| `POST` | `/api/queue` | `{ result, clientId, name }` — adiciona à fila (baixa se necessário). |
| `POST` | `/api/queue/:id/vote` | `{ clientId }` — alterna voto. |
| `DELETE` | `/api/queue/:id` | Remove (quem pediu ou host). |
| `POST` | `/api/player/skip` | Pula a música atual (host). |
| `POST` | `/api/player/ended` | `{ queueId }` — chamado pela tela ao terminar a faixa. |
| `GET` | `/api/tracks/:id/stream` | Áudio com suporte a `Range`. |
| `GET` | `/api/downloads` | Downloads em andamento. |
| `GET` | `/api/catalog/categories` | Categorias/gêneros do acervo (contagem de faixas, álbuns, artistas e capa). |
| `GET` | `/api/catalog/categories/:name/tracks` | Faixas de uma categoria. |
| `GET` | `/api/catalog/albums?q=&category=` | Álbuns agrupados (contagem de faixas e duração total). |
| `GET` | `/api/catalog/albums/:name/tracks?artist=` | Faixas do álbum ordenadas pelo número da faixa. |
| `GET` | `/api/catalog/artists` · `/api/catalog/artists/:name` | Artistas agrupados e detalhe (álbuns + faixas). |
| `PATCH` | `/api/tracks/:id/metadata` | `{ title, artist, album, genre, year, trackNumber }` — edita metadados (host). |
| `GET` | `/api/spotify/auth` · `/api/spotify/callback` | Fluxo OAuth. |
| `POST` | `/api/spotify/sync` · `/api/spotify/import` · `/api/spotify/playlist` | Sincronizar fila, importar playlist, vincular playlist existente (`{ playlist }`). |
| `WS` | `/ws` | Eventos `state`, `progress` e `download`; a tela envia `progress`. |

### Metadados do acervo local

Ao importar arquivos de `/data/music`, o servidor lê as tags via `ffprobe` (título, artista, álbum, gênero, ano, nº da faixa e duração). Sem tags, usa a estrutura de pastas `<Categoria>/<Artista>/<Álbum>/01 - Música.mp3` (ou `<Artista>/<Álbum>/…`, `<Categoria>/…`) e, por fim, o nome do arquivo (`Artista - Título`). O gênero funciona como categoria e pode ser ajustado pelo host.

## Desenvolvimento

Requisitos: Node.js ≥ 22.13 (usa o `node:sqlite` nativo), `yt-dlp` e `ffmpeg` no `PATH`.

```bash
npm install
npm run dev        # backend em :3000 (tsx watch) + Vite em :5173 com proxy para /api e /ws
npm run typecheck  # server + web
npm test           # vitest (unitários + integração do backend com yt-dlp/Spotify simulados)
npm run build      # web/dist + server/dist
npm start          # serve tudo em :3000
```

Estrutura:

```
server/   Express + WebSocket + SQLite (node:sqlite), serviços de fila, downloads, yt-dlp e Spotify
web/      React + Vite + Tailwind CSS (páginas Kiosk "/" e Remote "/remote")
docker/   entrypoint do container
os/       auto-updater nativo atômico (jkbox-update.sh) e units systemd
```

## Segurança e limitações conhecidas

- Pensado para rede local/festa: convidados não fazem login. O `clientId` de cada celular é um identificador aleatório salvo no navegador. Use `HOST_PIN` para proteger as ações do host.
- Faça download apenas de conteúdo que você tem direito de reproduzir.
- Se o YouTube bloquear downloads, mantenha `YTDLP_AUTO_UPDATE=true` ou forneça cookies via `YTDLP_EXTRA_ARGS`.

## Roadmap

- **Fase 1 (Atual):** Aplicação completa via Docker Compose (YouTube + Spotify + cache local automático + playlist compartilhada + UI Kiosk/Mobile).
- **Fase 2 (Futuro):** Imagem Linux minimalista em Modo Kiosk dedicada para notebooks antigos (x86).
