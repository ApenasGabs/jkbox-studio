import { isGospelGenre } from '../lib/autoDj.js';
import { sanitizeResult } from '../lib/validate.js';
import type {
  DiscoveryMode,
  DiscoveryPopulateResponse,
  DiscoverySeedSummary,
  DiscoverySource,
  DiscoverySuggestResponse,
  DiscoveryTarget,
  SearchResult,
  Track,
} from '../types.js';
import { type ClassifierService, isCanonicalCategory, normalizeGenreAndSubgenre } from './classifier.js';
import type { DownloadManager } from './downloads.js';
import { sanitizeTrackMetadata } from './lyrics.js';
import type { PlaylistRepository } from './playlists.js';
import type { QueueService } from './queue.js';
import type { FetchFn, SpotifyService } from './spotify.js';
import type { TrackRepository } from './tracks.js';
import type { MediaProvider } from './ytdlp.js';

const DEEZER_API = 'https://api.deezer.com';
const DEEZER_TIMEOUT_MS = 5000;
const DEFAULT_SUGGEST_LIMIT = 10;
const MAX_SUGGEST_LIMIT = 20;
const MAX_POPULATE_BATCH = 50;
const MAX_SEED_ARTISTS = 4;
const MAX_RELATED_ARTISTS_PER_SEED = 3;
const SPOTIFY_ENRICH_CONCURRENCY = 4;

export class DiscoveryError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface DiscoverySuggestInput {
  mode: DiscoveryMode;
  playlistId?: string;
  category?: string;
  subgenre?: string | null;
  limit?: number;
}

export interface DiscoveryPopulateInput {
  tracks: unknown[];
  target: DiscoveryTarget;
  playlistId?: string;
  requesterId?: string;
  requesterName?: string;
}

interface DeezerArtist {
  id: number;
  name: string;
}

interface DeezerTrack {
  id: number;
  title?: string;
  duration?: number;
  artist?: { id?: number; name?: string };
  album?: { id?: number; title?: string; cover_big?: string; cover_medium?: string; cover?: string };
}

function foldAlnum(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Normalized `artist + title` deduplication key resilient to uploader suffixes and live/remaster tags. */
export function normalizeTrackDedupeKey(artist: string, title: string): string {
  const sanitized = sanitizeTrackMetadata(title, artist);
  const cleanTitle = sanitized.title || title;
  const cleanArtist = sanitized.artist || artist;
  const strippedTitle = cleanTitle.replace(/\s*[\(\[][^\)\]]*[\)\]]\s*/g, ' ').trim() || cleanTitle;
  return `${foldAlnum(cleanArtist)}::${foldAlnum(strippedTitle)}`;
}

function primaryArtistName(rawArtist: string): string {
  const sanitized = sanitizeTrackMetadata('', rawArtist).artist || rawArtist;
  const head = sanitized.split(/\s*(?:,|\/|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b)\s*/i)[0]?.trim() ?? '';
  return head || sanitized.trim();
}

function isMatchingTrack(candidate: SearchResult, match: SearchResult): boolean {
  const candTitle = foldAlnum(candidate.title.replace(/\([^)]*\)|\[[^\]]*\]/g, ''));
  const matchTitle = foldAlnum(match.title.replace(/\([^)]*\)|\[[^\]]*\]/g, ''));
  if (!candTitle || !matchTitle) return false;
  const titleOk = candTitle === matchTitle || candTitle.includes(matchTitle) || matchTitle.includes(candTitle);
  if (!titleOk) return false;

  const candArtist = foldAlnum(primaryArtistName(candidate.artist));
  const matchArtist = foldAlnum(primaryArtistName(match.artist));
  if (!candArtist || !matchArtist) return true;
  return candArtist === matchArtist || candArtist.includes(matchArtist) || matchArtist.includes(candArtist);
}

function deezerTrackToResult(item: DeezerTrack): SearchResult | null {
  if (!item?.id || !item.title?.trim()) return null;
  const idStr = String(item.id);
  if (!/^\d{1,32}$/.test(idStr)) return null;
  const thumb = item.album?.cover_big ?? item.album?.cover_medium ?? item.album?.cover ?? null;
  return {
    source: 'deezer',
    sourceId: idStr,
    title: item.title.trim(),
    artist: item.artist?.name?.trim() ?? '',
    album: item.album?.title?.trim() || null,
    durationSec: typeof item.duration === 'number' && Number.isFinite(item.duration) && item.duration > 0 ? Math.round(item.duration) : null,
    thumbnail: thumb,
  };
}

