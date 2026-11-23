import { EventEmitter } from 'node:events';
import type { Settings } from '../db.js';
import { DEFAULT_AUTO_DJ_RECENT_WINDOW, pickAutoDjTrack } from '../lib/autoDj.js';
import { parseInput } from '../lib/parseInput.js';
import { sanitizeResult } from '../lib/validate.js';
import type { PlaybackOutput, QueueEntryView, SearchResult, SpotifyDevice, Track, TrackSource } from '../types.js';
import type { DownloadManager } from './downloads.js';
import type { LyricsService } from './lyrics.js';
import { QueueError, type QueueService } from './queue.js';
import { SpotifyError, youtubeQueryFor, type SpotifyService } from './spotify.js';
import type { TrackRepository } from './tracks.js';
import type { MediaProvider } from './ytdlp.js';

export type SearchSource = 'all' | TrackSource;

export interface SearchResponse {
  results: SearchResult[];
  errors: Partial<Record<TrackSource, string>>;
}

export interface EnqueueRequest {
  /** Untrusted payload (validated by `sanitizeResult`). */
  result: unknown;
  requesterId: string;
  requesterName: string;
  /** Mirror the song into the shared Spotify playlist (false when it was imported from there). */
  syncSpotify?: boolean;
}

export interface JukeboxEvents {
  output: [output: PlaybackOutput];
  notice: [message: string, error: boolean];
}

const MAX_BATCH = 50;
const DEFAULT_SPOTIFY_POLL_MS = 2500;
const SPOTIFY_START_GRACE_MS = 5000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizePlaybackOutput(raw: unknown, spotifyConnected: boolean): PlaybackOutput {
  if (!spotifyConnected || !raw || typeof raw !== 'object') return { type: 'local' };
  const candidate = raw as { type?: unknown; deviceId?: unknown; deviceName?: unknown };
  if (candidate.type === 'spotify' && typeof candidate.deviceId === 'string' && candidate.deviceId.trim()) {
    return {
      type: 'spotify',
      deviceId: candidate.deviceId.trim(),
      deviceName:
        typeof candidate.deviceName === 'string' && candidate.deviceName.trim()
          ? candidate.deviceName.trim()
          : 'Spotify Connect',
    };
  }
  return { type: 'local' };
}

