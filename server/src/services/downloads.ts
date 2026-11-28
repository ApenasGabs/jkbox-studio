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
  video: [track: Track];
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
  private readonly pendingVideos = new Map<string, string>();
  private readonly active = new Set<string>();
  private readonly activeVideos = new Set<string>();
  private readonly videoPromises = new Map<string, Promise<string | null>>();
  private readonly youtubeIdResolvers = new Map<string, Promise<string | null>>();
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
    while (
      this.activeCount > 0 ||
      this.pendingVideos.size > 0 ||
      this.activeVideos.size > 0 ||
      this.videoPromises.size > 0 ||
      this.youtubeIdResolvers.size > 0
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /**
   * Ensures `youtubeId` is resolved (when `VIDEO_MODE !== 'off'`) and a cached MP4 video
   * is fetched in background (when `VIDEO_MODE === 'cache'`), without downloading audio or
   * altering `track.status`. Used while Spotify Connect handles audio playback.
   */
  async ensureVideo(trackId: string): Promise<Track | null> {
    if (this.videoMode === 'off') return null;
    const track = this.tracks.get(trackId);
    if (!track) return null;

    let youtubeId = track.youtubeId;
    if (!youtubeId) {
      try {
        youtubeId = await this.resolveAndPersistYoutubeId(trackId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`[video] falha ao resolver YouTube ID (${track.title}): ${message}`);
        return this.tracks.get(trackId);
      }
      if (!youtubeId) return this.tracks.get(trackId);
      const withYt = this.tracks.get(trackId);
      if (withYt) this.emit('video', withYt);
    }

    const latest = this.tracks.get(trackId);
    if (!latest || this.videoMode !== 'cache' || this.hasVideoFile(latest)) {
      return latest;
    }

    const twin = this.tracks.findReadyByYoutubeId(youtubeId);
    if (twin && twin.id !== latest.id && this.hasVideoFile(twin)) {
      this.tracks.update(latest.id, { videoPath: twin.videoPath });
      const updated = this.tracks.get(latest.id);
      if (updated) this.emit('video', updated);
      return updated;
    }

    await this.startVideoDownload(latest.id, youtubeId);
    return this.tracks.get(latest.id);
  }

  private pump(): void {
    while (
      this.active.size + this.activeVideos.size < this.concurrency &&
      (this.pendingHigh.length > 0 || this.pendingLow.length > 0)
    ) {
      const id = this.pendingHigh.length > 0 ? this.pendingHigh.shift()! : this.pendingLow.shift()!;
      this.active.add(id);
      this.run(id).finally(() => {
        this.active.delete(id);
        this.lastEmit.delete(id);
        this.pump();
      });
    }

    // Background video backfills yield to pending audio and leave at least 1 audio slot free when concurrency > 1.
    const maxVideoSlots = this.concurrency > 1 ? this.concurrency - 1 : 1;
    while (
      this.pendingHigh.length === 0 &&
      this.pendingLow.length === 0 &&
      this.active.size + this.activeVideos.size < this.concurrency &&
      this.activeVideos.size < maxVideoSlots &&
      this.pendingVideos.size > 0
    ) {
      const next = this.pendingVideos.entries().next();
      if (next.done) break;
      const [trackId, youtubeId] = next.value;
      this.pendingVideos.delete(trackId);
      const current = this.tracks.get(trackId);
      if (!current || this.hasVideoFile(current)) continue;
      if (this.linkTwinVideo(trackId, youtubeId)) continue;
      this.activeVideos.add(trackId);
      void this.startVideoDownload(trackId, youtubeId).finally(() => {
        this.activeVideos.delete(trackId);
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

  private hasVideoFile(track: Track): boolean {
    return Boolean(track.videoPath && fs.existsSync(track.videoPath));
  }

  private resolveAndPersistYoutubeId(trackId: string): Promise<string | null> {
    const current = this.tracks.get(trackId);
    if (!current) return Promise.resolve(null);
    if (current.youtubeId) return Promise.resolve(current.youtubeId);
    const existing = this.youtubeIdResolvers.get(trackId);
    if (existing) return existing;

    const task = this.resolveYoutubeId(current)
      .then((youtubeId) => {
        if (youtubeId) {
          this.tracks.update(trackId, { youtubeId });
        }
        return youtubeId;
      })
      .finally(() => {
        this.youtubeIdResolvers.delete(trackId);
      });
    this.youtubeIdResolvers.set(trackId, task);
    return task;
  }

  private linkTwinVideo(trackId: string, youtubeId: string): boolean {
    const twin = this.tracks.findReadyByYoutubeId(youtubeId);
    if (!twin || twin.id === trackId || !this.hasVideoFile(twin)) return false;
    this.tracks.update(trackId, { videoPath: twin.videoPath });
    const updated = this.tracks.get(trackId);
    if (updated) this.emit('video', updated);
    return true;
  }

  private startVideoDownload(
    trackId: string,
    youtubeId: string,
    options: { onProgress?: (fraction: number) => void; emitEvent?: boolean } = {},
  ): Promise<string | null> {
    if (this.videoMode !== 'cache' || !this.media.downloadVideo) return Promise.resolve(null);
    this.pendingVideos.delete(trackId);
    const existing = this.videoPromises.get(trackId);
    if (existing) return existing;

    const emitEvent = options.emitEvent ?? true;
    const promise = this.downloadVideoSafe(trackId, youtubeId, options.onProgress)
      .then((videoPath) => {
        if (videoPath) {
          this.tracks.update(trackId, { videoPath });
          if (emitEvent) {
            const updated = this.tracks.get(trackId);
            if (updated) this.emit('video', updated);
          }
        }
        return videoPath;
      })
      .finally(() => {
        this.videoPromises.delete(trackId);
      });
    this.videoPromises.set(trackId, promise);
    return promise;
  }

  private ensureVideoBackfill(track: Track, shouldPump = true): void {
    if (this.videoMode !== 'cache' || !this.media.downloadVideo || !track.youtubeId || this.hasVideoFile(track)) return;
    if (this.videoPromises.has(track.id) || this.pendingVideos.has(track.id)) return;
    if (this.linkTwinVideo(track.id, track.youtubeId)) return;
    this.pendingVideos.set(track.id, track.youtubeId);
    if (shouldPump) this.pump();
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
        youtubeId = await this.resolveAndPersistYoutubeId(trackId);
        if (!youtubeId) throw new Error('Nenhum áudio correspondente encontrado no YouTube');
        const twin = this.tracks.findReadyByYoutubeId(youtubeId);
        if (twin && twin.id !== trackId && this.tracks.isCached(twin)) {
          const videoPath = this.tracks.isVideoCached(twin) ? twin.videoPath : null;
          this.tracks.update(trackId, { status: 'ready', progress: 1, filePath: twin.filePath, videoPath, error: null });
          const ready = this.tracks.get(trackId)!;
          this.emit('ready', ready);
          if (!videoPath) this.ensureVideoBackfill(ready, false);
          return;
        }
      }

      const { filePath } = await this.media.download(youtubeId, path.join(this.musicDir, trackId), (fraction) => {
        this.emitThrottledProgress(trackId, fraction);
      });
      if (!fs.existsSync(filePath)) throw new Error(`Arquivo baixado não encontrado: ${filePath}`);

      const fresh = this.tracks.get(trackId);
      let videoPath: string | null = fresh && this.hasVideoFile(fresh) ? fresh.videoPath : null;
      if (!videoPath) {
        const twin = this.tracks.findReadyByYoutubeId(youtubeId);
        if (twin && twin.id !== trackId && this.hasVideoFile(twin)) {
          videoPath = twin.videoPath;
        }
      }

      this.tracks.update(trackId, { status: 'ready', progress: 1, filePath, videoPath, error: null });
      const ready = this.tracks.get(trackId)!;
      this.emit('ready', ready);
      if (!videoPath) this.ensureVideoBackfill(ready, false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.tracks.update(trackId, { status: 'error', error: message });
      this.emit('failed', this.tracks.get(trackId)!);
    }
  }
}
