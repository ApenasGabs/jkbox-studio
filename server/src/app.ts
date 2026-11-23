import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Config } from './config.js';
import { parseMetadataPatch } from './lib/metadata.js';
import { streamFile } from './lib/stream.js';
import { SPOTIFY_ID_RE } from './lib/validate.js';
import type { Jukebox, SearchSource } from './services/jukebox.js';
import { scanLibrary } from './services/library.js';
import { LyricsError } from './services/lyrics.js';
import { MdnsError, type MdnsService } from './services/mdns.js';
import { QueueError } from './services/queue.js';
import { SpotifyError } from './services/spotify.js';
import type { Track } from './types.js';

const SEARCH_SOURCES = new Set<SearchSource>(['all', 'youtube', 'spotify', 'local']);

export interface AppDeps {
  config: Config;
  jukebox: Jukebox;
  mdns?: MdnsService;
  version?: string;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function createApp({ config, jukebox, mdns, version = '0.1.0' }: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '100kb' }));

  const { tracks, queue, downloads, spotify, lyrics } = jukebox;
  const isHost = (req: Request) => !config.hostPin || req.get('x-host-pin') === config.hostPin;
  const requireHost = (req: Request, res: Response, next: NextFunction) => {
    if (isHost(req)) return next();
    res.status(403).json({ error: 'PIN do host inválido' });
  };
  const requireSpotify = (_req: Request, res: Response, next: NextFunction) => {
    if (spotify.configured) return next();
    res.status(503).json({ error: 'Spotify não configurado (defina SPOTIFY_CLIENT_ID e SPOTIFY_CLIENT_SECRET)' });
  };

  const api = express.Router();

  api.get('/health', (_req, res) => {
    res.json({ ok: true, version, downloadsActive: downloads.activeCount });
  });

  api.get('/config', (_req, res) => {
    res.json({
      publicUrl: config.publicUrl || null,
      hostPinRequired: !!config.hostPin,
      audioFormat: config.audioFormat,
      videoMode: config.videoMode,
      autoDjEnabled: jukebox.autoDjEnabled,
      playbackOutput: jukebox.playbackOutput,
      spotify: spotify.status(),
      mdns: mdns?.status() ?? null,
    });
  });

  api.patch('/config/hostname', requireHost, async (req, res, next) => {
    try {
      if (!mdns) return void res.status(503).json({ error: 'Serviço mDNS não inicializado' });
      const { hostname, useForQr } = req.body ?? {};
      if (hostname === undefined && useForQr === undefined) {
        return void res.status(400).json({ error: 'Informe hostname ou useForQr' });
      }
      const status = await mdns.update({ hostname, useForQr });
      res.json({ mdns: status });
    } catch (err) {
      if (err instanceof MdnsError) {
        return void res.status(err.status).json({ error: err.message });
      }
      next(err);
    }
  });

  api.post('/host/verify', (req, res) => {
    res.json({ ok: isHost(req) });
  });

  api.patch('/host/settings', requireHost, (req, res) => {
    const { autoDjEnabled } = req.body ?? {};
    if (typeof autoDjEnabled !== 'boolean') {
      return void res.status(400).json({ error: 'autoDjEnabled deve ser booleano' });
    }
    jukebox.setAutoDjEnabled(autoDjEnabled);
    res.json({ autoDjEnabled: jukebox.autoDjEnabled });
  });

  api.get('/state', (_req, res) => {
    res.json({ ...queue.state(), playbackOutput: jukebox.playbackOutput });
  });

  api.get('/search', async (req, res, next) => {
    try {
      const source = (str(req.query.source) || 'all') as SearchSource;
      if (!SEARCH_SOURCES.has(source)) return void res.status(400).json({ error: 'Fonte inválida' });
      if (source === 'spotify' && !spotify.configured) {
        return void res.status(503).json({ error: 'Spotify não configurado', results: [], errors: {} });
      }
      res.json(await jukebox.search(str(req.query.q), source));
    } catch (err) {
      next(err);
    }
  });

  api.get('/library', (req, res) => {
    res.json({ results: tracks.searchLibrary(str(req.query.q), 200).map((t) => jukebox.trackToResult(t)) });
  });

  api.post('/library/rescan', requireHost, async (_req, res, next) => {
    try {
      res.json({ added: await scanLibrary(tracks, config.musicDir) });
    } catch (err) {
      next(err);
    }
  });

  // --- Catalog (#10) ------------------------------------------------------
  const toResults = (list: Track[]) => list.map((t) => jukebox.trackToResult(t));

  api.get('/catalog/categories', (_req, res) => {
    res.json({ categories: tracks.listCategories() });
  });

  api.get('/catalog/categories/:name/tracks', (req, res) => {
    const name = str(req.params.name);
    res.json({ category: name, tracks: toResults(tracks.tracksByCategory(name)) });
  });

  api.get('/catalog/albums', (req, res) => {
    res.json({ albums: tracks.listAlbums({ q: str(req.query.q), category: str(req.query.category) }) });
  });

  api.get('/catalog/albums/:name/tracks', (req, res) => {
    const name = str(req.params.name);
    const artist = str(req.query.artist);
    res.json({ album: name, artist: artist || null, tracks: toResults(tracks.albumTracks(name, artist)) });
  });

  api.get('/catalog/artists', (_req, res) => {
    res.json({ artists: tracks.listArtists() });
  });

  api.get('/catalog/artists/:name', (req, res) => {
    const artist = tracks.getArtist(str(req.params.name));
    if (!artist) return void res.status(404).json({ error: 'Artista não encontrado' });
    res.json({ ...artist, tracks: toResults(artist.tracks) });
  });

  api.patch('/tracks/:id/metadata', requireHost, (req, res) => {
    const track = tracks.get(str(req.params.id));
    if (!track) return void res.status(404).json({ error: 'Faixa não encontrada' });
    const parsed = parseMetadataPatch(req.body);
    if (!parsed.ok) return void res.status(400).json({ error: parsed.error });
    tracks.update(track.id, parsed.patch);
    // Queue/now-playing views embed the track: push the new metadata to connected clients.
    queue.emit('change');
    res.json(tracks.get(track.id));
  });

  api.get('/downloads', (_req, res) => {
    res.json({ downloads: tracks.listActiveDownloads() });
  });

  api.post('/queue', (req, res, next) => {
    try {
      const { result, clientId, name } = req.body ?? {};
      const outcome = jukebox.enqueue({ result, requesterId: str(clientId), requesterName: str(name) });
      res.status(outcome.duplicate ? 200 : 201).json(outcome);
    } catch (err) {
      next(err);
    }
  });

  api.post('/queue/:id/vote', (req, res, next) => {
    try {
      const clientId = str(req.body?.clientId);
      if (!clientId) throw new QueueError('clientId obrigatório');
      res.json({ voted: queue.vote(Number(req.params.id), clientId) });
    } catch (err) {
      next(err);
    }
  });

  api.delete('/queue/:id', (req, res, next) => {
    try {
      queue.remove(Number(req.params.id), str(req.body?.clientId) || str(req.query.clientId), isHost(req));
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  api.get('/history', (req, res) => {
    const rawLimit = str(req.query.limit).trim();
    const parsed = rawLimit === '' ? 30 : Number(rawLimit);
    const limit = Number.isFinite(parsed) ? Math.min(100, Math.max(1, Math.trunc(parsed))) : 30;
    res.json({ history: queue.history(limit) });
  });

  api.post('/player/skip', requireHost, (_req, res) => {
    queue.skip();
    res.json(queue.state());
  });

  api.post('/player/ended', (req, res) => {
    queue.ended(Number(req.body?.queueId));
    res.json(queue.state());
  });

  api.get('/tracks/:id', (req, res) => {
    const track = tracks.get(req.params.id);
    if (!track) return void res.status(404).json({ error: 'Faixa não encontrada' });
    res.json(track);
  });

  api.post('/tracks/:id/retry', (req, res, next) => {
    try {
      if (!tracks.get(req.params.id)) return void res.status(404).json({ error: 'Faixa não encontrada' });
      res.json({ cached: downloads.ensure(req.params.id) });
    } catch (err) {
      next(err);
    }
  });

  const stream = (req: Request<{ id: string }>, res: Response) => {
    const track = tracks.get(req.params.id);
    if (!track) return void res.status(404).json({ error: 'Faixa não encontrada' });
    if (track.status !== 'ready' || !track.filePath) {
      return void res.status(409).json({ error: 'Faixa ainda não está pronta', status: track.status });
    }
    streamFile(req, res, track.filePath);
  };
  api.get('/tracks/:id/stream', stream);
  api.head('/tracks/:id/stream', stream);

  const streamVideo = (req: Request<{ id: string }>, res: Response) => {
    const track = tracks.get(req.params.id);
    if (!track) return void res.status(404).json({ error: 'Faixa não encontrada' });
    if (track.status !== 'ready') {
      return void res.status(409).json({ error: 'Faixa ainda não está pronta', status: track.status });
    }
    if (!track.videoPath) {
      return void res.status(404).json({ error: 'Vídeo não disponível para esta faixa' });
    }
    const ext = path.extname(track.videoPath).toLowerCase();
    const contentType = ext === '.webm' ? 'video/webm' : 'video/mp4';
    streamFile(req, res, track.videoPath, contentType);
  };
  api.get('/tracks/:id/video', streamVideo);
  api.head('/tracks/:id/video', streamVideo);

  api.get('/tracks/:id/lyrics', async (req, res, next) => {
    try {
      const track = tracks.get(req.params.id);
      if (!track) return void res.status(404).json({ error: 'Faixa não encontrada' });
      res.json(await lyrics.getForTrack(track));
    } catch (err) {
      next(err);
    }
  });

  api.patch('/tracks/:id/lyrics/offset', requireHost, async (req, res, next) => {
    try {
      const track = tracks.get(str(req.params.id));
      if (!track) return void res.status(404).json({ error: 'Faixa não encontrada' });
      res.json(await lyrics.updateOffset(track, req.body?.offsetMs));
    } catch (err) {
      next(err);
    }
  });

  api.delete('/tracks/:id/lyrics', requireHost, (req, res) => {
    const track = tracks.get(str(req.params.id));
    if (!track) return void res.status(404).json({ error: 'Faixa não encontrada' });
    lyrics.clear(track.id);
    res.status(204).end();
  });

  // --- Spotify ------------------------------------------------------------
  api.get('/spotify/status', (_req, res) => {
    res.json(spotify.status());
  });

  api.get('/spotify/auth', requireHostOrQueryPin(config), (_req, res, next) => {
    try {
      res.redirect(spotify.getAuthUrl());
    } catch (err) {
      next(err);
    }
  });

  api.get('/spotify/callback', async (req, res) => {
    const target = (ok: boolean, message?: string) =>
      `/?spotify=${ok ? 'connected' : 'error'}${message ? `&message=${encodeURIComponent(message)}` : ''}`;
    if (req.query.error) return void res.redirect(target(false, str(req.query.error)));
    try {
      await spotify.handleCallback(str(req.query.code), str(req.query.state));
      await spotify.ensurePlaylist();
      res.redirect(target(true));
    } catch (err) {
      res.redirect(target(false, err instanceof Error ? err.message : 'erro'));
    }
  });

  api.post('/spotify/playlist', requireSpotify, requireHost, async (req, res, next) => {
    try {
      const raw = str(req.body?.playlist).trim();
      if (raw) {
        const id = raw.match(/playlist[/:]([A-Za-z0-9]+)/)?.[1] ?? raw;
        if (!SPOTIFY_ID_RE.test(id)) return void res.status(400).json({ error: 'Link ou ID de playlist do Spotify inválido' });
        await spotify.linkPlaylist(id);
      } else {
        await spotify.ensurePlaylist();
      }
      res.json(spotify.status());
    } catch (err) {
      next(err);
    }
  });

  api.post('/spotify/sync', requireSpotify, requireHost, async (_req, res, next) => {
    try {
      const { nowPlaying, queue: items } = queue.state();
      const entries = [...(nowPlaying ? [nowPlaying.item] : []), ...items];
      for (const entry of entries) await jukebox.syncToSpotify(entry.track);
      res.json({ synced: entries.length, ...spotify.status() });
    } catch (err) {
      next(err);
    }
  });

  api.post('/spotify/import', requireSpotify, requireHost, async (_req, res, next) => {
    try {
      res.json({ imported: await jukebox.importFromSpotify() });
    } catch (err) {
      next(err);
    }
  });

  api.post('/spotify/disconnect', requireHost, (_req, res) => {
    jukebox.disconnectSpotify();
    res.json(spotify.status());
  });

  api.get('/spotify/devices', requireSpotify, requireHost, async (_req, res, next) => {
    try {
      res.json(await jukebox.getSpotifyDevices());
    } catch (err) {
      next(err);
    }
  });

  api.post('/spotify/device', requireHost, async (req, res, next) => {
    try {
      const raw = req.body?.deviceId;
      if (raw !== null && (typeof raw !== 'string' || !raw.trim() || raw.length > 128)) {
        return void res.status(400).json({ error: 'deviceId deve ser uma string não vazia ou null' });
      }
      const deviceId = raw === null ? null : raw.trim();
      if (deviceId !== null && !spotify.configured) {
        return void res.status(503).json({ error: 'Spotify não configurado (defina SPOTIFY_CLIENT_ID e SPOTIFY_CLIENT_SECRET)' });
      }
      const playbackOutput = await jukebox.setPlaybackOutput(deviceId);
      res.json({ playbackOutput });
    } catch (err) {
      next(err);
    }
  });

  api.post('/spotify/player/pause', requireSpotify, requireHost, async (_req, res, next) => {
    try {
      await jukebox.pauseSpotifyPlayback();
      res.json({ ok: true, paused: true });
    } catch (err) {
      next(err);
    }
  });

  api.post('/spotify/player/resume', requireSpotify, requireHost, async (_req, res, next) => {
    try {
      await jukebox.resumeSpotifyPlayback();
      res.json({ ok: true, paused: false });
    } catch (err) {
      next(err);
    }
  });

  api.post('/spotify/player/volume', requireSpotify, requireHost, async (req, res, next) => {
    try {
      const volume = req.body?.volume;
      if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > 100) {
        return void res.status(400).json({ error: 'volume deve ser um número entre 0 e 100' });
      }
      const applied = await jukebox.setSpotifyVolume(volume);
      res.json({ ok: true, volume: applied });
    } catch (err) {
      next(err);
    }
  });

  api.use((_req, res) => {
    res.status(404).json({ error: 'Rota não encontrada' });
  });

  app.use('/api', api);

  // --- Frontend (SPA) -----------------------------------------------------
  const indexHtml = path.join(config.webDir, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use(express.static(config.webDir, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/|\/ws).*/, (_req, res) => res.sendFile(indexHtml));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SpotifyError) {
      return void res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    }
    if (err instanceof QueueError || err instanceof LyricsError) {
      return void res.status(err.status).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Erro interno' });
  });

  return app;
}

/** Browser redirects can't send headers, so the OAuth start accepts the PIN as a query param. */
function requireHostOrQueryPin(config: Config) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!config.hostPin || req.get('x-host-pin') === config.hostPin || req.query.pin === config.hostPin) return next();
    res.status(403).json({ error: 'PIN do host inválido' });
  };
}