function cleanTrackTitleForSpotify(title: string): string {
  return title
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Orchestrates search, cache, downloads, queue and the Spotify shared playlist / Connect playback. */
export class Jukebox extends EventEmitter<JukeboxEvents> {
  private importTimer: NodeJS.Timeout | null = null;
  private spotifyPollTimer: NodeJS.Timeout | null = null;
  private spotifyPollIntervalMs = DEFAULT_SPOTIFY_POLL_MS;
  private spotifyPollInFlight = false;
  private spotifyPlaySeq = 0;
  private outputGen = 0;
  private outputSwitchChain: Promise<unknown> = Promise.resolve();
  private readonly spotifyUnavailableTrackIds = new Set<string>();
  private activeSpotifyQueueId: number | null = null;
  private activeSpotifyTrackUri: string | null = null;
  private spotifyStartedAtMs = 0;
  private spotifySeenPlaying = false;
  private spotifyLastProgressMs = 0;
  private consecutiveSpotifyMisses = 0;
  private _autoDjEnabled: boolean;
  private _playbackOutput: PlaybackOutput;

  constructor(
    readonly tracks: TrackRepository,
    readonly queue: QueueService,
    readonly downloads: DownloadManager,
    readonly media: MediaProvider,
    readonly spotify: SpotifyService,
    readonly lyrics: LyricsService,
    private readonly log: (msg: string) => void = console.log,
    readonly settings?: Settings,
  ) {
    super();
    this._autoDjEnabled = this.settings?.get<boolean>('autoDjEnabled') ?? false;
    this._playbackOutput = normalizePlaybackOutput(this.settings?.get<unknown>('playback_output'), spotify.connected);
    queue.setPlayablePredicate((track) => track.status === 'ready' || this._playbackOutput.type === 'spotify');
    downloads.on('ready', () => queue.advanceIfIdle());
    queue.on('started', (entry) => {
      if (this._playbackOutput.type === 'spotify') {
        void this.playCurrentOnSpotify(entry);
      }
    });
    queue.on('drained', () => {
      const autoAdded = this.maybeEnqueueAutoDj();
      if (!autoAdded && this._playbackOutput.type === 'spotify' && this.activeSpotifyQueueId !== null) {
        const deviceId = this._playbackOutput.deviceId;
        this.stopSpotifyPolling();
        this.activeSpotifyQueueId = null;
        this.activeSpotifyTrackUri = null;
        void this.spotify.pausePlayback(deviceId).catch((err) => {
          this.log(`[spotify-connect] falha ao pausar ao esvaziar fila: ${errorMessage(err)}`);
        });
      }
    });
  }

  get playbackOutput(): PlaybackOutput {
    return this._playbackOutput;
  }

  setSpotifyPollIntervalMs(ms: number): void {
    this.spotifyPollIntervalMs = Math.max(10, Math.round(ms));
    if (this.spotifyPollTimer) {
      this.stopSpotifyPolling();
      this.startSpotifyPolling();
    }
  }

  async getSpotifyDevices(): Promise<{ devices: SpotifyDevice[]; playbackOutput: PlaybackOutput }> {
    const devices = await this.spotify.getDevices();
    return { devices, playbackOutput: this._playbackOutput };
  }

  setPlaybackOutput(deviceId: string | null): Promise<PlaybackOutput> {
    const run = this.outputSwitchChain.then(
      () => this.applyPlaybackOutput(deviceId),
      () => this.applyPlaybackOutput(deviceId),
    );
    this.outputSwitchChain = run.catch(() => {});
    return run;
  }

  private commitSpotifyOutput(device: Pick<SpotifyDevice, 'id' | 'name'>): void {
    this._playbackOutput = { type: 'spotify', deviceId: device.id, deviceName: device.name };
    this.settings?.set('playback_output', this._playbackOutput);
    this.consecutiveSpotifyMisses = 0;
    this.emit('output', this._playbackOutput);
    this.queue.emit('change');
  }

  private resetToLocalOutput(pauseDeviceId?: string): PlaybackOutput {
    this.outputGen += 1;
    this.spotifyPlaySeq += 1;
    this.stopSpotifyPolling();
    this._playbackOutput = { type: 'local' };
    this.settings?.set('playback_output', this._playbackOutput);
    this.activeSpotifyQueueId = null;
    this.activeSpotifyTrackUri = null;
    this.spotifySeenPlaying = false;
    this.consecutiveSpotifyMisses = 0;
    if (pauseDeviceId) {
      void this.spotify.pausePlayback(pauseDeviceId).catch((err) => {
        this.log(`[spotify-connect] falha ao pausar dispositivo anterior: ${errorMessage(err)}`);
      });
    }
    const current = this.queue.state().nowPlaying;
    if (current) {
      try {
        this.downloads.ensure(current.item.trackId);
      } catch (err) {
        this.log(`[spotify-connect] falha ao garantir download local: ${errorMessage(err)}`);
      }
    }
    this.emit('output', this._playbackOutput);
    this.queue.emit('change');
    return this._playbackOutput;
  }

  private markSpotifyTrackPlaying(queueId: number, uri: string, positionMs: number): void {
    this.activeSpotifyQueueId = queueId;
    this.activeSpotifyTrackUri = uri;
    this.spotifyStartedAtMs = Date.now();
    this.spotifySeenPlaying = false;
    this.spotifyLastProgressMs = positionMs;
    this.queue.reportProgress(positionMs / 1000, false);
    this.startSpotifyPolling();
  }

  private async applyPlaybackOutput(deviceId: string | null): Promise<PlaybackOutput> {
    const prev = this._playbackOutput;
    if (deviceId === null) {
      return this.resetToLocalOutput(prev.type === 'spotify' ? prev.deviceId : undefined);
    }

    const gen = ++this.outputGen;
    const devices = await this.spotify.getDevices();
    if (gen !== this.outputGen || !this.spotify.connected) {
      return this._playbackOutput;
    }

    const device = devices.find((d) => d.id === deviceId);
    if (!device) {
      throw new SpotifyError('Dispositivo Spotify Connect não encontrado ou indisponível', 404, 'NO_ACTIVE_DEVICE');
    }

    if (prev.type === 'spotify' && prev.deviceId === device.id) {
      if (prev.deviceName !== device.name) {
        this.commitSpotifyOutput(device);
      }
      return this._playbackOutput;
    }

    const nowPlaying = this.queue.state().nowPlaying;
    const shouldPlay = Boolean(nowPlaying && !nowPlaying.paused);
    const seq = ++this.spotifyPlaySeq;
    this.stopSpotifyPolling();

    const restorePrevPollingIfNeeded = () => {
      const current = this.queue.state().nowPlaying;
      if (
        this._playbackOutput.type === 'spotify' &&
        current &&
        !current.paused &&
        this.activeSpotifyQueueId === current.item.id
      ) {
        this.startSpotifyPolling();
      }
    };

    try {
      if (prev.type === 'spotify' && shouldPlay && nowPlaying && this.activeSpotifyQueueId === nowPlaying.item.id) {
        await this.spotify.transferPlayback(device.id, true);
        if (seq !== this.spotifyPlaySeq || gen !== this.outputGen || this._playbackOutput.type !== 'spotify') {
          return this._playbackOutput;
        }
        const positionMs = Math.round(nowPlaying.positionSec * 1000);
        this.spotifyStartedAtMs = Date.now();
        this.spotifySeenPlaying = false;
        this.spotifyLastProgressMs = positionMs;
        this.commitSpotifyOutput(device);
        this.startSpotifyPolling();
        return this._playbackOutput;
      }

      if (shouldPlay && nowPlaying) {
        const positionMs = Math.round(nowPlaying.positionSec * 1000);
        const uri = await this.resolveSpotifyUri(nowPlaying.item.track);
        if (seq !== this.spotifyPlaySeq || gen !== this.outputGen) {
          return this._playbackOutput;
        }

        if (!uri) {
          // Validate account/device permissions (e.g. 403 PREMIUM_REQUIRED / 404 NO_ACTIVE_DEVICE) before switching.
          await this.spotify.transferPlayback(device.id, false);
          if (seq !== this.spotifyPlaySeq || gen !== this.outputGen) {
            return this._playbackOutput;
          }
          this.commitSpotifyOutput(device);
          if (this.queue.state().nowPlaying?.item.id === nowPlaying.item.id) {
            this.spotifyUnavailableTrackIds.add(nowPlaying.item.trackId);
            this.consecutiveSpotifyMisses += 1;
            const msg = `Faixa "${nowPlaying.item.track.title}" não encontrada no Spotify — pulando para a próxima.`;
            this.log(`[spotify-connect] ${msg}`);
            this.emit('notice', msg, true);
            this.queue.skip();
          }
          return this._playbackOutput;
        }

        await this.spotify.playTrack(uri, device.id, positionMs);
        if (seq !== this.spotifyPlaySeq || gen !== this.outputGen) {
          return this._playbackOutput;
        }
        this.commitSpotifyOutput(device);
        const latest = this.queue.state().nowPlaying;
        if (latest?.item.id === nowPlaying.item.id) {
          this.markSpotifyTrackPlaying(nowPlaying.item.id, uri, positionMs);
        } else if (latest && !latest.paused) {
          void this.playCurrentOnSpotify(latest.item, Math.round(latest.positionSec * 1000));
        } else if (!latest) {
          this.queue.advanceIfIdle();
        }
        return this._playbackOutput;
      }

      await this.spotify.transferPlayback(device.id, false);
      if (seq !== this.spotifyPlaySeq || gen !== this.outputGen) {
        return this._playbackOutput;
      }
      this.commitSpotifyOutput(device);
      if (!this.queue.state().nowPlaying) {
        this.queue.advanceIfIdle();
      }
      return this._playbackOutput;
    } catch (err) {
      if (seq === this.spotifyPlaySeq && gen === this.outputGen) {
        restorePrevPollingIfNeeded();
      }
      throw err;
    }
  }

  async pauseSpotifyPlayback(): Promise<void> {
    if (this._playbackOutput.type !== 'spotify') {
      throw new SpotifyError('Saída ativa não é um dispositivo Spotify Connect', 409);
    }
    await this.spotify.pausePlayback(this._playbackOutput.deviceId);
    const current = this.queue.state().nowPlaying;
    if (current) this.queue.reportProgress(current.positionSec, true);
  }

  async resumeSpotifyPlayback(): Promise<void> {
    if (this._playbackOutput.type !== 'spotify') {
      throw new SpotifyError('Saída ativa não é um dispositivo Spotify Connect', 409);
    }
    const current = this.queue.state().nowPlaying;
    if (current && this.activeSpotifyQueueId !== current.item.id) {
      await this.playCurrentOnSpotify(current.item, Math.round(current.positionSec * 1000));
      return;
    }
    await this.spotify.resumePlayback(this._playbackOutput.deviceId);
    if (current) {
      this.queue.reportProgress(current.positionSec, false);
      this.startSpotifyPolling();
    }
  }

  async setSpotifyVolume(volume: number): Promise<number> {
    if (this._playbackOutput.type !== 'spotify') {
      throw new SpotifyError('Saída ativa não é um dispositivo Spotify Connect', 409);
    }
    const clamped = Math.max(0, Math.min(100, Math.round(volume)));
    await this.spotify.setVolume(clamped, this._playbackOutput.deviceId);
    return clamped;
  }

  disconnectSpotify(): void {
    this.spotify.disconnect();
    if (this._playbackOutput.type === 'spotify') {
      this.resetToLocalOutput();
    }
  }

  /** Resumes Spotify Connect playback/polling after a server restart if a track was already playing. */
  syncStartupPlayback(): void {
    if (this._playbackOutput.type !== 'spotify') return;
    const current = this.queue.state().nowPlaying;
    if (!current || this.activeSpotifyQueueId === current.item.id) return;
    void this.playCurrentOnSpotify(current.item, Math.round(current.positionSec * 1000));
  }

  private async resolveSpotifyUri(track: Track): Promise<string | null> {
    if (track.spotifyUri) return track.spotifyUri;
    if (track.source === 'spotify') return `spotify:track:${track.sourceId}`;
    const primaryQuery = `${track.title} ${track.artist}`.trim();
    if (primaryQuery) {
      const [match] = await this.spotify.search(primaryQuery, 1);
      if (match?.spotifyUri) {
        this.tracks.update(track.id, { spotifyUri: match.spotifyUri });
        return match.spotifyUri;
      }
    }
    const cleanedTitle = cleanTrackTitleForSpotify(track.title);
    const fallbackQuery = `${cleanedTitle} ${track.artist}`.trim();
    if (fallbackQuery && fallbackQuery !== primaryQuery) {
      const [match] = await this.spotify.search(fallbackQuery, 1);
      if (match?.spotifyUri) {
        this.tracks.update(track.id, { spotifyUri: match.spotifyUri });
        return match.spotifyUri;
      }
    }
    return null;
  }

  private async playCurrentOnSpotify(entry: QueueEntryView, positionMs = 0): Promise<void> {
    if (this._playbackOutput.type !== 'spotify') return;
    const deviceId = this._playbackOutput.deviceId;
    const seq = ++this.spotifyPlaySeq;
    this.stopSpotifyPolling();

    try {
      const uri = await this.resolveSpotifyUri(entry.track);
      if (
        seq !== this.spotifyPlaySeq ||
        this._playbackOutput.type !== 'spotify' ||
        this.queue.state().nowPlaying?.item.id !== entry.id
      ) {
        return;
      }

      if (!uri) {
        this.spotifyUnavailableTrackIds.add(entry.track.id);
        this.consecutiveSpotifyMisses += 1;
        const msg = `Faixa "${entry.track.title}" não encontrada no Spotify — pulando para a próxima.`;
        this.log(`[spotify-connect] ${msg}`);
        this.emit('notice', msg, true);
        this.queue.skip();
        return;
      }

      this.consecutiveSpotifyMisses = 0;
      await this.spotify.playTrack(uri, deviceId, positionMs);
      if (
        seq !== this.spotifyPlaySeq ||
        this._playbackOutput.type !== 'spotify' ||
        this.queue.state().nowPlaying?.item.id !== entry.id
      ) {
        return;
      }

      this.markSpotifyTrackPlaying(entry.id, uri, positionMs);
    } catch (err) {
      if (seq !== this.spotifyPlaySeq) return;
      const msg = errorMessage(err);
      this.log(`[spotify-connect] falha ao iniciar "${entry.track.title}": ${msg}`);
      this.stopSpotifyPolling();
      this.queue.reportProgress(positionMs / 1000, true);
      this.emit('notice', msg, true);
    }
  }

  private startSpotifyPolling(): void {
    if (this.spotifyPollTimer || this._playbackOutput.type !== 'spotify') return;
    this.spotifyPollTimer = setInterval(() => {
      void this.pollSpotifyPlayback();
    }, this.spotifyPollIntervalMs);
    this.spotifyPollTimer.unref();
  }

  private stopSpotifyPolling(): void {
    if (this.spotifyPollTimer) {
      clearInterval(this.spotifyPollTimer);
      this.spotifyPollTimer = null;
    }
  }

  async pollSpotifyPlayback(): Promise<void> {
    if (this.spotifyPollInFlight) return;
    if (this._playbackOutput.type !== 'spotify') {
      this.stopSpotifyPolling();
      return;
    }
    const current = this.queue.state().nowPlaying;
    if (!current || current.item.id !== this.activeSpotifyQueueId || !this.activeSpotifyTrackUri) {
      this.stopSpotifyPolling();
      return;
    }

    const seq = this.spotifyPlaySeq;
    const deviceId = this._playbackOutput.deviceId;
    this.spotifyPollInFlight = true;
    try {
      const playback = await this.spotify.getPlaybackState();
      if (
        seq !== this.spotifyPlaySeq ||
        this._playbackOutput.type !== 'spotify' ||
        this._playbackOutput.deviceId !== deviceId ||
        this.queue.state().nowPlaying?.item.id !== current.item.id
      ) {
        return;
      }
      const inGrace = !this.spotifySeenPlaying && Date.now() - this.spotifyStartedAtMs < SPOTIFY_START_GRACE_MS;

      if (!playback) {
        if (inGrace) return;
        if (this.spotifySeenPlaying) {
          this.stopSpotifyPolling();
          this.queue.ended(current.item.id);
        }
        return;
      }

      if (playback.trackUri && playback.trackUri !== this.activeSpotifyTrackUri) {
        if (inGrace) return;
        if (this.spotifySeenPlaying) {
          this.stopSpotifyPolling();
          this.queue.ended(current.item.id);
        }
        return;
      }

      if (playback.isPlaying) {
        this.spotifySeenPlaying = true;
        this.spotifyLastProgressMs = playback.progressMs;
        this.queue.reportProgress(playback.progressMs / 1000, false);
        return;
      }

      if (this.spotifySeenPlaying && playback.progressMs === 0 && this.spotifyLastProgressMs > 3000) {
        this.stopSpotifyPolling();
        this.queue.ended(current.item.id);
        return;
      }

      this.spotifyLastProgressMs = playback.progressMs;
      this.queue.reportProgress(playback.progressMs / 1000, true);
    } catch (err) {
      this.log(`[spotify-connect] falha ao consultar estado do player: ${errorMessage(err)}`);
    } finally {
      this.spotifyPollInFlight = false;
    }
  }

  get autoDjEnabled(): boolean {
    return this._autoDjEnabled;
  }

  setAutoDjEnabled(enabled: boolean): boolean {
    this._autoDjEnabled = enabled;
    this.settings?.set('autoDjEnabled', enabled);
    return this._autoDjEnabled;
  }

  /** Enqueues a random cached track when Auto-DJ is enabled and playback just drained the queue. */
  maybeEnqueueAutoDj(random?: () => number): Track | null {
    if (!this._autoDjEnabled) return null;
    if (this._playbackOutput.type === 'spotify' && this.consecutiveSpotifyMisses >= 5) return null;
    const { nowPlaying, queue: queued } = this.queue.state();
    if (nowPlaying || queued.length > 0) return null;

    const cached = this.tracks
      .listCached()
      .filter((t) => this._playbackOutput.type !== 'spotify' || !this.spotifyUnavailableTrackIds.has(t.id));
    if (cached.length === 0) return null;

    const recentIds = this.queue.recentTrackIds(DEFAULT_AUTO_DJ_RECENT_WINDOW * 3);
    const picked = pickAutoDjTrack(cached, recentIds, {
      recentWindow: DEFAULT_AUTO_DJ_RECENT_WINDOW,
      random,
    });
    if (!picked) return null;

    try {
      this.queue.enqueue(picked.id, 'auto-dj', 'Auto-DJ');
      this.log(`[auto-dj] enfileirada: ${picked.title}${picked.artist ? ` — ${picked.artist}` : ''}`);
      return picked;
    } catch (err) {
      this.log(`[auto-dj] falha ao enfileirar faixa: ${errorMessage(err)}`);
      return null;
    }
  }

  /** Marks results that are already in the local library so the UI can flag them as instant. */
  private annotate(results: SearchResult[]): SearchResult[] {
    return results.map((r) => {
      const track = this.tracks.findBySource(r.source, r.sourceId);
      return track ? { ...r, trackId: track.id, cached: this.tracks.isCached(track) } : r;
    });
  }

  private libraryResults(query: string): SearchResult[] {
    return this.tracks.searchLibrary(query).map((t) => this.trackToResult(t));
  }

  trackToResult(t: Track): SearchResult {
    return {
      source: t.source,
      sourceId: t.sourceId,
      title: t.title,
      artist: t.artist,
      album: t.album,
      genre: t.genre,
      year: t.year,
      trackNumber: t.trackNumber,
      durationSec: t.durationSec,
      thumbnail: t.thumbnail,
      spotifyUri: t.spotifyUri,
      trackId: t.id,
      cached: this.tracks.isCached(t),
    };
  }

  async search(rawQuery: string, source: SearchSource = 'all'): Promise<SearchResponse> {
    const query = rawQuery.trim();
    const errors: SearchResponse['errors'] = {};
    if (!query) return { results: source === 'local' || source === 'all' ? this.libraryResults('') : [], errors };

    // Pasted links are resolved directly regardless of the selected tab.
    const parsed = parseInput(query);
    if (parsed.kind !== 'query') {
      try {
        return { results: this.annotate(await this.resolveLink(parsed)), errors };
      } catch (err) {
        const key: TrackSource = parsed.kind.startsWith('spotify') ? 'spotify' : 'youtube';
        return { results: [], errors: { [key]: errorMessage(err) } };
      }
    }

    const tasks: Promise<SearchResult[]>[] = [];
    const sources: TrackSource[] = [];
    if (source === 'all' || source === 'local') {
      tasks.push(Promise.resolve(this.libraryResults(query)));
      sources.push('local');
    }
    if (source === 'all' || source === 'youtube') {
      tasks.push(this.media.search(query, 10));
      sources.push('youtube');
    }
    if ((source === 'all' && this.spotify.configured) || source === 'spotify') {
      tasks.push(this.spotify.search(query, 10));
      sources.push('spotify');
    }

    const settled = await Promise.allSettled(tasks);
    const results: SearchResult[] = [];
    const seen = new Set<string>();
    settled.forEach((outcome, i) => {
      if (outcome.status === 'rejected') {
        errors[sources[i]] = errorMessage(outcome.reason);
        return;
      }
      for (const r of outcome.value) {
        const key = `${r.source}:${r.sourceId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(r);
      }
    });
    return { results: this.annotate(results), errors };
  }

  private async resolveLink(parsed: Exclude<ReturnType<typeof parseInput>, { kind: 'query' }>): Promise<SearchResult[]> {
    switch (parsed.kind) {
      case 'youtube': {
        const cached = this.tracks.findBySource('youtube', parsed.videoId);
        if (cached) return [this.trackToResult(cached)];
        return [await this.media.getVideo(parsed.videoId)];
      }
      case 'youtube-playlist':
        return this.media.getPlaylist(parsed.url, MAX_BATCH);
      case 'spotify-track': {
        const cached = this.tracks.findBySource('spotify', parsed.id);
        if (cached) return [this.trackToResult(cached)];
        return [await this.spotify.getTrack(parsed.id)];
      }
      case 'spotify-album':
        return this.spotify.getAlbumTracks(parsed.id, MAX_BATCH);
      case 'spotify-playlist':
        return this.spotify.getPlaylistTracks(parsed.id, MAX_BATCH);
    }
  }

  /** Resolves the YouTube video for a Spotify track (spotDL-style "artist - title audio" match). */
  async resolveYoutubeId(track: Track): Promise<string | null> {
    const [best] = await this.media.search(youtubeQueryFor(track), 1);
    return best?.sourceId ?? null;
  }

  enqueue({ result: input, requesterId, requesterName, syncSpotify = true }: EnqueueRequest) {
    const result = sanitizeResult(input);
    if (!result) throw new QueueError('Faixa inválida');
    if (!requesterId) throw new QueueError('clientId obrigatório');

    let track: Track | null = result.trackId ? this.tracks.get(result.trackId) : null;
    if (!track) {
      if (result.source === 'local') throw new QueueError('Faixa local não encontrada', 404);
      track = this.tracks.upsertFromResult(result);
    }
    const cached = this.downloads.ensure(track.id);
    const outcome = this.queue.enqueue(track.id, requesterId, requesterName);
    if (!outcome.duplicate && syncSpotify) void this.syncToSpotify(this.tracks.get(track.id)!);
    return { ...outcome, cached };
  }

  /** Best-effort: mirror enqueued songs into the shared Spotify playlist. */
  async syncToSpotify(track: Track): Promise<void> {
    if (!this.spotify.connected) return;
    try {
      let uri = track.spotifyUri;
      if (!uri) {
        const [match] = await this.spotify.search(`${track.title} ${track.artist}`.trim(), 1);
        uri = match?.spotifyUri ?? null;
      }
      if (uri) await this.spotify.addToPlaylist([uri]);
    } catch (err) {
      this.log(`[spotify] falha ao sincronizar playlist: ${errorMessage(err)}`);
    }
  }

  /** Imports songs added to the shared playlist from the Spotify app into the jukebox queue. */
  async importFromSpotify(): Promise<number> {
    const fresh = await this.spotify.fetchNewPlaylistTracks();
    let imported = 0;
    for (const result of fresh) {
      // The track already lives in the shared playlist: don't mirror it back (would duplicate it).
      try {
        this.enqueue({ result, requesterId: 'spotify', requesterName: 'Spotify', syncSpotify: false });
        imported++;
      } catch (err) {
        this.log(`[spotify] faixa ignorada na importação (${result.title}): ${errorMessage(err)}`);
      }
    }
    return imported;
  }

  startSpotifyImport(intervalSec: number): void {
    if (intervalSec <= 0 || !this.spotify.configured) return;
    this.importTimer = setInterval(() => {
      if (!this.spotify.connected || !this.spotify.playlistId) return;
      this.importFromSpotify()
        .then((n) => n > 0 && this.log(`[spotify] ${n} faixa(s) importada(s) da playlist compartilhada`))
        .catch((err) => this.log(`[spotify] falha ao importar playlist: ${errorMessage(err)}`));
    }, intervalSec * 1000);
    this.importTimer.unref();
  }

  stop(): void {
    if (this.importTimer) clearInterval(this.importTimer);
    this.stopSpotifyPolling();
  }
}
