import type { Config } from './config.js';
import { openDb, Settings } from './db.js';
import { ClassifierService } from './services/classifier.js';
import { DiscoveryService } from './services/discovery.js';
import { DownloadManager } from './services/downloads.js';
import { Jukebox } from './services/jukebox.js';
import { LyricsService } from './services/lyrics.js';
import { PlaylistRepository } from './services/playlists.js';
import { QueueService } from './services/queue.js';
import { SpotifyService, type FetchFn } from './services/spotify.js';
import { TrackRepository } from './services/tracks.js';
import { YtDlp, type MediaProvider } from './services/ytdlp.js';

export interface ContainerOverrides {
  media?: MediaProvider;
  fetchFn?: FetchFn;
  log?: (msg: string) => void;
  externalClassifierLookup?: boolean;
}

/** Wires all services together (overridable for tests). */
export function createJukebox(config: Config, overrides: ContainerOverrides = {}): Jukebox {
  const db = openDb(config.dbPath);
  const settings = new Settings(db);
  const tracks = new TrackRepository(db);
  const playlists = new PlaylistRepository(db, tracks);
  const media = overrides.media ?? new YtDlp(config.ytdlpPath, config.audioFormat, config.ytdlpExtraArgs);
  const spotify = new SpotifyService(config.spotify, settings, overrides.fetchFn);
  const lyrics = new LyricsService(db, config.musicDir, overrides.fetchFn, overrides.log, undefined, {
    concurrency: config.lyricsPrefetchConcurrency,
    minIntervalMs: config.lyricsPrefetchIntervalMs,
  });
  const classifier = new ClassifierService(
    db,
    tracks,
    spotify,
    overrides.fetchFn,
    overrides.log,
    overrides.externalClassifierLookup ?? true,
  );
  const queue = new QueueService(db, tracks);
  let jukebox: Jukebox | null = null;
  const downloads = new DownloadManager(
    tracks,
    media,
    config.musicDir,
    config.downloadConcurrency,
    (track) => jukebox!.resolveYoutubeId(track),
    {
      videoMode: config.videoMode,
      videoMaxHeight: config.videoMaxHeight,
      log: overrides.log,
    },
  );
  jukebox = new Jukebox(
    tracks,
    queue,
    downloads,
    media,
    spotify,
    lyrics,
    overrides.log,
    settings,
    classifier,
    playlists,
  );
  jukebox.playlistImportMaxTracks = config.playlistImportMaxTracks;
  jukebox.lyricsPrefetchEnabled = config.lyricsPrefetch;
  jukebox.discovery = new DiscoveryService(
    tracks,
    queue,
    downloads,
    media,
    spotify,
    classifier,
    playlists,
    overrides.fetchFn,
    overrides.log,
    (queued) => jukebox!.syncQueuedBatch(queued),
  );
  return jukebox;
}
