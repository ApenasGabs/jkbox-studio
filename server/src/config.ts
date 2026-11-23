import path from 'node:path';

export type AudioFormat = 'm4a' | 'mp3' | 'opus';
export type VideoMode = 'off' | 'cache' | 'embed';

export interface Config {
  port: number;
  publicUrl: string;
  dataDir: string;
  musicDir: string;
  dbPath: string;
  webDir: string;
  audioFormat: AudioFormat;
  videoMode: VideoMode;
  videoMaxHeight: number;
  downloadConcurrency: number;
  hostPin: string;
  ytdlpPath: string;
  ytdlpExtraArgs: string[];
  mdnsHostname: string;
  mdnsEnabled: boolean;
  hostnameHelper: string;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = int(env.PORT, 3000);
  const publicUrl = (env.PUBLIC_URL ?? '').replace(/\/+$/, '');
  const dataDir = path.resolve(env.DATA_DIR || './data');
  const format = (env.AUDIO_FORMAT || 'm4a').toLowerCase();
  const audioFormat: AudioFormat = format === 'mp3' || format === 'opus' ? format : 'm4a';
  const rawVideoMode = (env.VIDEO_MODE || 'cache').trim().toLowerCase();
  const videoMode: VideoMode = rawVideoMode === 'off' || rawVideoMode === 'embed' ? rawVideoMode : 'cache';
  const rawMaxHeight = int(env.VIDEO_MAX_HEIGHT, 720);
  const videoMaxHeight = rawMaxHeight > 0 ? rawMaxHeight : 720;
  const callbackBase = publicUrl || `http://127.0.0.1:${port}`;

  return {
    port,
    publicUrl,
    dataDir,
    musicDir: path.resolve(env.MUSIC_DIR || path.join(dataDir, 'music')),
    dbPath: path.resolve(env.DB_PATH || path.join(dataDir, 'jkbox.db')),
    webDir: path.resolve(env.WEB_DIR || path.join(import.meta.dirname, '..', '..', 'web', 'dist')),
    audioFormat,
    videoMode,
    videoMaxHeight,
    downloadConcurrency: Math.max(1, int(env.DOWNLOAD_CONCURRENCY, 2)),
    hostPin: env.HOST_PIN ?? '',
    ytdlpPath: env.YTDLP_PATH || 'yt-dlp',
    ytdlpExtraArgs: splitArgs(env.YTDLP_EXTRA_ARGS),
    mdnsHostname: (env.MDNS_HOSTNAME || 'jkbox').trim(),
    mdnsEnabled: (env.MDNS_ENABLED ?? 'true').toLowerCase() !== 'false',
    hostnameHelper: (env.JKBOX_HOSTNAME_HELPER ?? '').trim(),
    spotify: {
      clientId: env.SPOTIFY_CLIENT_ID ?? '',
      clientSecret: env.SPOTIFY_CLIENT_SECRET ?? '',
      redirectUri: env.SPOTIFY_REDIRECT_URI || `${callbackBase}/api/spotify/callback`,
      playlistName: env.SPOTIFY_PLAYLIST_NAME || 'jkbox-studio',
      importIntervalSec: Math.max(0, int(env.SPOTIFY_IMPORT_INTERVAL, 60)),
    },
  };
}
