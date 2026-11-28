import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db.js';
import type { LyricsSource, Track, TrackLyrics } from '../types.js';
import type { FetchFn } from './spotify.js';

const LRCLIB_BASE = 'https://lrclib.net/api';
const USER_AGENT = 'jkbox-studio/0.1.0 (https://github.com/ApenasGabs/jkbox-studio)';
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_OFFSET_MS = 300_000;

const LRC_TIMESTAMP_RE = /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/;
const LRC_TIMESTAMP_GLOBAL_RE = /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/g;
const LRC_META_LINE_RE = /^\[(?:ar|ti|al|au|by|offset|length|re|ve):[^\]]*\]$/i;

const BRACKETED_NOISE_RE =
  /\s*[\(\[]\s*(?:feat\.?|ft\.?|featuring)\b[^)\]]*[\)\]]|\s*[\(\[]\s*(?:official(?:\s+(?:music\s+)?(?:video|audio|lyric\s+video|lyrics?|visualizer|hd|4k|uhd))?|music\s+video|lyric\s+video|lyrics?|audio|áudio|videoclipe(?:\s+oficial)?|clipe\s+oficial|hd|4k|uhd|hq|1080p|720p|explicit|clean|visualizer|remaster(?:ed)?(?:\s+\d{4})?|legendado|tradu[cç][aã]o(?:\s+pt(?:-?br)?)?|full\s+album)\s*[\)\]]/gi;
const PIPE_NOISE_RE = /\s*\|\s*(?:official|music\s+video|lyric\s+video|lyrics?|audio|hd|4k).*$/i;
const TRAILING_DASH_NOISE_RE =
  /\s+[-–—]\s+(?:official(?:\s+(?:music\s+)?(?:video|audio|lyric\s+video|lyrics?))?|lyric\s+video|lyrics?|audio|clipe\s+oficial)\s*$/i;
const TRAILING_FEAT_RE = /\s+(?:feat\.?|ft\.?|featuring)\s+.+$/i;

interface LyricsRow {
  track_id: string;
  synced_lrc: string | null;
  plain_lyrics: string | null;
  instrumental: number;
  source: LyricsSource;
  offset_ms: number;
  fetched_at: number;
}

export interface LrclibRecord {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

export interface LyricsEvents {
  offset: [trackId: string, offsetMs: number];
  cleared: [trackId: string];
}

/** Outcome of one background lookup: `transient` means it was not cached and will be retried later. */
export type LyricsPrefetchOutcome = 'cached' | 'found' | 'empty' | 'transient';

export interface LyricsPrefetchSummary {
  total: number;
  /** Already had a SQLite entry before the backfill started (no HTTP request). */
  alreadyCached: number;
  /** Newly cached synced/plain lyrics. */
  found: number;
  /** Newly cached as instrumental or "no lyrics found". */
  empty: number;
  /** Network/LRCLIB failures left uncached so a later run can retry. */
  transient: number;
}

export interface LyricsPrefetchOptions {
  /** Max simultaneous background lookups (default 2). */
  concurrency?: number;
  /** Minimum spacing between background lookup starts, in ms (default 250). */
  minIntervalMs?: number;
}

export class LyricsError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function toTrackLyrics(row: LyricsRow): TrackLyrics {
  return {
    trackId: row.track_id,
    syncedLrc: row.synced_lrc,
    plainLyrics: row.plain_lyrics,
    instrumental: row.instrumental === 1,
    source: row.source,
    offsetMs: row.offset_ms,
    fetchedAt: row.fetched_at,
  };
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normCompact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\p{L}\p{N}]/gu, '');
}

function cleanArtistName(raw: string): string {
  return normalizeWhitespace(
    raw
      .replace(/\s*-\s*Topic$/i, '')
      .replace(/\s*VEVO$/i, '')
      .replace(/\s+Official(?:\s+(?:Channel|Music|Artist))?$/i, '')
      .replace(TRAILING_FEAT_RE, ''),
  );
}

function cleanTrackTitle(raw: string): string {
  return normalizeWhitespace(
    raw
      .replace(BRACKETED_NOISE_RE, ' ')
      .replace(PIPE_NOISE_RE, '')
      .replace(TRAILING_DASH_NOISE_RE, '')
      .replace(TRAILING_FEAT_RE, ''),
  );
}

/**
 * Strips YouTube uploader suffixes and video tags so LRCLIB lookups match cleanly.
 * Also extracts `"Artist - Title"` when the title embeds the artist name.
 */
