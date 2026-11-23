import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import { createJukebox } from '../src/container.js';
import type { FetchFn } from '../src/services/spotify.js';
import type { MediaProvider } from '../src/services/ytdlp.js';
import type { SearchResult } from '../src/types.js';

export function ytResult(id: string, title = `Song ${id}`, artist = 'Artist'): SearchResult {
  return { source: 'youtube', sourceId: id, title, artist, durationSec: 120, thumbnail: null };
}

/** In-memory MediaProvider that "downloads" by writing a small fake audio file. */
export class FakeMedia implements MediaProvider {
  downloads: string[] = [];
  videoDownloads: string[] = [];
  lastMaxHeight: number | null = null;
  searches: string[] = [];
  failIds = new Set<string>();
  failVideoIds = new Set<string>();
  /** When set, downloads wait until release() is called. */
  gate: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;

  hold(): void {
    this.gate = new Promise((r) => (this.releaseGate = r));
  }
  release(): void {
    this.releaseGate?.();
    this.gate = null;
  }

  async search(query: string, limit = 10): Promise<SearchResult[]> {
    this.searches.push(query);
    return Array.from({ length: Math.min(limit, 3) }, (_, i) => ytResult(`yt${String(i).padStart(9, '0')}`, `${query} ${i}`));
  }
  async getVideo(videoId: string): Promise<SearchResult> {
    return ytResult(videoId);
  }
  async getPlaylist(): Promise<SearchResult[]> {
    return [ytResult('aaaaaaaaaaa'), ytResult('bbbbbbbbbbb')];
  }
  async download(videoId: string, outputBase: string, onProgress: (f: number) => void) {
    this.downloads.push(videoId);
    if (this.gate) await this.gate;
    if (this.failIds.has(videoId)) throw new Error('boom');
    onProgress(0.5);
    onProgress(1);
    const filePath = `${outputBase}.m4a`;
    fs.writeFileSync(filePath, Buffer.alloc(1000, 7));
    return { filePath };
  }
  async downloadVideo(videoId: string, outputBase: string, maxHeight: number, onProgress: (f: number) => void) {
    this.videoDownloads.push(videoId);
    this.lastMaxHeight = maxHeight;
    if (this.failVideoIds.has(videoId)) throw new Error('video boom');
    onProgress(0.5);
    onProgress(1);
    const filePath = `${outputBase}.mp4`;
    fs.writeFileSync(filePath, Buffer.alloc(2000, 9));
    return { filePath };
  }
  async version() {
    return 'fake';
  }
}

export function tempConfig(env: Record<string, string> = {}): Config {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jkbox-test-'));
  return loadConfig({ DATA_DIR: dir, WEB_DIR: path.join(dir, 'no-web'), ...env });
}

export function setup(env: Record<string, string> = {}, fetchFn?: FetchFn) {
  const config = tempConfig(env);
  const media = new FakeMedia();
  const jukebox = createJukebox(config, {
    media,
    fetchFn,
    log: () => {},
    externalClassifierLookup: Boolean(fetchFn),
  });
  return { config, media, jukebox };
}
