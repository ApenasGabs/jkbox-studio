import path from 'node:path';

export type AudioFormat = 'm4a' | 'mp3' | 'opus';
export type VideoMode = 'off' | 'cache' | 'embed';

export interface Config {
  port: number;
  legacyRedirectPort: number | null;
  kioskPreferPort80: boolean;
  publicUrl: string;
  dataDir: string;
  musicDir: string;
  dbPath: string;
  webDir: string;
  audioFormat: AudioFormat;
  videoMode: VideoMode;
  videoMaxHeight: number;
  downloadConcurrency: number;
  playlistImportMaxTracks: number;
  /** Background lyrics prefetch after downloads/imports + startup backfill (LYRICS_PREFETCH=false opts out). */
  lyricsPrefetch: boolean;
  /** Max simultaneous background LRCLIB lookups. */
  lyricsPrefetchConcurrency: number;
  /** Minimum spacing (ms) between background LRCLIB lookups to respect its rate limit. */
  lyricsPrefetchIntervalMs: number;
  hostPin: string;
  /** Auto-generate a persisted 4-digit Host PIN when HOST_PIN is empty (HOST_PIN_AUTO=false opts out). */
  hostPinAuto: boolean;
  ytdlpPath: string;
  ytdlpExtraArgs: string[];
  mdnsHostname: string;
  mdnsEnabled: boolean;
  hostnameHelper: string;
  updateRepo: string;
  versionFile: string;
  spotify: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    playlistName: string;
    importIntervalSec: number;
  };
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function splitArgs(value: string | undefined): string[] {
  if (!value) return [];
  // Simple shell-like split that respects single/double quotes.
  const matches = value.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((m) => m.replace(/^['"]|['"]$/g, ''));
}

const parseOptionalPort = (value: string | undefined): number | null => {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed === '0' || trimmed === 'false' || trimmed === 'off' || trimmed === 'none') {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : null;
};

const parseBooleanFlag = (value: string | undefined): boolean => {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = int(env.PORT, 3000);
  const legacyRedirectPort = parseOptionalPort(env.LEGACY_REDIRECT_PORT);
  const kioskPreferPort80 = parseBooleanFlag(env.KIOSK_PREFER_PORT_80);
  const rawPublicUrl = (env.PUBLIC_URL ?? '').replace(/\/+$/, '');
  const publicUrl = port === 80 ? rawPublicUrl.replace(/:80(?=\/|$)/, '') : rawPublicUrl;
  const dataDir = path.resolve(env.DATA_DIR || './data');
  const format = (env.AUDIO_FORMAT || 'm4a').toLowerCase();
  const audioFormat: AudioFormat = format === 'mp3' || format === 'opus' ? format : 'm4a';
  const rawVideoMode = (env.VIDEO_MODE || 'cache').trim().toLowerCase();
  const videoMode: VideoMode = rawVideoMode === 'off' || rawVideoMode === 'embed' ? rawVideoMode : 'cache';
  const rawMaxHeight = int(env.VIDEO_MAX_HEIGHT, 720);
  const videoMaxHeight = rawMaxHeight > 0 ? rawMaxHeight : 720;
  const callbackBase = publicUrl || (port === 80 ? 'http://127.0.0.1' : `http://127.0.0.1:${port}`);

  return {
    port,
    legacyRedirectPort,
    kioskPreferPort80,
    publicUrl,
    dataDir,
    musicDir: path.resolve(env.MUSIC_DIR || path.join(dataDir, 'music')),
    dbPath: path.resolve(env.DB_PATH || path.join(dataDir, 'jkbox.db')),
    webDir: path.resolve(env.WEB_DIR || path.join(import.meta.dirname, '..', '..', 'web', 'dist')),
    audioFormat,
    videoMode,
    videoMaxHeight,
    downloadConcurrency: Math.max(1, int(env.DOWNLOAD_CONCURRENCY, 2)),
    playlistImportMaxTracks: Math.min(2000, Math.max(1, int(env.PLAYLIST_IMPORT_MAX_TRACKS, 500))),
    lyricsPrefetch: (env.LYRICS_PREFETCH ?? 'true').toLowerCase() !== 'false',
    lyricsPrefetchConcurrency: Math.min(8, Math.max(1, int(env.LYRICS_PREFETCH_CONCURRENCY, 2))),
    lyricsPrefetchIntervalMs: Math.max(0, int(env.LYRICS_PREFETCH_INTERVAL_MS, 250)),
    hostPin: (env.HOST_PIN ?? '').trim(),
    hostPinAuto: (env.HOST_PIN_AUTO ?? 'true').toLowerCase() !== 'false',
    ytdlpPath: env.YTDLP_PATH || 'yt-dlp',
    ytdlpExtraArgs: splitArgs(env.YTDLP_EXTRA_ARGS),
    mdnsHostname: (env.MDNS_HOSTNAME || 'jkbox').trim(),
    mdnsEnabled: (env.MDNS_ENABLED ?? 'true').toLowerCase() !== 'false',
    hostnameHelper: (env.JKBOX_HOSTNAME_HELPER ?? '').trim(),
    updateRepo: (env.JKBOX_REPO || 'ApenasGabs/jkbox-studio').trim(),
    versionFile: env.JKBOX_VERSION_FILE || path.join(env.JKBOX_BASE_DIR || '/opt/jkbox', 'current', 'VERSION'),
    spotify: {
      clientId: env.SPOTIFY_CLIENT_ID ?? '',
      clientSecret: env.SPOTIFY_CLIENT_SECRET ?? '',
      redirectUri: env.SPOTIFY_REDIRECT_URI || `${callbackBase}/api/spotify/callback`,
      playlistName: env.SPOTIFY_PLAYLIST_NAME || 'jkbox-studio',
      importIntervalSec: Math.max(0, int(env.SPOTIFY_IMPORT_INTERVAL, 60)),
    },
  };
}