export function sanitizeTrackMetadata(rawTitle: string, rawArtist: string): { title: string; artist: string } {
  let artist = cleanArtistName(rawArtist);
  let title = cleanTrackTitle(rawTitle);

  const dash = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash) {
    const left = cleanArtistName(dash[1]);
    const right = dash[2].trim();
    const compactLeft = normCompact(left);
    const compactArtist = normCompact(artist);
    const sameArtist =
      compactLeft.length >= 2 &&
      compactArtist.length >= 2 &&
      (compactLeft === compactArtist || compactLeft.includes(compactArtist) || compactArtist.includes(compactLeft));

    if (!artist || sameArtist) {
      artist = left;
      title = right;
    }
  }

  return { title, artist };
}

function hasUsableContent(record: LrclibRecord): boolean {
  return Boolean(record.syncedLyrics?.trim() || record.plainLyrics?.trim() || record.instrumental);
}

function normalizeTextForScore(value: string | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Picks the best LRCLIB search candidate by lyrics availability, title/artist match, and duration. */
export function pickBestMatch(
  records: LrclibRecord[],
  targetTitle: string,
  targetArtist: string,
  targetDurationSec: number | null,
): LrclibRecord | null {
  const normTitle = normalizeTextForScore(targetTitle);
  const normArtist = normalizeTextForScore(targetArtist);

  let best: LrclibRecord | null = null;
  let bestScore = 0;

  for (const record of records) {
    if (!hasUsableContent(record)) continue;

    let score = record.syncedLyrics?.trim() ? 30 : record.plainLyrics?.trim() ? 10 : 5;

    const recTitle = normalizeTextForScore(record.trackName);
    if (normTitle && recTitle) {
      if (recTitle === normTitle) score += 40;
      else if (recTitle.includes(normTitle) || normTitle.includes(recTitle)) score += 20;
    }

    const recArtist = normalizeTextForScore(record.artistName);
    if (normArtist && recArtist) {
      if (recArtist === normArtist) score += 30;
      else if (recArtist.includes(normArtist) || normArtist.includes(recArtist)) score += 15;
    }

    if (targetDurationSec != null && targetDurationSec > 0 && typeof record.duration === 'number' && Number.isFinite(record.duration)) {
      const diff = Math.abs(record.duration - targetDurationSec);
      if (diff <= 2) score += 30;
      else if (diff <= 5) score += 20;
      else if (diff <= 10) score += 10;
      else if (diff > 30) score -= 30;
    }

    if (score > bestScore) {
      bestScore = score;
      best = record;
    }
  }

  return best;
}

function extractPlainFromLrc(lrc: string): string | null {
  const lines: string[] = [];
  for (const rawLine of lrc.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed || LRC_META_LINE_RE.test(trimmed)) continue;
    const text = trimmed.replace(LRC_TIMESTAMP_GLOBAL_RE, '').trim();
    if (text) lines.push(text);
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

function safeFileStem(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_').trim();
}

function isReadableFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

interface LookupOutcome {
  lyrics: Omit<TrackLyrics, 'trackId' | 'offsetMs' | 'fetchedAt'>;
  transient?: boolean;
}

const EMPTY_LYRICS: LookupOutcome['lyrics'] = {
  syncedLrc: null,
  plainLyrics: null,
  instrumental: false,
  source: 'none',
};

/** Fetches, parses, caches, and manages synchronized lyrics from local `.lrc` files and LRCLIB. */
export class LyricsService extends EventEmitter<LyricsEvents> {
  private readonly inFlight = new Map<string, Promise<TrackLyrics>>();
  private readonly prefetchQueue: (() => void)[] = [];
  private readonly prefetchPending = new Map<string, Promise<LyricsPrefetchOutcome>>();
  private prefetchActive = 0;
  private lastPrefetchStart = 0;
  private readonly prefetchConcurrency: number;
  private readonly prefetchIntervalMs: number;

  constructor(
    private readonly db: Db,
    private readonly musicDir: string,
    private readonly fetchFn: FetchFn = fetch,
    private readonly log: (msg: string) => void = console.log,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    prefetchOptions: LyricsPrefetchOptions = {},
  ) {
    super();
    this.prefetchConcurrency = Math.max(1, prefetchOptions.concurrency ?? 2);
    this.prefetchIntervalMs = Math.max(0, prefetchOptions.minIntervalMs ?? 250);
  }

  getCached(trackId: string): TrackLyrics | null {
    const row = this.db.prepare('SELECT * FROM lyrics WHERE track_id = ?').get(trackId) as LyricsRow | undefined;
    return row ? toTrackLyrics(row) : null;
  }

  /** Returns cached lyrics or resolves them from local `.lrc` sidecar files / LRCLIB. */
  async getForTrack(track: Track): Promise<TrackLyrics> {
    const cached = this.getCached(track.id);
    if (cached) return cached;

    const existing = this.inFlight.get(track.id);
    if (existing) return existing;

    const task = this.resolveAndCache(track).finally(() => {
      this.inFlight.delete(track.id);
    });
    this.inFlight.set(track.id, task);
    return task;
  }

  /**
   * Queues a low-priority background lookup so the track has lyrics offline later.
   * Never rejects; tracks already in SQLite resolve to `'cached'` without HTTP.
   */
  prefetch(track: Track): Promise<LyricsPrefetchOutcome> {
    if (this.getCached(track.id)) return Promise.resolve('cached');
    const pending = this.prefetchPending.get(track.id);
    if (pending) return pending;

    const task = new Promise<void>((resolve) => this.prefetchQueue.push(resolve))
      .then(() => this.runPrefetch(track))
      .finally(() => {
        this.prefetchPending.delete(track.id);
        this.prefetchActive -= 1;
        this.pumpPrefetch();
      });
    this.prefetchPending.set(track.id, task);
    this.pumpPrefetch();
    return task;
  }

  /** Backfills lyrics for every track without a SQLite entry, respecting the prefetch concurrency limit. */
  async prefetchMissing(tracks: Track[]): Promise<LyricsPrefetchSummary> {
    const summary: LyricsPrefetchSummary = { total: tracks.length, alreadyCached: 0, found: 0, empty: 0, transient: 0 };
    const outcomes = await Promise.all(tracks.map((track) => this.prefetch(track)));
    for (const outcome of outcomes) {
      if (outcome === 'cached') summary.alreadyCached += 1;
      else summary[outcome] += 1;
    }
    return summary;
  }

  private pumpPrefetch(): void {
    while (this.prefetchActive < this.prefetchConcurrency && this.prefetchQueue.length > 0) {
      this.prefetchActive += 1;
      const wait = Math.max(0, this.lastPrefetchStart + this.prefetchIntervalMs - Date.now());
      this.lastPrefetchStart = Date.now() + wait;
      const start = this.prefetchQueue.shift()!;
      if (wait > 0) setTimeout(start, wait);
      else start();
    }
  }

  private async runPrefetch(track: Track): Promise<LyricsPrefetchOutcome> {
    if (this.getCached(track.id)) return 'cached';
    try {
      const lyrics = await this.getForTrack(track);
      // resolveAndCache skips saving on transient LRCLIB failures, so a missing row means "retry later".
      if (!this.getCached(track.id)) return 'transient';
      return lyrics.syncedLrc || lyrics.plainLyrics ? 'found' : 'empty';
    } catch (err) {
      this.log(`[lyrics] falha na pré-busca de "${track.title}": ${err instanceof Error ? err.message : String(err)}`);
      return 'transient';
    }
  }

  /** Updates sync offset (ms) for a track and emits an `'offset'` event for WebSocket broadcast. */
  async updateOffset(track: Track, rawOffsetMs: unknown): Promise<TrackLyrics> {
    if (typeof rawOffsetMs !== 'number' || !Number.isFinite(rawOffsetMs)) {
      throw new LyricsError('offsetMs deve ser um número finito', 400);
    }
    const offsetMs = Math.round(rawOffsetMs);
    if (Math.abs(offsetMs) > MAX_OFFSET_MS) {
      throw new LyricsError(`offsetMs deve estar entre -${MAX_OFFSET_MS} e ${MAX_OFFSET_MS}`, 400);
    }

    const base = this.getCached(track.id) ?? (await this.getForTrack(track));
    const updated: TrackLyrics = { ...base, offsetMs };
    this.save(updated);
    this.emit('offset', track.id, offsetMs);
    return updated;
  }

  /** Clears cached lyrics for a track so the next read triggers a fresh lookup. */
  clear(trackId: string): void {
    this.db.prepare('DELETE FROM lyrics WHERE track_id = ?').run(trackId);
    this.emit('cleared', trackId);
  }

  private async resolveAndCache(track: Track): Promise<TrackLyrics> {
    const local = this.readLocalLrc(track);
    if (local) {
      const entry: TrackLyrics = {
        trackId: track.id,
        ...local,
        offsetMs: 0,
        fetchedAt: Date.now(),
      };
      this.save(entry);
      return entry;
    }

    const remote = await this.fetchFromLrclib(track);
    const entry: TrackLyrics = {
      trackId: track.id,
      ...remote.lyrics,
      offsetMs: 0,
      fetchedAt: Date.now(),
    };
    if (!remote.transient) this.save(entry);
    return entry;
  }

  private readLocalLrc(track: Track): LookupOutcome['lyrics'] | null {
    const candidates: string[] = [];

    if (track.filePath) {
      const dir = path.dirname(track.filePath);
      const base = path.basename(track.filePath, path.extname(track.filePath));
      candidates.push(path.join(dir, `${base}.lrc`), path.join(dir, `${base}.LRC`));
    }

    const resolvedMusicDir = path.resolve(this.musicDir);
    const namedStem =
      track.artist && track.title
        ? safeFileStem(`${track.artist} - ${track.title}`)
        : track.title
          ? safeFileStem(track.title)
          : '';
    if (namedStem) {
      const sidecar = path.resolve(resolvedMusicDir, `${namedStem}.lrc`);
      if (sidecar.startsWith(resolvedMusicDir + path.sep)) candidates.push(sidecar);
    }

    for (const candidate of candidates) {
      if (!isReadableFile(candidate)) continue;
      let raw: string;
      try {
        raw = fs.readFileSync(candidate, 'utf8');
      } catch {
        continue;
      }
      const content = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
      if (!content) continue;

      if (LRC_TIMESTAMP_RE.test(content)) {
        return {
          syncedLrc: content,
          plainLyrics: extractPlainFromLrc(content),
          instrumental: false,
          source: 'local',
        };
      }
      return {
        syncedLrc: null,
        plainLyrics: content,
        instrumental: false,
        source: 'local',
      };
    }

    return null;
  }

  private async fetchFromLrclib(track: Track): Promise<LookupOutcome> {
    const { title, artist } = sanitizeTrackMetadata(track.title, track.artist);
    if (!title) return { lyrics: EMPTY_LYRICS };

    try {
      if (artist) {
        const params = new URLSearchParams({ track_name: title, artist_name: artist });
        if (track.album?.trim()) params.set('album_name', track.album.trim());
        if (track.durationSec != null && track.durationSec > 0) {
          params.set('duration', String(Math.round(track.durationSec)));
        }
        const direct = await this.fetchJson<LrclibRecord>(`${LRCLIB_BASE}/get?${params}`);
        if (direct && hasUsableContent(direct)) {
          return { lyrics: this.recordToOutcome(direct) };
        }
      }

      const primaryQuery = `${artist} ${title}`.trim();
      let best = await this.searchBest(primaryQuery, title, artist, track.durationSec);

      // If the artist looked like a YouTube uploader name while the title still contains "Artist - Song", retry with that.
      if (!best) {
        const dash = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
        if (dash) {
          const parsedArtist = cleanArtistName(dash[1]);
          const parsedTitle = dash[2].trim();
          best = await this.searchBest(`${parsedArtist} ${parsedTitle}`.trim(), parsedTitle, parsedArtist, track.durationSec);
        }
      }

      return { lyrics: best ? this.recordToOutcome(best) : EMPTY_LYRICS };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[lyrics] falha ao consultar LRCLIB para "${track.title}": ${msg}`);
      return { lyrics: EMPTY_LYRICS, transient: true };
    }
  }

  private async searchBest(
    query: string,
    targetTitle: string,
    targetArtist: string,
    durationSec: number | null,
  ): Promise<LrclibRecord | null> {
    if (!query) return null;
    const records = await this.fetchJson<LrclibRecord[]>(`${LRCLIB_BASE}/search?${new URLSearchParams({ q: query })}`);
    if (!Array.isArray(records) || records.length === 0) return null;
    return pickBestMatch(records, targetTitle, targetArtist, durationSec);
  }

  private recordToOutcome(record: LrclibRecord): LookupOutcome['lyrics'] {
    const syncedLrc = record.syncedLyrics?.trim() || null;
    const plainLyrics = record.plainLyrics?.trim() || (syncedLrc ? extractPlainFromLrc(syncedLrc) : null);
    return {
      syncedLrc,
      plainLyrics,
      instrumental: Boolean(record.instrumental),
      source: 'lrclib',
    };
  }

  private async fetchJson<T>(url: string): Promise<T | null> {
    const res = await this.fetchFn(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  private save(lyrics: TrackLyrics): void {
    this.db
      .prepare(
        `INSERT INTO lyrics (track_id, synced_lrc, plain_lyrics, instrumental, source, offset_ms, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (track_id) DO UPDATE SET
           synced_lrc = excluded.synced_lrc,
           plain_lyrics = excluded.plain_lyrics,
           instrumental = excluded.instrumental,
           source = excluded.source,
           offset_ms = excluded.offset_ms,
           fetched_at = excluded.fetched_at`,
      )
      .run(
        lyrics.trackId,
        lyrics.syncedLrc,
        lyrics.plainLyrics,
        lyrics.instrumental ? 1 : 0,
        lyrics.source,
        lyrics.offsetMs,
        lyrics.fetchedAt,
      );
  }
}
