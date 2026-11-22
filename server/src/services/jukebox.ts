import type { Settings } from '../db.js';
import { DEFAULT_AUTO_DJ_RECENT_WINDOW, pickAutoDjTrack } from '../lib/autoDj.js';
import { parseInput } from '../lib/parseInput.js';
import { sanitizeResult } from '../lib/validate.js';
import type { SearchResult, Track, TrackSource } from '../types.js';
import type { DownloadManager } from './downloads.js';
import type { LyricsService } from './lyrics.js';
import { QueueError, type QueueService } from './queue.js';
import { youtubeQueryFor, type SpotifyService } from './spotify.js';
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

const MAX_BATCH = 50;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Orchestrates search, cache, downloads, queue and the Spotify shared playlist. */
export class Jukebox {
  private importTimer: NodeJS.Timeout | null = null;
  private _autoDjEnabled: boolean;

  constructor(
    readonly tracks: TrackRepository,
    readonly queue: QueueService,
    readonly downloads: DownloadManager,
    readonly media: MediaProvider,
    readonly spotify: SpotifyService,
    readonly lyrics: LyricsService,
    private readonly log: (msg: string) => void = console.log,
    private readonly settings?: Settings,
  ) {
    this._autoDjEnabled = this.settings?.get<boolean>('autoDjEnabled') ?? false;
    downloads.on('ready', () => queue.advanceIfIdle());
    queue.on('drained', () => {
      this.maybeEnqueueAutoDj();
    });
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
    const { nowPlaying, queue: queued } = this.queue.state();
    if (nowPlaying || queued.length > 0) return null;

    const cached = this.tracks.listCached();
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
  }
}
