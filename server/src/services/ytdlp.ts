import { spawn } from 'node:child_process';
import type { AudioFormat } from '../config.js';
import type { SearchResult } from '../types.js';

export interface DownloadResult {
  filePath: string;
}

/** Abstraction over yt-dlp so the rest of the app (and tests) don't depend on the binary. */
export interface MediaProvider {
  search(query: string, limit?: number): Promise<SearchResult[]>;
  getVideo(videoId: string): Promise<SearchResult>;
  getPlaylist(url: string, limit?: number): Promise<SearchResult[]>;
  download(videoId: string, outputBase: string, onProgress: (fraction: number) => void): Promise<DownloadResult>;
  version(): Promise<string>;
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
  thumbnails?: { url: string; width?: number }[];
}

const PROGRESS_PREFIX = 'jkbox-progress:';

export function entryToResult(entry: YtEntry): SearchResult {
  const thumbs = entry.thumbnails ?? [];
  const bestThumb =
    entry.thumbnail ??
    [...thumbs].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ??
    `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`;
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
    const out = await this.run(['-J', '--no-playlist', `https://www.youtube.com/watch?v=${videoId}`]);
    return entryToResult(JSON.parse(out) as YtEntry);
  }

  async getPlaylist(url: string, limit = 50): Promise<SearchResult[]> {
    const out = await this.run([url, '--flat-playlist', '-J', '--playlist-end', String(limit)]);
    const data = JSON.parse(out) as { entries?: YtEntry[] };
    return (data.entries ?? []).filter((e) => e?.id).map(entryToResult);
  }

  async download(videoId: string, outputBase: string, onProgress: (fraction: number) => void): Promise<DownloadResult> {
    let filePath = '';
    await this.run(
      [
        `https://www.youtube.com/watch?v=${videoId}`,
        '--no-playlist',
        '-f',
        'bestaudio/best',
        '-x',
        '--audio-format',
        this.audioFormat,
        '--audio-quality',
        '0',
        '--embed-metadata',
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
    if (!filePath) filePath = `${outputBase}.${this.audioFormat}`;
    return { filePath };
  }
}
