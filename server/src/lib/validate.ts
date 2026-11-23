import type { SearchResult, TrackSource } from '../types.js';

const SOURCES = new Set<TrackSource>(['youtube', 'spotify', 'local', 'deezer']);
export const YOUTUBE_ID_RE = /^[\w-]{11}$/;
export const SPOTIFY_ID_RE = /^[A-Za-z0-9]{1,64}$/;
export const DEEZER_ID_RE = /^\d{1,32}$/;
const SPOTIFY_TRACK_URI_RE = /^spotify:track:[A-Za-z0-9]{1,64}$/;
const MAX_TEXT = 300;

function text(value: unknown, max = MAX_TEXT): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Returns the URL only when it is an absolute http(s) URL; anything else becomes null. */
export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Validates and normalizes an untrusted search result coming from a client (POST /api/queue).
 * Returns null when the payload can't be enqueued safely.
 */
export function sanitizeResult(input: unknown): SearchResult | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const source = raw.source as TrackSource;
  if (!SOURCES.has(source)) return null;
  const sourceId = text(raw.sourceId, 512);
  const title = text(raw.title);
  if (!sourceId || !title) return null;
  if (source === 'youtube' && !YOUTUBE_ID_RE.test(sourceId)) return null;
  if (source === 'spotify' && !SPOTIFY_ID_RE.test(sourceId)) return null;
  if (source === 'deezer' && !DEEZER_ID_RE.test(sourceId)) return null;

  const duration = raw.durationSec;
  const spotifyUri = typeof raw.spotifyUri === 'string' && SPOTIFY_TRACK_URI_RE.test(raw.spotifyUri) ? raw.spotifyUri : null;
  const result: SearchResult = {
    source,
    sourceId,
    title,
    artist: text(raw.artist),
    album: text(raw.album) || null,
    durationSec: typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : null,
    thumbnail: safeHttpUrl(raw.thumbnail),
    spotifyUri,
  };
  if (typeof raw.trackId === 'string' && raw.trackId) result.trackId = raw.trackId.slice(0, 64);
  return result;
}
