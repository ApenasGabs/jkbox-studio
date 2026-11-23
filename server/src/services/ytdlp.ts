import { spawn } from 'node:child_process';
import type { AudioFormat } from '../config.js';
import type { SearchResult } from '../types.js';
import { YOUTUBE_ID_RE } from '../lib/validate.js';

export interface DownloadResult {
  filePath: string;
}

export interface ExtractedPlaylist {
  title: string;
  description?: string | null;
  thumbnail?: string | null;
  totalCount?: number | null;
  tracks: SearchResult[];
}

/** Abstraction over yt-dlp so the rest of the app (and tests) don't depend on the binary. */
export interface MediaProvider {
  search(query: string, limit?: number): Promise<SearchResult[]>;
  getVideo(videoId: string): Promise<SearchResult>;
  getPlaylist(url: string, limit?: number): Promise<SearchResult[]>;
  getPlaylistDetails?(url: string, limit?: number): Promise<ExtractedPlaylist>;
  download(videoId: string, outputBase: string, onProgress: (fraction: number) => void): Promise<DownloadResult>;
  downloadVideo?(
    videoId: string,
    outputBase: string,
    maxHeight: number,
    onProgress: (fraction: number) => void,
  ): Promise<DownloadResult>;
  version(): Promise<string>;
}

interface YtThumbnail {
  url: string;
  width?: number;
}

interface YtEntry {
  id: string;
  title?: string;
  channel?: string;
  uploader?: string;
  artist?: string;
  track?: string;
  album?: string;
  duration?: number;
  thumbnail?: string;
  thumbnails?: YtThumbnail[];
}

interface YtPlaylistPayload {
  id?: string;
  title?: string;
  description?: string;
  thumbnail?: string;
  thumbnails?: YtThumbnail[];
  playlist_count?: number;
  entries?: YtEntry[];
}

const PROGRESS_PREFIX = 'jkbox-progress:';

