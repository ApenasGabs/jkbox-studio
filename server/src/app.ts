import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Config } from './config.js';
import { streamFile } from './lib/stream.js';
import { SPOTIFY_ID_RE } from './lib/validate.js';
import type { Jukebox, SearchSource } from './services/jukebox.js';
import { scanLibrary } from './services/library.js';
import { QueueError } from './services/queue.js';
import { SpotifyError } from './services/spotify.js';

const SEARCH_SOURCES = new Set<SearchSource>(['all', 'youtube', 'spotify', 'local']);

export interface AppDeps {
  config: Config;
  jukebox: Jukebox;
  version?: string;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function createApp({ config, jukebox, version = '0.1.0' }: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '100kb' }));

  const { tracks, queue, downloads, spotify } = jukebox;
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
      spotify: spotify.status(),
    });
  });

  api.post('/host/verify', (req, res) => {
    res.json({ ok: isHost(req) });
  });

  api.get('/state', (_req, res) => {
    res.json(queue.state());
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

  api.post('/library/rescan', requireHost, (_req, res) => {
    res.json({ added: scanLibrary(tracks, config.musicDir) });
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

  api.get('/history', (_req, res) => {
    res.json({ history: queue.history() });
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
    spotify.disconnect();
    res.json(spotify.status());
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
    if (err instanceof QueueError || err instanceof SpotifyError) {
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
