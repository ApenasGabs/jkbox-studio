import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { Track } from '../types.js';
import type { TrackRepository } from './tracks.js';
import type { MediaProvider } from './ytdlp.js';

export interface DownloadEvents {
  progress: [track: Track];
  ready: [track: Track];
  failed: [track: Track];
}

/**
 * Background download queue with smart caching: tracks whose audio is already on disk
 * are marked ready immediately; everything else is fetched by yt-dlp into the music dir.
 */
export class DownloadManager extends EventEmitter<DownloadEvents> {
  private readonly pending: string[] = [];
  private readonly active = new Set<string>();
  private readonly lastEmit = new Map<string, number>();

  constructor(
    private readonly tracks: TrackRepository,
    private readonly media: MediaProvider,
    private readonly musicDir: string,
    private readonly concurrency: number,
    /** Resolves the YouTube video for tracks that don't have one yet (e.g. Spotify tracks). */
    private readonly resolveYoutubeId: (track: Track) => Promise<string | null> = async () => null,
  ) {
    super();
    fs.mkdirSync(musicDir, { recursive: true });
  }

  /** Ensures the track's audio is available. Returns true when it was served from cache. */
  ensure(trackId: string): boolean {
    const track = this.tracks.get(trackId);
    if (!track) throw new Error(`Faixa ${trackId} não encontrada`);
    if (this.tracks.isCached(track)) return true;

    // Same YouTube video already downloaded for another track (e.g. Spotify -> YouTube match).
    if (track.youtubeId) {
      const twin = this.tracks.findReadyByYoutubeId(track.youtubeId);
      if (twin && twin.id !== track.id && this.tracks.isCached(twin)) {
        this.tracks.update(track.id, { status: 'ready', progress: 1, error: null, filePath: twin.filePath });
        this.emit('ready', this.tracks.get(track.id)!);
        return true;
      }
    }

    if (this.active.has(trackId) || this.pending.includes(trackId)) return false;
    this.tracks.update(trackId, { status: 'pending', progress: 0, error: null });
    this.pending.push(trackId);
    this.pump();
    return false;
  }

  /** Re-queues downloads interrupted by a restart. */
  resumeInterrupted(): void {
    for (const track of this.tracks.listActiveDownloads()) this.ensure(track.id);
  }

  get activeCount(): number {
    return this.active.size + this.pending.length;
  }

  /** Resolves once all queued downloads have settled (useful for tests). */
  async idle(): Promise<void> {
    while (this.activeCount > 0) await new Promise((r) => setTimeout(r, 5));
  }

  private pump(): void {
    while (this.active.size < this.concurrency && this.pending.length > 0) {
      const id = this.pending.shift()!;
      this.active.add(id);
      this.run(id).finally(() => {
        this.active.delete(id);
        this.lastEmit.delete(id);
        this.pump();
      });
    }
  }

  private async run(trackId: string): Promise<void> {
    const track = this.tracks.get(trackId);
    if (!track) return;
    try {
      this.tracks.update(trackId, { status: 'downloading', progress: 0 });
      this.emit('progress', this.tracks.get(trackId)!);

      let youtubeId = track.youtubeId;
      if (!youtubeId) {
        youtubeId = await this.resolveYoutubeId(track);
        if (!youtubeId) throw new Error('Nenhum áudio correspondente encontrado no YouTube');
        this.tracks.update(trackId, { youtubeId });
        const twin = this.tracks.findReadyByYoutubeId(youtubeId);
        if (twin && twin.id !== trackId && this.tracks.isCached(twin)) {
          this.tracks.update(trackId, { status: 'ready', progress: 1, filePath: twin.filePath });
          this.emit('ready', this.tracks.get(trackId)!);
          return;
        }
      }

      const { filePath } = await this.media.download(youtubeId, path.join(this.musicDir, trackId), (fraction) => {
        const now = Date.now();
        if (now - (this.lastEmit.get(trackId) ?? 0) < 500 && fraction < 1) return;
        this.lastEmit.set(trackId, now);
        this.tracks.update(trackId, { progress: fraction });
        this.emit('progress', this.tracks.get(trackId)!);
      });
      if (!fs.existsSync(filePath)) throw new Error(`Arquivo baixado não encontrado: ${filePath}`);
      this.tracks.update(trackId, { status: 'ready', progress: 1, filePath, error: null });
      this.emit('ready', this.tracks.get(trackId)!);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.tracks.update(trackId, { status: 'error', error: message });
      this.emit('failed', this.tracks.get(trackId)!);
    }
  }
}