function pickBestThumbnail(thumbnail?: string, thumbnails?: YtThumbnail[]): string | null {
  if (thumbnail?.trim()) return thumbnail.trim();
  const sorted = [...(thumbnails ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  return sorted[0]?.url ?? null;
}

export function entryToResult(entry: YtEntry): SearchResult {
  const bestThumb =
    pickBestThumbnail(entry.thumbnail, entry.thumbnails) ?? `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`;
  return {
    source: 'youtube',
    sourceId: entry.id,
    title: entry.track ?? entry.title ?? entry.id,
    artist: entry.artist ?? entry.channel ?? entry.uploader ?? '',
    album: entry.album ?? null,
    durationSec: typeof entry.duration === 'number' ? Math.round(entry.duration) : null,
    thumbnail: bestThumb,
  };
}

/** Parses a progress line emitted by our --progress-template. Returns a 0..1 fraction or null. */
export function parseProgressLine(line: string): number | null {
  const idx = line.indexOf(PROGRESS_PREFIX);
  if (idx === -1) return null;
  const [downloaded, total, estimate] = line
    .slice(idx + PROGRESS_PREFIX.length)
    .trim()
    .split(':')
    .map((v) => Number.parseFloat(v));
  const size = Number.isFinite(total) && total > 0 ? total : estimate;
  if (!Number.isFinite(downloaded) || !Number.isFinite(size) || size <= 0) return null;
  return Math.min(1, Math.max(0, downloaded / size));
}

/** Builds the yt-dlp format selector for lightweight MP4 clips up to `maxHeight`. */
export function buildVideoFormatSelector(maxHeight: number): string {
  const height = Math.max(144, Math.round(maxHeight));
  return `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${height}][ext=mp4]/best`;
}

/** Defense in depth: never interpolate anything but a canonical video id into a yt-dlp URL. */
function assertVideoId(videoId: string): void {
  if (!YOUTUBE_ID_RE.test(videoId)) throw new Error(`ID de vídeo do YouTube inválido: ${videoId.slice(0, 32)}`);
}

export class YtDlp implements MediaProvider {
  constructor(
    private readonly bin: string,
    private readonly audioFormat: AudioFormat,
    private readonly extraArgs: string[] = [],
  ) {}

  private baseArgs(): string[] {
    // yt-dlp needs a JavaScript runtime for YouTube; Node is always available in our image.
    return ['--no-warnings', '--js-runtimes', 'node', ...this.extraArgs];
  }

  private run(args: string[], onLine?: (line: string) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, [...this.baseArgs(), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        if (!onLine) return;
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        lines.forEach(onLine);
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (err) => reject(new Error(`Falha ao executar yt-dlp (${this.bin}): ${err.message}`)));
      child.on('close', (code) => {
        if (buffer && onLine) onLine(buffer);
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim().split('\n').pop() || `yt-dlp saiu com código ${code}`));
      });
    });
  }

  async version(): Promise<string> {
    return (await this.run(['--version'])).trim();
  }

  async search(query: string, limit = 10): Promise<SearchResult[]> {
    const out = await this.run([`ytsearch${limit}:${query}`, '--flat-playlist', '-J']);
    const data = JSON.parse(out) as { entries?: YtEntry[] };
    return (data.entries ?? []).filter((e) => e?.id).map(entryToResult);
  }

  async getVideo(videoId: string): Promise<SearchResult> {
    assertVideoId(videoId);
    const out = await this.run(['-J', '--no-playlist', `https://www.youtube.com/watch?v=${videoId}`]);
    return entryToResult(JSON.parse(out) as YtEntry);
  }

  async getPlaylist(url: string, limit = 50): Promise<SearchResult[]> {
    const out = await this.run([url, '--flat-playlist', '-J', '--playlist-end', String(limit)]);
    const data = JSON.parse(out) as YtPlaylistPayload;
    return (data.entries ?? []).filter((e) => e?.id).map(entryToResult);
  }

  async getPlaylistDetails(url: string, limit = 50): Promise<ExtractedPlaylist> {
    const fetchLimit = Math.max(1, limit) + 1;
    const out = await this.run([url, '--flat-playlist', '-J', '--playlist-end', String(fetchLimit)]);
    const data = JSON.parse(out) as YtPlaylistPayload;
    const tracks = (data.entries ?? []).filter((e) => e?.id).map(entryToResult);
    const totalCount =
      typeof data.playlist_count === 'number' && Number.isFinite(data.playlist_count)
        ? data.playlist_count
        : tracks.length;
    return {
      title: data.title?.trim() || 'Playlist YouTube',
      description: data.description?.trim() || null,
      thumbnail: pickBestThumbnail(data.thumbnail, data.thumbnails) ?? tracks[0]?.thumbnail ?? null,
      totalCount,
      tracks,
    };
  }

  private async runDownload(
    videoId: string,
    outputBase: string,
    fallbackExt: string,
    formatArgs: string[],
    onProgress: (fraction: number) => void,
  ): Promise<DownloadResult> {
    assertVideoId(videoId);
    let filePath = '';
    await this.run(
      [
        `https://www.youtube.com/watch?v=${videoId}`,
        '--no-playlist',
        ...formatArgs,
        '--progress',
        '--newline',
        '--progress-template',
        `download:${PROGRESS_PREFIX}%(progress.downloaded_bytes)s:%(progress.total_bytes)s:%(progress.total_bytes_estimate)s`,
        '--print',
        'after_move:filepath',
        '-o',
        `${outputBase}.%(ext)s`,
      ],
      (line) => {
        const fraction = parseProgressLine(line);
        if (fraction !== null) onProgress(fraction);
        else if (line.startsWith('/') || /^[A-Za-z]:\\/.test(line)) filePath = line.trim();
      },
    );
    if (!filePath) filePath = `${outputBase}.${fallbackExt}`;
    return { filePath };
  }

  async download(videoId: string, outputBase: string, onProgress: (fraction: number) => void): Promise<DownloadResult> {
    return this.runDownload(
      videoId,
      outputBase,
      this.audioFormat,
      [
        '-f',
        'bestaudio/best',
        '-x',
        '--audio-format',
        this.audioFormat,
        '--audio-quality',
        '0',
        '--embed-metadata',
        '--embed-thumbnail',
        '--convert-thumbnails',
        'jpg',
      ],
      onProgress,
    );
  }

  async downloadVideo(
    videoId: string,
    outputBase: string,
    maxHeight: number,
    onProgress: (fraction: number) => void,
  ): Promise<DownloadResult> {
    return this.runDownload(
      videoId,
      outputBase,
      'mp4',
      ['-f', buildVideoFormatSelector(maxHeight), '--merge-output-format', 'mp4'],
      onProgress,
    );
  }
}
