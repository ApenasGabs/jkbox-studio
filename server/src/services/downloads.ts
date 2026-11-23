import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { VideoMode } from '../config.js';
import type { Track } from '../types.js';
import type { TrackRepository } from './tracks.js';
import type { MediaProvider } from './ytdlp.js';

export interface DownloadEvents {
  progress: [track: Track];
  ready: [track: Track];
  failed: [track: Track];
}

export type DownloadPriority = 'high' | 'low';

export interface DownloadManagerOptions {
  videoMode?: VideoMode;
  videoMaxHeight?: number;
  log?: (msg: string) => void;
}

/**
 * Background download queue with smart caching: tracks whose audio is already on disk
 * are marked ready immediately; everything else is fetched by yt-dlp into the music dir.
 * High-priority requests (e.g. guest queue orders) always preempt low-priority discovery batches.
 */
export class DownloadManager extends EventEmitter<DownloadEvents> {
  private readonly pendingHigh: string[] = [];
  private readonly pendingLow: string[] = [];
  private readonly active = new Set<string>();
  private readonly videoActive = new Set<string>();
  private readonly lastEmit = new Map<string, number>();
  private readonly videoMode: VideoMode;
  private readonly videoMaxHeight: number;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly tracks: TrackRepository,
    private readonly media: MediaProvider,
    private readonly musicDir: string,
    private readonly concurrency: number,
    /** Resolves the YouTube video for tracks that don't have one yet (e.g. Spotify tracks). */
    private readonly resolveYoutubeId: (track: Track) => Promise<string | null> = async () => null,
    options: DownloadManagerOptions = {},
  ) {
    super();
    this.videoMode = options.videoMode ?? 'cache';
    this.videoMaxHeight = options.videoMaxHeight ?? 720;
    this.log = options.log ?? console.warn;
    fs.mkdirSync(musicDir, { recursive: true });
  }

  /** Ensures the track's audio (and cached video when enabled) is available. Returns true when audio was served from cache. */
  ensure(trackId: string, priority: DownloadPriority = 'high'): boolean {
    const track = this.tracks.get(trackId);
    if (!track) throw new Error(`Faixa ${trackId} não encontrada`);
    if (this.tracks.isCached(track)) {
      this.ensureVideoBackfill(track);
      return true;
    }

    // Same YouTube video already downloaded for another track (e.g. Spotify -> YouTube match).
    if (track.youtubeId) {
      const twin = this.tracks.findReadyByYoutubeId(track.youtubeId);
      if (twin && twin.id !== track.id && this.tracks.isCached(twin)) {
        const videoPath = this.tracks.isVideoCached(twin) ? twin.videoPath : null;
        this.tracks.update(track.id, { status: 'ready', progress: 1, error: null, filePath: twin.filePath, videoPath });
        const ready = this.tracks.get(track.id)!;
        this.emit('ready', ready);
        if (!videoPath) this.ensureVideoBackfill(ready);
        return true;
      }
    }

    if (this.active.has(trackId)) return false;
    if (this.pendingHigh.includes(trackId)) return false;
    const lowIdx = this.pendingLow.indexOf(trackId);
    if (lowIdx !== -1) {
      if (priority === 'high') {
        this.pendingLow.splice(lowIdx, 1);
        this.pendingHigh.push(trackId);
        this.pump();
      }
      return false;
    }

    this.tracks.update(trackId, { status: 'pending', progress: 0, error: null });
    if (priority === 'low') this.pendingLow.push(trackId);
    else this.pendingHigh.push(trackId);
    this.pump();
    return false;
  }

  /** Re-queues downloads interrupted by a restart. */
  resumeInterrupted(): void {
    for (const track of this.tracks.listActiveDownloads()) this.ensure(track.id);
  }

  get activeCount(): number {
    return this.active.size + this.pendingHigh.length + this.pendingLow.length;
  }

  /** Resolves once all queued downloads (including background video backfills) have settled. */
  async idle(): Promise<void> {
    while (this.activeCount > 0 || this.videoActive.size > 0) await new Promise((r) => setTimeout(r, 5));
  }

  private pump(): void {
    while (this.active.size < this.concurrency && (this.pendingHigh.length > 0 || this.pendingLow.length > 0)) {
      const id = this.pendingHigh.length > 0 ? this.pendingHigh.shift()! : this.pendingLow.shift()!;
      this.active.add(id);
      this.run(id).finally(() => {
        this.active.delete(id);
        this.lastEmit.delete(id);
        this.pump();
      });
    }
  }

  private emitThrottledProgress(trackId: string, fraction: number): void {
    const now = Date.now();
    if (now - (this.lastEmit.get(trackId) ?? 0) < 500 && fraction < 1) return;
    this.lastEmit.set(trackId, now);
    this.tracks.update(trackId, { progress: fraction });
    this.emit('progress', this.tracks.get(trackId)!);
  }

  private ensureVideoBackfill(track: Track): void {
    if (this.videoMode !== 'cache' || !track.youtubeId || this.tracks.isVideoCached(track)) return;
    const twin = this.tracks.findReadyByYoutubeId(track.youtubeId);
    if (twin && twin.id !== track.id && this.tracks.isVideoCached(twin)) {
      this.tracks.update(track.id, { videoPath: twin.videoPath });
      this.emit('ready', this.tracks.get(track.id)!);
      return;
    }
    if (!this.media.downloadVideo || this.videoActive.has(track.id)) return;
    this.videoActive.add(track.id);
    void this.downloadVideoSafe(track.id, track.youtubeId)
      .then((videoPath) => {
        if (!videoPath) return;
        this.tracks.update(track.id, { videoPath });
        const updated = this.tracks.get(track.id);
        if (updated) this.emit('ready', updated);
      })
      .finally(() => {
        this.videoActive.delete(track.id);
      });
  }

  private async downloadVideoSafe(
    trackId: string,
    youtubeId: string,
    onProgress: (fraction: number) => void = () => {},
  ): Promise<string | null> {
    if (this.videoMode !== 'cache' || !this.media.downloadVideo) return null;
    try {
      const { filePath } = await this.media.downloadVideo(
        youtubeId,
        path.join(this.musicDir, `${trackId}.video`),
        this.videoMaxHeight,
        onProgress,
      );
      if (!fs.existsSync(filePath)) {
        this.log(`[video] arquivo de vídeo não encontrado após download: ${filePath}`);
        return null;
      }
      return filePath;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[video] falha ao baixar clipe (${youtubeId}), mantendo apenas áudio: ${message}`);
      return null;
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
          const videoPath = this.tracks.isVideoCached(twin) ? twin.videoPath : null;
          this.tracks.update(trackId, { status: 'ready', progress: 1, filePath: twin.filePath, videoPath });
          const ready = this.tracks.get(trackId)!;
          this.emit('ready', ready);
          if (!videoPath) this.ensureVideoBackfill(ready);
          return;
        }
      }

      const wantsVideo = this.videoMode === 'cache' && !!this.media.downloadVideo;
      const { filePath } = await this.media.download(youtubeId, path.join(this.musicDir, trackId), (fraction) => {
        this.emitThrottledProgress(trackId, wantsVideo ? fraction * 0.5 : fraction);
      });
      if (!fs.existsSync(filePath)) throw new Error(`Arquivo baixado não encontrado: ${filePath}`);

      const videoPath = wantsVideo
        ? await this.downloadVideoSafe(trackId, youtubeId, (fraction) => this.emitThrottledProgress(trackId, 0.5 + fraction * 0.5))
        : null;

      this.tracks.update(trackId, { status: 'ready', progress: 1, filePath, videoPath, error: null });
      this.emit('ready', this.tracks.get(trackId)!);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.tracks.update(trackId, { status: 'error', error: message });
      this.emit('failed', this.tracks.get(trackId)!);
    }
  }
}
