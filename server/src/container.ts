import type { Config } from './config.js';
import { openDb, Settings } from './db.js';
import { DownloadManager } from './services/downloads.js';
import { Jukebox } from './services/jukebox.js';
import { LyricsService } from './services/lyrics.js';
import { QueueService } from './services/queue.js';
import { SpotifyService, type FetchFn } from './services/spotify.js';
import { TrackRepository } from './services/tracks.js';
import { YtDlp, type MediaProvider } from './services/ytdlp.js';

export interface ContainerOverrides {
  media?: MediaProvider;
  fetchFn?: FetchFn;
  log?: (msg: string) => void;
}

/** Wires all services together (overridable for tests). */
export function createJukebox(config: Config, overrides: ContainerOverrides = {}): Jukebox {
  const db = openDb(config.dbPath);
  const tracks = new TrackRepository(db);
  const media = overrides.media ?? new YtDlp(config.ytdlpPath, config.audioFormat, config.ytdlpExtraArgs);
  const spotify = new SpotifyService(config.spotify, new Settings(db), overrides.fetchFn);
  const lyrics = new LyricsService(db, config.musicDir, overrides.fetchFn, overrides.log);
  const queue = new QueueService(db, tracks);
  let jukebox: Jukebox | null = null;
  const downloads = new DownloadManager(tracks, media, config.musicDir, config.downloadConcurrency, (track) =>
    jukebox!.resolveYoutubeId(track),
  );
  jukebox = new Jukebox(tracks, queue, downloads, media, spotify, lyrics, overrides.log);
  return jukebox;
}
