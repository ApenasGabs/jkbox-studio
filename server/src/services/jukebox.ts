import { EventEmitter } from 'node:events';
import type { Settings } from '../db.js';
import { DEFAULT_AUTO_DJ_RECENT_WINDOW, pickAutoDjTrack } from '../lib/autoDj.js';
import { parseInput } from '../lib/parseInput.js';
import { sanitizeResult } from '../lib/validate.js';
import type {
  AutoDjConfig,
  AutoDjMode,
  PlaybackOutput,
  PlaylistImportResult,
  PlaylistSource,
  QueueEntryView,
  SearchResult,
  SpotifyDevice,
  SpotifyPlaybackState,
  Track,
  TrackSource,
} from '../types.js';
import { isCanonicalCategory, type AutocategorizeSummary, type ClassifierService } from './classifier.js';
import type { DiscoveryService } from './discovery.js';
import type { DownloadManager } from './downloads.js';
import type { LyricsService } from './lyrics.js';
import { PlaylistError, type PlaylistRepository } from './playlists.js';
import { QueueError, type QueueService } from './queue.js';
import {
  pickYoutubeVideoCandidate,
  stripTitleBrackets,
  youtubeQueryFor,
  youtubeVideoQueryFor,
} from '../lib/youtubeMatch.js';
import { SpotifyError, type SpotifyService } from './spotify.js';
import type { TrackRepository } from './tracks.js';
import type { ExtractedPlaylist, MediaProvider } from './ytdlp.js';

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
const PLAYLIST_NOT_FOUND_RE = /private|privad|does not exist|not exist|not found|404|unavailable|inacess|incomplete/i;

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
  private suppressedSpotifyUri: string | null = null;
  private spotifyStartedAtMs = 0;
  private spotifySeenPlaying = false;
  private spotifyLastProgressMs = 0;
  private consecutiveSpotifyMisses = 0;
  private _autoDjEnabled: boolean;
  private _autoDjMode: AutoDjMode;
  private _autoDjCategory: string | null;
  private _autoDjSubgenre: string | null;
  private _autoDjPlaylistId: string | null;
  private _playbackOutput: PlaybackOutput;
  private autocategorizeInFlight: Promise<AutocategorizeSummary> | null = null;
  private readonly classifyingTrackIds = new Set<string>();
  private readonly pendingClassifications = new Set<Promise<void>>();

  constructor(
    readonly tracks: TrackRepository,
    readonly queue: QueueService,
    readonly downloads: DownloadManager,
    readonly media: MediaProvider,
    readonly spotify: SpotifyService,
    readonly lyrics: LyricsService,
    private readonly log: (msg: string) => void = console.log,
    readonly settings?: Settings,
    readonly classifier?: ClassifierService,
    readonly playlists?: PlaylistRepository,
    public discovery?: DiscoveryService,
  ) {
    super();
    this._autoDjEnabled = this.settings?.get<boolean>('autoDjEnabled') ?? false;
    const savedMode = this.settings?.get<string>('autoDjMode');
    this._autoDjMode =
      savedMode === 'category' || savedMode === 'playlist' || savedMode === 'random' ? savedMode : 'vibe';
    this._autoDjCategory = this.settings?.get<string | null>('autoDjCategory') ?? null;
    this._autoDjSubgenre = this.settings?.get<string | null>('autoDjSubgenre') ?? null;
    this._autoDjPlaylistId = this.settings?.get<string | null>('autoDjPlaylistId') ?? null;
    if (this._autoDjMode === 'playlist' && this._autoDjPlaylistId && this.playlists && !this.playlists.get(this._autoDjPlaylistId)) {
      this._autoDjMode = 'vibe';
      this._autoDjPlaylistId = null;
      this.settings?.set('autoDjMode', 'vibe');
      this.settings?.set('autoDjPlaylistId', null);
    }
    this._playbackOutput = normalizePlaybackOutput(this.settings?.get<unknown>('playback_output'), spotify.connected);
    queue.setPlayablePredicate((track) => track.status === 'ready' || this._playbackOutput.type === 'spotify');
    downloads.on('ready', (track) => {
      queue.advanceIfIdle();
      void this.classifyTrackInBackground(track.id);
    });
    queue.on('started', (entry) => {
      if (this._playbackOutput.type === 'spotify') {
        if (this.activeSpotifyTrackUri) {
          this.suppressedSpotifyUri = this.activeSpotifyTrackUri;
        }
        this.resetSpotifyActiveState();
        void this.playCurrentOnSpotify(entry);
        this.ensureCurrentVideoForSpotify(entry.trackId);
      }
    });
    queue.on('ended', (entry) => {
      const latest = this.tracks.get(entry.trackId);
      if (!latest || this.tracks.isCached(latest)) return;
      try {
        this.downloads.ensure(latest.id);
      } catch (err) {
        this.log(`[downloads] falha ao baixar faixa finalizada (${latest.title}): ${errorMessage(err)}`);
      }
    });
    queue.on('drained', () => {
      const autoAdded = this.maybeEnqueueAutoDj();
      if (!autoAdded && this._playbackOutput.type === 'spotify') {
        if (this.activeSpotifyTrackUri) {
          this.suppressedSpotifyUri = this.activeSpotifyTrackUri;
        }
        this.resetSpotifyActiveState();
        this.startSpotifyPolling();
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

  private ensureCurrentVideoForSpotify(trackId: string): void {
    if (this._playbackOutput.type !== 'spotify') return;
    void this.downloads.ensureVideo(trackId).catch((err) => {
      this.log(`[video] falha ao preparar vídeo no modo Spotify Connect: ${errorMessage(err)}`);
    });
  }

  private commitSpotifyOutput(device: Pick<SpotifyDevice, 'id' | 'name'>): void {
    this._playbackOutput = { type: 'spotify', deviceId: device.id, deviceName: device.name };
    this.settings?.set('playback_output', this._playbackOutput);
    this.suppressedSpotifyUri = null;
    this.consecutiveSpotifyMisses = 0;
    const current = this.queue.state().nowPlaying;
    if (current) {
      this.ensureCurrentVideoForSpotify(current.item.trackId);
    }
    this.emit('output', this._playbackOutput);
    this.queue.emit('change');
  }

  private resetSpotifyActiveState(): void {
    this.activeSpotifyQueueId = null;
    this.activeSpotifyTrackUri = null;
    this.spotifySeenPlaying = false;
  }

  private resetToLocalOutput(pauseDeviceId?: string): PlaybackOutput {
    this.outputGen += 1;
    this.spotifyPlaySeq += 1;
    this.stopSpotifyPolling();
    this._playbackOutput = { type: 'local' };
    this.settings?.set('playback_output', this._playbackOutput);
    this.resetSpotifyActiveState();
    this.suppressedSpotifyUri = null;
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
    this.suppressedSpotifyUri = null;
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
      if (!this.queue.state().nowPlaying) {
        this.startSpotifyPolling();
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
    if (!current) {
      this.startSpotifyPolling();
      return;
    }
    this.ensureCurrentVideoForSpotify(current.item.trackId);
    if (this.activeSpotifyQueueId === current.item.id) return;
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
    const cleanedTitle = stripTitleBrackets(track.title);
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

  private adoptSpotifyTrack(playback: SpotifyPlaybackState): void {
    if (this._playbackOutput.type !== 'spotify' || this._autoDjEnabled) return;
    if (!playback.isPlaying || !playback.track) return;
    if (playback.device?.id && playback.device.id !== this._playbackOutput.deviceId) return;
    const uri = playback.trackUri ?? playback.track.spotifyUri ?? `spotify:track:${playback.track.sourceId}`;
    if (this.suppressedSpotifyUri && uri === this.suppressedSpotifyUri) return;
    const { nowPlaying, queue: queued } = this.queue.state();
    if (nowPlaying || queued.length > 0) return;

    const track = this.tracks.upsertFromResult(playback.track);
    if (!track.spotifyUri && uri) {
      this.tracks.update(track.id, { spotifyUri: uri });
    }
    const adopted = this.queue.adoptPlaying(track.id, 'spotify-autoplay', 'Spotify Auto-DJ', playback.progressMs / 1000);
    if (!adopted) return;

    this.suppressedSpotifyUri = null;
    this.activeSpotifyQueueId = adopted.id;
    this.activeSpotifyTrackUri = uri;
    this.spotifyStartedAtMs = Date.now();
    this.spotifySeenPlaying = true;
    this.spotifyLastProgressMs = playback.progressMs;
    this.ensureCurrentVideoForSpotify(track.id);
  }

  private finishActiveSpotifyTrack(queueId: number): void {
    this.resetSpotifyActiveState();
    this.queue.ended(queueId);
  }

  async pollSpotifyPlayback(): Promise<void> {
    if (this.spotifyPollInFlight) return;
    if (this._playbackOutput.type !== 'spotify') {
      this.stopSpotifyPolling();
      return;
    }

    const current = this.queue.state().nowPlaying;
    if (current && (current.item.id !== this.activeSpotifyQueueId || !this.activeSpotifyTrackUri)) {
      return;
    }

    const seq = this.spotifyPlaySeq;
    const gen = this.outputGen;
    const deviceId = this._playbackOutput.deviceId;
    const expectedQueueId = current?.item.id ?? null;
    this.spotifyPollInFlight = true;
    try {
      const playback = await this.spotify.getPlaybackState();
      if (
        seq !== this.spotifyPlaySeq ||
        gen !== this.outputGen ||
        this._playbackOutput.type !== 'spotify' ||
        this._playbackOutput.deviceId !== deviceId ||
        (this.queue.state().nowPlaying?.item.id ?? null) !== expectedQueueId
      ) {
        return;
      }

      if (!current) {
        const matchesSelectedDevice = !playback?.device?.id || playback.device.id === this._playbackOutput.deviceId;
        if (matchesSelectedDevice && playback?.trackUri && playback.trackUri !== this.suppressedSpotifyUri) {
          this.suppressedSpotifyUri = null;
        }
        if (playback) {
          this.adoptSpotifyTrack(playback);
        }
        return;
      }

      const inGrace = !this.spotifySeenPlaying && Date.now() - this.spotifyStartedAtMs < SPOTIFY_START_GRACE_MS;

      if (!playback) {
        if (inGrace) return;
        if (this.spotifySeenPlaying) {
          this.finishActiveSpotifyTrack(current.item.id);
        }
        return;
      }

      if (playback.trackUri && playback.trackUri !== this.activeSpotifyTrackUri) {
        if (inGrace) return;
        if (this.spotifySeenPlaying) {
          this.finishActiveSpotifyTrack(current.item.id);
          if (!this.queue.state().nowPlaying && playback.isPlaying && playback.track) {
            this.adoptSpotifyTrack(playback);
          }
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
        this.finishActiveSpotifyTrack(current.item.id);
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

  get autoDjMode(): AutoDjMode {
    return this._autoDjMode;
  }

  get autoDjCategory(): string | null {
    return this._autoDjCategory;
  }

  get autoDjSubgenre(): string | null {
    return this._autoDjSubgenre;
  }

  get autoDjPlaylistId(): string | null {
    return this._autoDjPlaylistId;
  }

  setAutoDjEnabled(enabled: boolean): boolean {
    this._autoDjEnabled = enabled;
    this.settings?.set('autoDjEnabled', enabled);
    return this._autoDjEnabled;
  }

  setAutoDjConfig(patch: {
    enabled?: boolean;
    mode?: AutoDjMode;
    category?: string | null;
    subgenre?: string | null;
    playlistId?: string | null;
  }): AutoDjConfig {
    if (patch.enabled !== undefined) {
      this._autoDjEnabled = patch.enabled;
      this.settings?.set('autoDjEnabled', this._autoDjEnabled);
    }
    if (patch.mode !== undefined) {
      this._autoDjMode = patch.mode;
      this.settings?.set('autoDjMode', this._autoDjMode);
    }
    if (patch.category !== undefined) {
      const nextCategory = patch.category?.trim() || null;
      const categoryChanged = nextCategory !== this._autoDjCategory;
      this._autoDjCategory = nextCategory;
      this.settings?.set('autoDjCategory', this._autoDjCategory);
      if (patch.subgenre === undefined && (categoryChanged || !nextCategory)) {
        this._autoDjSubgenre = null;
        this.settings?.set('autoDjSubgenre', null);
      }
    }
    if (patch.subgenre !== undefined) {
      this._autoDjSubgenre = patch.subgenre?.trim() || null;
      this.settings?.set('autoDjSubgenre', this._autoDjSubgenre);
    }
    if (patch.playlistId !== undefined) {
      this._autoDjPlaylistId = patch.playlistId?.trim() || null;
      this.settings?.set('autoDjPlaylistId', this._autoDjPlaylistId);
    }
    return {
      enabled: this._autoDjEnabled,
      mode: this._autoDjMode,
      category: this._autoDjCategory,
      subgenre: this._autoDjSubgenre,
      playlistId: this._autoDjPlaylistId,
    };
  }

  clearAutoDjPlaylistIfMatches(playlistId: string): void {
    if (this._autoDjPlaylistId !== playlistId) return;
    this._autoDjPlaylistId = null;
    this.settings?.set('autoDjPlaylistId', null);
    if (this._autoDjMode === 'playlist') {
      this._autoDjMode = 'vibe';
      this.settings?.set('autoDjMode', 'vibe');
    }
  }

  private hasActiveTrack(trackIds: ReadonlySet<string>): boolean {
    const { nowPlaying, queue: queued } = this.queue.state();
    if (nowPlaying && trackIds.has(nowPlaying.item.trackId)) return true;
    return queued.some((entry) => trackIds.has(entry.trackId));
  }

  async classifyTrackInBackground(trackId: string): Promise<void> {
    if (!this.classifier || this.classifyingTrackIds.has(trackId)) return;
    const track = this.tracks.get(trackId);
    if (!track || track.genreManual) return;
    if (isCanonicalCategory(track.genre) && track.subgenre?.trim()) return;
    this.classifyingTrackIds.add(trackId);
    try {
      const res = await this.classifier.classifyTrack(track);
      if (res.updated && this.hasActiveTrack(new Set([trackId]))) {
        this.queue.emit('change');
      }
    } catch (err) {
      this.log(`[classifier] falha em segundo plano (${track.title}): ${errorMessage(err)}`);
    } finally {
      this.classifyingTrackIds.delete(trackId);
    }
  }

  private scheduleBatchClassification(trackIds: string[]): void {
    if (!this.classifier || trackIds.length === 0) return;
    const ids = [...new Set(trackIds)];
    const task = (async () => {
      for (const id of ids) {
        await this.classifyTrackInBackground(id);
      }
    })();
    this.pendingClassifications.add(task);
    void task.finally(() => {
      this.pendingClassifications.delete(task);
    });
  }

  /** Resolves once any background track classification tasks triggered by imports have settled. */
  async classificationIdle(): Promise<void> {
    while (this.pendingClassifications.size > 0) {
      await Promise.all([...this.pendingClassifications]);
    }
  }

  async autocategorizeLibrary(): Promise<AutocategorizeSummary> {
    if (!this.classifier) {
      return { processed: 0, updated: 0, skippedManual: 0, failed: 0, updatedTrackIds: [] };
    }
    if (this.autocategorizeInFlight) {
      return this.autocategorizeInFlight;
    }
    const run = (async () => {
      const summary = await this.classifier!.autocategorizeAll();
      if (summary.updatedTrackIds.length > 0 && this.hasActiveTrack(new Set(summary.updatedTrackIds))) {
        this.queue.emit('change');
      }
      return summary;
    })();
    this.autocategorizeInFlight = run;
    try {
      return await run;
    } finally {
      if (this.autocategorizeInFlight === run) {
        this.autocategorizeInFlight = null;
      }
    }
  }

  /** Enqueues a cached track when Auto-DJ is enabled and playback just drained the queue. */
  maybeEnqueueAutoDj(random?: () => number): Track | null {
    if (!this._autoDjEnabled) return null;
    if (this._playbackOutput.type === 'spotify' && this.consecutiveSpotifyMisses >= 5) return null;
    const { nowPlaying, queue: queued } = this.queue.state();
    if (nowPlaying || queued.length > 0) return null;

    const cached = this.tracks
      .listCached()
      .filter((t) => this._playbackOutput.type !== 'spotify' || !this.spotifyUnavailableTrackIds.has(t.id));
    if (cached.length === 0) return null;

    const recentTracks = this.queue.recentTracks(DEFAULT_AUTO_DJ_RECENT_WINDOW * 3);
    const recentIds = recentTracks.map((t) => t.id);
    const playlistTrackIds =
      this._autoDjMode === 'playlist' && this._autoDjPlaylistId && this.playlists
        ? this.playlists.getTrackIds(this._autoDjPlaylistId)
        : undefined;
    const picked = pickAutoDjTrack(cached, recentIds, {
      recentWindow: DEFAULT_AUTO_DJ_RECENT_WINDOW,
      random,
      mode: this._autoDjMode,
      lastTrack: recentTracks[0] ?? null,
      category: this._autoDjCategory,
      subgenre: this._autoDjSubgenre,
      playlistTrackIds,
    });
    if (!picked) return null;

    try {
      this.queue.enqueue(picked.id, 'auto-dj', 'Auto-DJ');
      this.log(`[auto-dj:${this._autoDjMode}] enfileirada: ${picked.title}${picked.artist ? ` — ${picked.artist}` : ''}`);
      return picked;
    } catch (err) {
      this.log(`[auto-dj] falha ao enfileirar faixa: ${errorMessage(err)}`);
      return null;
    }
  }

  /** Marks results that are already in the local library so the UI can flag them as instant and display saved genres. */
  private annotate(results: SearchResult[]): SearchResult[] {
    return results.map((r) => {
      const track = this.tracks.findBySource(r.source, r.sourceId);
      if (!track) return r;
      return {
        ...r,
        title: track.title || r.title,
        artist: track.artist || r.artist,
        album: track.album ?? r.album ?? null,
        genre: track.genre,
        subgenre: track.subgenre,
        year: track.year ?? r.year ?? null,
        trackNumber: track.trackNumber ?? r.trackNumber ?? null,
        trackId: track.id,
        cached: this.tracks.isCached(track),
      };
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
      subgenre: t.subgenre,
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

  /**
   * Resolves the YouTube video for a Spotify track, prioritizing an official music video
   * with compatible duration and falling back to spotDL-style audio matching.
   */
  async resolveYoutubeId(track: Track): Promise<string | null> {
    try {
      const candidates = await this.media.search(youtubeVideoQueryFor(track), 5);
      const videoMatch = pickYoutubeVideoCandidate(candidates, track);
      if (videoMatch) return videoMatch.sourceId;
    } catch (err) {
      this.log(`[youtube] falha na busca de clipe para "${track.title}": ${errorMessage(err)}`);
    }
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
    void this.classifyTrackInBackground(track.id);
    const outcome = this.queue.enqueue(track.id, requesterId, requesterName);
    if (!outcome.duplicate && syncSpotify) void this.syncToSpotify(this.tracks.get(track.id)!);
    return { ...outcome, cached };
  }

  enqueuePlaylist(
    playlistId: string,
    options: { requesterId?: string; requesterName?: string; shuffle?: boolean; count?: number } = {},
  ) {
    if (!this.playlists) throw new PlaylistError('Serviço de playlists indisponível', 500);
    const detail = this.playlists.getDetail(playlistId);
    if (!detail) throw new PlaylistError('Playlist não encontrada', 404);

    const requesterId = options.requesterId?.trim() || 'playlist';
    const requesterName = options.requesterName?.trim() || detail.summary.name;

    const items = [...detail.items];
    if (options.shuffle) {
      for (let i = items.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
    }
    const selected =
      typeof options.count === 'number' && options.count > 0 ? items.slice(0, options.count) : items;

    let enqueued = 0;
    let duplicates = 0;
    const queuedItems: QueueEntryView[] = [];
    const tracksToSync: Track[] = [];
    for (const entry of selected) {
      const outcome = this.enqueue({
        result: this.trackToResult(entry.track),
        requesterId,
        requesterName,
        syncSpotify: false,
      });
      if (outcome.duplicate) duplicates += 1;
      else {
        enqueued += 1;
        const freshTrack = this.tracks.get(entry.track.id);
        if (freshTrack) tracksToSync.push(freshTrack);
      }
      queuedItems.push(outcome.item);
    }

    if (tracksToSync.length > 0 && this.spotify.connected) {
      void this.syncBatchToSpotify(tracksToSync);
    }

    return {
      playlistId: detail.summary.id,
      playlistName: detail.summary.name,
      total: selected.length,
      enqueued,
      duplicates,
      items: queuedItems,
    };
  }

  /** Mirrors a batch of newly queued tracks (e.g. from discovery) to the shared Spotify playlist. */
  syncQueuedBatch(tracks: Track[]): void {
    if (tracks.length > 0 && this.spotify.connected) {
      void this.syncBatchToSpotify(tracks);
    }
  }

  private async extractYoutubePlaylist(playlistId: string): Promise<ExtractedPlaylist> {
    const canonicalUrl = `https://www.youtube.com/playlist?list=${playlistId}`;
    try {
      if (this.media.getPlaylistDetails) {
        return await this.media.getPlaylistDetails(canonicalUrl, MAX_BATCH);
      }
      const tracks = await this.media.getPlaylist(canonicalUrl, MAX_BATCH + 1);
      return {
        title: `Playlist YouTube (${playlistId})`,
        description: null,
        thumbnail: tracks[0]?.thumbnail ?? null,
        totalCount: tracks.length,
        tracks,
      };
    } catch (err) {
      const msg = errorMessage(err);
      if (PLAYLIST_NOT_FOUND_RE.test(msg)) {
        throw new PlaylistError('Playlist do YouTube não encontrada, privada ou inacessível', 404);
      }
      throw new PlaylistError(`Falha ao ler playlist do YouTube: ${msg}`, 502);
    }
  }

  private async extractSpotifyPlaylist(playlistId: string): Promise<ExtractedPlaylist> {
    try {
      return await this.spotify.getPlaylistDetails(playlistId, MAX_BATCH);
    } catch (err) {
      if (
        err instanceof SpotifyError &&
        (err.status === 404 || (err.status === 403 && err.code !== 'INSUFFICIENT_SCOPE'))
      ) {
        throw new PlaylistError('Playlist do Spotify não encontrada, privada ou inacessível', 404);
      }
      throw err;
    }
  }

  /**
   * Imports a YouTube or Spotify playlist by URL:
   * persists tracks + playlist idempotently by `(source, sourceId)`,
   * enqueues tracks with deduplication, triggers video-first background downloads,
   * and runs background auto-categorization without overwriting manual genres.
   */
  async importPlaylist(input: {
    url: unknown;
    requesterId?: string;
    requesterName?: string;
    enqueue?: unknown;
  }): Promise<PlaylistImportResult> {
    if (!this.playlists) throw new PlaylistError('Serviço de playlists indisponível', 500);
    if (typeof input.url !== 'string' || !input.url.trim()) {
      throw new PlaylistError('Informe a URL da playlist do YouTube ou Spotify', 400);
    }
    if (input.enqueue !== undefined && typeof input.enqueue !== 'boolean') {
      throw new PlaylistError('enqueue deve ser booleano', 400);
    }
    const shouldEnqueue = input.enqueue ?? true;

    const parsed = parseInput(input.url);
    if (parsed.kind !== 'youtube-playlist' && parsed.kind !== 'spotify-playlist') {
      throw new PlaylistError('URL inválida ou não suportada. Cole um link de playlist do YouTube ou Spotify.', 400);
    }

    const source: PlaylistSource = parsed.kind === 'youtube-playlist' ? 'youtube' : 'spotify';
    const sourceId = parsed.kind === 'youtube-playlist' ? parsed.playlistId : parsed.id;
    const extracted =
      parsed.kind === 'youtube-playlist'
        ? await this.extractYoutubePlaylist(parsed.playlistId)
        : await this.extractSpotifyPlaylist(parsed.id);

    const totalRemote = extracted.totalCount ?? extracted.tracks.length;
    if (totalRemote > MAX_BATCH || extracted.tracks.length > MAX_BATCH) {
      throw new PlaylistError(`A playlist ultrapassa o limite máximo de ${MAX_BATCH} faixas por importação`, 422);
    }

    const validResults: SearchResult[] = [];
    const seenKeys = new Set<string>();
    let skipped = 0;
    for (const candidate of extracted.tracks) {
      const clean = sanitizeResult(candidate);
      if (!clean || /^\[(Private|Deleted) video\]$/i.test(clean.title)) {
        skipped += 1;
        continue;
      }
      const key = `${clean.source}:${clean.sourceId}`;
      if (seenKeys.has(key)) {
        skipped += 1;
        continue;
      }
      seenKeys.add(key);
      validResults.push(clean);
    }

    if (extracted.tracks.length === 0 || validResults.length === 0) {
      throw new PlaylistError('A playlist está vazia ou não possui faixas importáveis', 422);
    }

    const persistedTracks: Track[] = validResults.map((res) => {
      const track = this.tracks.upsertFromResult(res);
      const patch: Partial<Pick<Track, 'thumbnail' | 'spotifyUri' | 'durationSec' | 'album'>> = {};
      if (!track.thumbnail && res.thumbnail) patch.thumbnail = res.thumbnail;
      if (!track.spotifyUri && res.spotifyUri) patch.spotifyUri = res.spotifyUri;
      if (track.durationSec === null && res.durationSec != null) patch.durationSec = res.durationSec;
      if (!track.album && res.album) patch.album = res.album;
      if (Object.keys(patch).length > 0) {
        this.tracks.update(track.id, patch);
        return this.tracks.get(track.id)!;
      }
      return track;
    });

    const { playlist, created } = this.playlists.upsertImported({
      source,
      sourceId,
      name: extracted.title,
      description: extracted.description ?? null,
      thumbnail: extracted.thumbnail ?? persistedTracks.find((t) => t.thumbnail)?.thumbnail ?? null,
      trackIds: persistedTracks.map((t) => t.id),
    });

    const requesterId = input.requesterId?.trim() || 'playlist-import';
    const requesterName = input.requesterName?.trim() || playlist.name;
    let alreadyCached = 0;
    let downloading = 0;
    let queued = 0;

    for (const track of persistedTracks) {
      const cached = this.downloads.ensure(track.id);
      if (cached) alreadyCached += 1;
      else downloading += 1;

      if (shouldEnqueue) {
        const outcome = this.queue.enqueue(track.id, requesterId, requesterName);
        if (outcome.duplicate) skipped += 1;
        else queued += 1;
      }
    }

    this.scheduleBatchClassification(persistedTracks.map((t) => t.id));

    const detail = this.playlists.getDetail(playlist.id)!;
    return {
      playlist: detail.summary,
      created,
      imported: persistedTracks.length,
      alreadyCached,
      queued,
      downloading,
      skipped,
      tracks: detail.items.map((item) => ({
        ...this.trackToResult(item.track),
        position: item.position,
        addedAt: item.addedAt,
      })),
    };
  }

  /** Mirrors a batch of newly enqueued playlist tracks to Spotify without concurrent bursts. */
  private async syncBatchToSpotify(tracks: Track[]): Promise<void> {
    if (!this.spotify.connected || tracks.length === 0) return;
    try {
      const uris: string[] = [];
      for (const track of tracks) {
        let uri = track.spotifyUri;
        if (!uri) {
          const [match] = await this.spotify.search(`${track.title} ${track.artist}`.trim(), 1);
          uri = match?.spotifyUri ?? null;
        }
        if (uri) uris.push(uri);
      }
      if (uris.length > 0) await this.spotify.addToPlaylist(uris);
    } catch (err) {
      this.log(`[spotify] falha ao sincronizar playlist em lote: ${errorMessage(err)}`);
    }
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