async function mapBounded<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

interface DedupeIndex {
  sourceKeys: Set<string>;
  spotifyUris: Set<string>;
  normalizedKeys: Set<string>;
  trackIdBySource: Map<string, string>;
  trackIdBySpotifyUri: Map<string, string>;
  trackIdByNormalized: Map<string, string>;
}

function createDedupeIndex(): DedupeIndex {
  return {
    sourceKeys: new Set(),
    spotifyUris: new Set(),
    normalizedKeys: new Set(),
    trackIdBySource: new Map(),
    trackIdBySpotifyUri: new Map(),
    trackIdByNormalized: new Map(),
  };
}

function addToDedupeIndex(
  index: DedupeIndex,
  entry: { id?: string; source: string; sourceId: string; title: string; artist: string; spotifyUri?: string | null },
): void {
  const sourceKey = `${entry.source}:${entry.sourceId}`;
  index.sourceKeys.add(sourceKey);
  if (entry.id && !index.trackIdBySource.has(sourceKey)) index.trackIdBySource.set(sourceKey, entry.id);
  if (entry.spotifyUri) {
    index.spotifyUris.add(entry.spotifyUri);
    if (entry.id && !index.trackIdBySpotifyUri.has(entry.spotifyUri)) {
      index.trackIdBySpotifyUri.set(entry.spotifyUri, entry.id);
    }
  }
  const norm = normalizeTrackDedupeKey(entry.artist, entry.title);
  if (norm !== '::') {
    index.normalizedKeys.add(norm);
    if (entry.id && !index.trackIdByNormalized.has(norm)) {
      index.trackIdByNormalized.set(norm, entry.id);
    }
  }
}

function hasInDedupeIndex(index: DedupeIndex, result: SearchResult): boolean {
  if (index.sourceKeys.has(`${result.source}:${result.sourceId}`)) return true;
  if (result.spotifyUri && index.spotifyUris.has(result.spotifyUri)) return true;
  const norm = normalizeTrackDedupeKey(result.artist, result.title);
  return norm !== '::' && index.normalizedKeys.has(norm);
}

function findTrackIdInDedupeIndex(index: DedupeIndex, result: SearchResult): string | null {
  const bySource = index.trackIdBySource.get(`${result.source}:${result.sourceId}`);
  if (bySource) return bySource;
  if (result.spotifyUri) {
    const bySpotify = index.trackIdBySpotifyUri.get(result.spotifyUri);
    if (bySpotify) return bySpotify;
  }
  const norm = normalizeTrackDedupeKey(result.artist, result.title);
  if (norm !== '::') {
    const byNorm = index.trackIdByNormalized.get(norm);
    if (byNorm) return byNorm;
  }
  return null;
}

/**
 * Determines whether a playlist enforces Gospel (`true`), secular (`false`), or neutral (`null`) isolation.
 * A Gospel-named playlist or a playlist with a majority of Gospel tracks enforces Gospel-only isolation even
 * when some existing tracks are uncategorized.
 */
function resolvePlaylistGospelScope(name: string, tracks: readonly Track[]): boolean | null {
  if (isGospelGenre(name)) return true;
  const gospelCount = tracks.filter((t) => isGospelGenre(t.genre)).length;
  const nonGospelCount = tracks.filter((t) => Boolean(t.genre?.trim()) && !isGospelGenre(t.genre)).length;
  if (gospelCount > 0 && gospelCount > nonGospelCount) return true;
  if (nonGospelCount > 0 && gospelCount === 0) return false;
  return null;
}

function resolveQueueGospelScope(tracks: readonly Track[]): boolean | null {
  const gospelCount = tracks.filter((t) => isGospelGenre(t.genre)).length;
  const nonGospelCount = tracks.filter((t) => Boolean(t.genre?.trim()) && !isGospelGenre(t.genre)).length;
  if (gospelCount > 0 && gospelCount >= nonGospelCount) return true;
  if (nonGospelCount > 0 && gospelCount === 0) return false;
  return null;
}

/**
 * Cascading similar-track discovery engine:
 * 1. Deezer API (keyless: related artists + artist top tracks + track search fallback)
 * 2. Spotify Catalog Search (enriches `spotifyUri` for Spotify Connect + additional catalog search)
 * 3. `yt-dlp` YouTube fallback when Deezer/Spotify return fewer tracks than requested
 * Enforces normalized anti-duplication, strict Gospel isolation, auto-categorization and low-priority downloads.
 */
export class DiscoveryService {
  constructor(
    private readonly tracks: TrackRepository,
    private readonly queue: QueueService,
    private readonly downloads: DownloadManager,
    private readonly media: MediaProvider,
    private readonly spotify?: SpotifyService,
    private readonly classifier?: ClassifierService,
    private readonly playlists?: PlaylistRepository,
    private readonly fetchFn: FetchFn = fetch,
    private readonly log: (msg: string) => void = console.log,
    private readonly onTracksQueued?: (tracks: Track[]) => void,
  ) {}

  private async fetchDeezerJson<T>(path: string): Promise<T | null> {
    try {
      const res = await this.fetchFn(`${DEEZER_API}${path}`, {
        signal: AbortSignal.timeout(DEEZER_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch (err) {
      this.log(`[discovery] falha na Deezer API (${path}): ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async discoverFromDeezer(
    seedArtists: readonly string[],
    fallbackQuery: string,
    limit: number,
  ): Promise<{ results: SearchResult[]; used: boolean }> {
    let used = false;
    const buckets: SearchResult[][] = [];

    if (seedArtists.length > 0) {
      const artistLookups = await Promise.all(
        seedArtists.slice(0, MAX_SEED_ARTISTS).map(async (name) => {
          const searchRes = await this.fetchDeezerJson<{ data?: DeezerArtist[] }>(
            `/search/artist?${new URLSearchParams({ q: name, limit: '3' })}`,
          );
          if (searchRes) used = true;
          const items = searchRes?.data ?? [];
          if (items.length === 0) return null;
          const target = foldAlnum(name);
          return items.find((a) => foldAlnum(a.name) === target) ?? items[0];
        }),
      );

      const resolvedArtists = artistLookups.filter((a): a is DeezerArtist => a !== null);
      const relatedLists = await Promise.all(
        resolvedArtists.map(async (artist) => {
          const [relRes, ownTopRes] = await Promise.all([
            this.fetchDeezerJson<{ data?: DeezerArtist[] }>(`/artist/${artist.id}/related?limit=8`),
            this.fetchDeezerJson<{ data?: DeezerTrack[] }>(`/artist/${artist.id}/top?limit=5`),
          ]);
          if (relRes || ownTopRes) used = true;
          return {
            ownTracks: (ownTopRes?.data ?? []).map(deezerTrackToResult).filter((r): r is SearchResult => r !== null),
            relatedArtists: (relRes?.data ?? []).slice(0, MAX_RELATED_ARTISTS_PER_SEED),
          };
        }),
      );

      const seenRelatedIds = new Set<number>(resolvedArtists.map((a) => a.id));
      const uniqueRelated: DeezerArtist[] = [];
      for (const entry of relatedLists) {
        if (entry.ownTracks.length > 0) buckets.push(entry.ownTracks);
        for (const rel of entry.relatedArtists) {
          if (seenRelatedIds.has(rel.id)) continue;
          seenRelatedIds.add(rel.id);
          uniqueRelated.push(rel);
        }
      }

      const relatedTracks = await Promise.all(
        uniqueRelated.slice(0, 6).map(async (rel) => {
          const topRes = await this.fetchDeezerJson<{ data?: DeezerTrack[] }>(`/artist/${rel.id}/top?limit=5`);
          if (topRes) used = true;
          return (topRes?.data ?? []).map(deezerTrackToResult).filter((r): r is SearchResult => r !== null);
        }),
      );
      for (const list of relatedTracks) {
        if (list.length > 0) buckets.push(list);
      }
    }

    // Round-robin interleave tracks across artists so recommendations feel varied.
    const results: SearchResult[] = [];
    let round = 0;
    while (results.length < limit * 2) {
      let pushed = false;
      for (const bucket of buckets) {
        if (round < bucket.length) {
          results.push(bucket[round]);
          pushed = true;
        }
      }
      if (!pushed) break;
      round += 1;
    }

    if (results.length < limit && fallbackQuery.trim()) {
      const searchRes = await this.fetchDeezerJson<{ data?: DeezerTrack[] }>(
        `/search/track?${new URLSearchParams({ q: fallbackQuery.trim(), limit: String(Math.min(20, limit * 2)) })}`,
      );
      if (searchRes) used = true;
      for (const raw of searchRes?.data ?? []) {
        const mapped = deezerTrackToResult(raw);
        if (mapped) results.push(mapped);
      }
    }

    return { results, used };
  }

  private async classifyCandidate(candidate: SearchResult) {
    const context = {
      title: candidate.title,
      artist: candidate.artist,
      album: candidate.album,
      year: candidate.year ?? null,
    };
    const rawGenres = candidate.genre?.trim() ? [candidate.genre.trim()] : [];
    return this.classifier
      ? await this.classifier.classifyMetadata({
          ...context,
          source: candidate.source,
          sourceId: candidate.sourceId,
          rawGenres,
        })
      : normalizeGenreAndSubgenre(rawGenres, context);
  }

  private async evaluateCandidate(
    candidate: SearchResult,
    isGospelSeed: boolean,
    existing: DedupeIndex,
    accepted: DedupeIndex,
  ): Promise<SearchResult | null> {
    if (!candidate.title.trim() || !candidate.sourceId.trim()) return null;
    if (hasInDedupeIndex(existing, candidate) || hasInDedupeIndex(accepted, candidate)) return null;

    const outcome = await this.classifyCandidate(candidate);

    if (isGospelSeed) {
      // Fail closed: unknown/unclassified candidates must not leak into Gospel seeds.
      if (outcome !== null ? outcome.genre !== 'Gospel' : !isGospelGenre(candidate.genre)) return null;
    } else {
      if (outcome?.genre === 'Gospel' || isGospelGenre(candidate.genre)) return null;
    }

    return {
      ...candidate,
      genre: outcome?.genre ?? candidate.genre ?? null,
      subgenre: outcome?.subgenre ?? candidate.subgenre ?? null,
    };
  }

  private async enrichWithSpotify(candidates: SearchResult[]): Promise<{ enriched: SearchResult[]; used: boolean }> {
    if (!this.spotify?.configured || candidates.length === 0) {
      return { enriched: candidates, used: false };
    }
    let used = false;
    const enriched = await mapBounded(candidates, SPOTIFY_ENRICH_CONCURRENCY, async (item) => {
      if (item.source === 'spotify' && item.spotifyUri) return item;
      const sanitized = sanitizeTrackMetadata(item.title, item.artist);
      const q = `${sanitized.title || item.title} ${primaryArtistName(sanitized.artist || item.artist)}`.trim();
      if (!q) return item;
      try {
        const matches = await this.spotify!.search(q, 3);
        const match = matches.find((m) => Boolean(m.spotifyUri) && isMatchingTrack(item, m));
        if (!match?.spotifyUri) return item;
        used = true;
        return {
          ...item,
          source: 'spotify' as const,
          sourceId: match.sourceId,
          spotifyUri: match.spotifyUri,
          thumbnail: item.thumbnail ?? match.thumbnail ?? null,
          album: item.album ?? match.album ?? null,
          durationSec: item.durationSec ?? match.durationSec ?? null,
        };
      } catch (err) {
        this.log(`[discovery] falha ao enriquecer com Spotify (${item.title}): ${err instanceof Error ? err.message : String(err)}`);
        return item;
      }
    });
    return { enriched, used };
  }

  private resolveSeeds(input: DiscoverySuggestInput): {
    seedTracks: Track[];
    isGospelSeed: boolean;
    fallbackQuery: string;
    playlistTrackDetails: Track[];
  } {
    if (input.mode === 'playlist') {
      const playlistId = input.playlistId?.trim();
      if (!playlistId) throw new DiscoveryError('playlistId obrigatório para mode=playlist', 400);
      if (!this.playlists) throw new DiscoveryError('Serviço de playlists indisponível', 500);
      const detail = this.playlists.getDetail(playlistId);
      if (!detail) throw new DiscoveryError('Playlist não encontrada', 404);
      const seedTracks = detail.items.map((item) => item.track);
      const isGospelSeed = resolvePlaylistGospelScope(detail.summary.name, seedTracks) === true;
      return {
        seedTracks,
        isGospelSeed,
        fallbackQuery: detail.summary.name,
        playlistTrackDetails: seedTracks,
      };
    }

    if (input.mode === 'category') {
      const category = input.category?.trim();
      if (!category) throw new DiscoveryError('category obrigatório para mode=category', 400);
      const subgenre = input.subgenre?.trim() || undefined;
      const seedTracks = this.tracks.tracksByCategory(category, subgenre);
      const isGospelSeed =
        isGospelGenre(category) ||
        isGospelGenre(subgenre) ||
        (seedTracks.length > 0 && seedTracks.every((t) => isGospelGenre(t.genre)));
      return {
        seedTracks,
        isGospelSeed,
        fallbackQuery: subgenre ? `${category} ${subgenre}` : category,
        playlistTrackDetails: [],
      };
    }

    // `vibe` mode: derive from nowPlaying + queue + recently played history
    const state = this.queue.state();
    const rawSeeds: Track[] = [
      ...(state.nowPlaying ? [state.nowPlaying.item.track] : []),
      ...state.queue.map((q) => q.track),
      ...this.queue.recentTracks(10),
    ];
    const seenIds = new Set<string>();
    const uniqueSeeds = rawSeeds.filter((t) => {
      if (seenIds.has(t.id)) return false;
      seenIds.add(t.id);
      return true;
    });
    const fallbackSeeds = uniqueSeeds.length > 0 ? uniqueSeeds : this.tracks.listCached().slice(0, 5);
    const first = fallbackSeeds[0];
    const isGospelSeed = Boolean(first && isGospelGenre(first.genre));
    const filteredSeeds = fallbackSeeds.filter((t) =>
      isGospelSeed ? isGospelGenre(t.genre) : !isGospelGenre(t.genre),
    );
    const seedTracks = filteredSeeds.length > 0 ? filteredSeeds : fallbackSeeds;
    const queryParts = [seedTracks[0]?.subgenre, seedTracks[0]?.genre].filter((v): v is string => Boolean(v?.trim()));
    return {
      seedTracks,
      isGospelSeed,
      fallbackQuery: queryParts[0] ?? '',
      playlistTrackDetails: [],
    };
  }

  private buildExistingIndex(playlistTracks: readonly Track[]): DedupeIndex {
    const index = createDedupeIndex();
    for (const entry of this.tracks.listDedupeEntries()) {
      addToDedupeIndex(index, entry);
    }
    for (const track of playlistTracks) {
      addToDedupeIndex(index, track);
    }
    const state = this.queue.state();
    if (state.nowPlaying) addToDedupeIndex(index, state.nowPlaying.item.track);
    for (const item of state.queue) addToDedupeIndex(index, item.track);
    return index;
  }

  async suggest(input: DiscoverySuggestInput): Promise<DiscoverySuggestResponse> {
    if (input.mode !== 'playlist' && input.mode !== 'category' && input.mode !== 'vibe') {
      throw new DiscoveryError('mode deve ser playlist, category ou vibe', 400);
    }
    const rawLimit = input.limit ?? DEFAULT_SUGGEST_LIMIT;
    if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_SUGGEST_LIMIT) {
      throw new DiscoveryError(`limit deve ser um inteiro entre 1 e ${MAX_SUGGEST_LIMIT}`, 400);
    }
    const limit = rawLimit;

    const { seedTracks, isGospelSeed, fallbackQuery, playlistTrackDetails } = this.resolveSeeds(input);
    const existing = this.buildExistingIndex(playlistTrackDetails);
    const acceptedIndex = createDedupeIndex();
    const suggestions: SearchResult[] = [];
    const sourcesUsed = new Set<DiscoverySource>();

    const seedArtists: string[] = [];
    const seenArtistFold = new Set<string>();
    for (const track of seedTracks) {
      const sanitizedSeed = sanitizeTrackMetadata(track.title, track.artist);
      const artist = primaryArtistName(sanitizedSeed.artist || track.artist);
      const folded = foldAlnum(artist);
      if (!folded || seenArtistFold.has(folded)) continue;
      seenArtistFold.add(folded);
      seedArtists.push(artist);
    }

    const acceptBatch = async (batch: readonly SearchResult[]): Promise<number> => {
      let addedCount = 0;
      for (const candidate of batch) {
        if (suggestions.length >= limit) break;
        const accepted = await this.evaluateCandidate(candidate, isGospelSeed, existing, acceptedIndex);
        if (!accepted) continue;
        addToDedupeIndex(acceptedIndex, accepted);
        suggestions.push(accepted);
        addedCount += 1;
      }
      return addedCount;
    };

    // Stage 1: Deezer API (keyless)
    const deezerQuery = isGospelSeed && fallbackQuery && !isGospelGenre(fallbackQuery)
      ? `${fallbackQuery} gospel`
      : fallbackQuery;
    const deezer = await this.discoverFromDeezer(seedArtists, deezerQuery, limit);
    if (deezer.used) sourcesUsed.add('deezer');
    await acceptBatch(deezer.results);

    // Stage 2: Spotify Catalog Search (additional discovery if still below limit, no deprecated endpoints)
    if (this.spotify?.configured && suggestions.length < limit) {
      const queries: string[] = [];
      for (const artist of seedArtists.slice(0, 2)) {
        queries.push(isGospelSeed ? `${artist} gospel` : artist);
      }
      if (deezerQuery.trim()) queries.push(deezerQuery.trim());

      for (const q of queries) {
        if (suggestions.length >= limit) break;
        try {
          const spResults = await this.spotify.search(q, Math.min(10, limit));
          if (spResults.length > 0) sourcesUsed.add('spotify');
          await acceptBatch(spResults);
        } catch (err) {
          this.log(`[discovery] falha na busca Spotify (${q}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Stage 3: yt-dlp fallback when Deezer + Spotify didn't fill `limit`
    if (suggestions.length < limit) {
      const ytQueries: string[] = [];
      for (const artist of seedArtists.slice(0, 2)) {
        ytQueries.push(isGospelSeed ? `${artist} louvor gospel` : `${artist} musicas semelhantes`);
      }
      if (deezerQuery.trim()) {
        ytQueries.push(isGospelSeed ? `${deezerQuery.trim()} gospel` : `${deezerQuery.trim()} mix`);
      }

      for (const q of ytQueries) {
        if (suggestions.length >= limit) break;
        try {
          const ytResults = await this.media.search(q, Math.min(10, limit));
          if (ytResults.length > 0) sourcesUsed.add('youtube');
          await acceptBatch(ytResults);
        } catch (err) {
          this.log(`[discovery] falha no fallback yt-dlp (${q}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Enrich non-Spotify suggestions with Spotify URIs when Spotify is configured (preserving dedupe)
    const { enriched, used: spotifyEnriched } = await this.enrichWithSpotify(suggestions);
    if (spotifyEnriched) sourcesUsed.add('spotify');

    const finalSuggestions: SearchResult[] = [];
    const finalIndex = createDedupeIndex();
    for (const item of enriched) {
      if (hasInDedupeIndex(existing, item) || hasInDedupeIndex(finalIndex, item)) continue;
      addToDedupeIndex(finalIndex, item);
      finalSuggestions.push(item);
    }

    return {
      mode: input.mode,
      seeds: seedTracks.slice(0, 5).map((t): DiscoverySeedSummary => ({
        title: t.title,
        artist: t.artist,
        genre: t.genre,
        subgenre: t.subgenre,
      })),
      sourcesUsed: [...sourcesUsed],
      suggestions: finalSuggestions.slice(0, limit),
    };
  }

  async populate(input: DiscoveryPopulateInput): Promise<DiscoveryPopulateResponse> {
    if (input.target !== 'library' && input.target !== 'playlist' && input.target !== 'queue') {
      throw new DiscoveryError('target deve ser library, playlist ou queue', 400);
    }
    if (!Array.isArray(input.tracks) || input.tracks.length === 0) {
      throw new DiscoveryError('Selecione pelo menos uma faixa para popular', 400);
    }
    if (input.tracks.length > MAX_POPULATE_BATCH) {
      throw new DiscoveryError(`Máximo de ${MAX_POPULATE_BATCH} faixas por lote`, 400);
    }

    let playlistId: string | undefined;
    let targetGospelScope: boolean | null = null;
    const targetNormalizedKeys = new Set<string>();

    if (input.target === 'playlist') {
      playlistId = input.playlistId?.trim();
      if (!playlistId) throw new DiscoveryError('playlistId obrigatório para target=playlist', 400);
      if (!this.playlists) throw new DiscoveryError('Serviço de playlists indisponível', 500);
      const detail = this.playlists.getDetail(playlistId);
      if (!detail) throw new DiscoveryError('Playlist não encontrada', 404);
      const playlistTracks = detail.items.map((item) => item.track);
      targetGospelScope = resolvePlaylistGospelScope(detail.summary.name, playlistTracks);
      for (const track of playlistTracks) {
        const norm = normalizeTrackDedupeKey(track.artist, track.title);
        if (norm !== '::') targetNormalizedKeys.add(norm);
      }
    } else if (input.target === 'queue') {
      const state = this.queue.state();
      const activeTracks: Track[] = [
        ...(state.nowPlaying ? [state.nowPlaying.item.track] : []),
        ...state.queue.map((q) => q.track),
      ];
      targetGospelScope = resolveQueueGospelScope(activeTracks);
      for (const track of activeTracks) {
        const norm = normalizeTrackDedupeKey(track.artist, track.title);
        if (norm !== '::') targetNormalizedKeys.add(norm);
      }
    }

    const sanitized: SearchResult[] = [];
    for (const raw of input.tracks) {
      const clean = sanitizeResult(raw);
      if (clean) sanitized.push(clean);
    }
    if (sanitized.length === 0) {
      throw new DiscoveryError('Nenhuma faixa válida informada', 400);
    }

    const libraryIndex = createDedupeIndex();
    for (const entry of this.tracks.listDedupeEntries()) {
      addToDedupeIndex(libraryIndex, entry);
    }

    const requesterId = input.requesterId?.trim() || 'discovery';
    const requesterName = input.requesterName?.trim() || 'Descoberta';
    let added = 0;
    let duplicates = 0;
    let queuedDownloads = 0;
    const resultingTracks: Track[] = [];
    const queuedForSync: Track[] = [];

    for (const item of sanitized) {
      const exactTrack = this.tracks.findBySource(item.source, item.sourceId);
      const matchedId = exactTrack ? exactTrack.id : findTrackIdInDedupeIndex(libraryIndex, item);
      const existingTrack = exactTrack ?? (matchedId ? this.tracks.get(matchedId) : null);

      if (targetGospelScope !== null) {
        let itemIsGospel: boolean;
        if (existingTrack?.genre?.trim()) {
          itemIsGospel = isGospelGenre(existingTrack.genre);
        } else {
          const outcome = await this.classifyCandidate(item);
          itemIsGospel =
            outcome !== null ? outcome.genre === 'Gospel' : isGospelGenre(item.genre);
        }
        if (targetGospelScope && !itemIsGospel) continue;
        if (!targetGospelScope && itemIsGospel) continue;
      }

      const existedBefore = Boolean(existingTrack);
      let track = existingTrack ?? this.tracks.upsertFromResult(item);
      addToDedupeIndex(libraryIndex, track);

      if (
        this.classifier &&
        !track.genreManual &&
        (!isCanonicalCategory(track.genre) || !track.subgenre?.trim())
      ) {
        try {
          await this.classifier.classifyTrack(track);
          track = this.tracks.get(track.id) ?? track;
        } catch (err) {
          this.log(`[discovery] falha ao auto-categorizar "${track.title}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const normKey = normalizeTrackDedupeKey(track.artist || item.artist, track.title || item.title);
      let isDuplicate = false;

      if (input.target === 'playlist') {
        if (normKey !== '::' && targetNormalizedKeys.has(normKey)) {
          isDuplicate = true;
          duplicates += 1;
        } else {
          const res = this.playlists!.addTrack(playlistId!, track.id);
          isDuplicate = res.duplicate;
          if (res.duplicate) duplicates += 1;
          else {
            added += 1;
            if (normKey !== '::') targetNormalizedKeys.add(normKey);
          }
        }
      } else if (input.target === 'queue') {
        if (normKey !== '::' && targetNormalizedKeys.has(normKey)) {
          isDuplicate = true;
          duplicates += 1;
        } else {
          const res = this.queue.enqueue(track.id, requesterId, requesterName);
          isDuplicate = res.duplicate;
          if (res.duplicate) duplicates += 1;
          else {
            added += 1;
            queuedForSync.push(track);
            if (normKey !== '::') targetNormalizedKeys.add(normKey);
          }
        }
      } else {
        isDuplicate = existedBefore;
        if (existedBefore) duplicates += 1;
        else added += 1;
      }

      const cached = this.downloads.ensure(track.id, 'low');
      if (!cached && !isDuplicate) queuedDownloads += 1;
      resultingTracks.push(this.tracks.get(track.id) ?? track);
    }

    if (queuedForSync.length > 0 && this.onTracksQueued) {
      this.onTracksQueued(queuedForSync);
    }

    return {
      target: input.target,
      ...(playlistId ? { playlistId } : {}),
      total: sanitized.length,
      added,
      duplicates,
      queuedDownloads,
      tracks: resultingTracks,
    };
  }
}
