import type { AutoDjMode } from '../types.js';

export const DEFAULT_AUTO_DJ_RECENT_WINDOW = 10;

export interface AutoDjTrack {
  id: string;
  genre?: string | null;
  subgenre?: string | null;
}

export interface AutoDjOptions {
  recentWindow?: number;
  random?: () => number;
  mode?: AutoDjMode;
  lastTrack?: AutoDjTrack | null;
  category?: string | null;
  subgenre?: string | null;
  playlistTrackIds?: ReadonlySet<string> | readonly string[];
}

/**
 * Safe genre affinity map (normalized lowercase keys/values).
 * Gospel is intentionally absent and isolated in both directions.
 */
export const GENRE_AFFINITY: Record<string, readonly string[]> = {
  'samba & pagode': ['mpb', 'forró & piseiro', 'axé'],
  samba: ['mpb', 'forró & piseiro', 'axé'],
  pagode: ['mpb', 'forró & piseiro', 'axé'],
  mpb: ['samba & pagode', 'pop', 'reggae', 'flashback'],
  'forró & piseiro': ['sertanejo', 'samba & pagode', 'axé'],
  forró: ['sertanejo', 'samba & pagode', 'axé'],
  piseiro: ['sertanejo', 'samba & pagode', 'axé'],
  sertanejo: ['forró & piseiro', 'mpb', 'pop'],
  funk: ['rap & trap', 'eletrônica', 'pop'],
  'rap & trap': ['funk', 'eletrônica', 'reggae'],
  rap: ['funk', 'eletrônica', 'reggae'],
  trap: ['funk', 'eletrônica', 'reggae'],
  eletrônica: ['pop', 'funk', 'rap & trap', 'flashback'],
  rock: ['pop', 'flashback', 'mpb', 'reggae'],
  pop: ['eletrônica', 'mpb', 'rock', 'flashback', 'funk', 'sertanejo'],
  reggae: ['mpb', 'rock', 'rap & trap'],
  flashback: ['pop', 'rock', 'mpb', 'eletrônica'],
  axé: ['samba & pagode', 'forró & piseiro', 'pop'],
  gospel: [],
};

function normText(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

export function isGospelGenre(genre: string | null | undefined): boolean {
  const norm = normText(genre);
  if (!norm) return false;
  return norm === 'gospel' || /\b(?:gospel|louvor|adora[cç][aã]o|crist[aã]o?|christian|worship)\b/i.test(norm);
}

function getAffinitySet(genre: string | null | undefined): Set<string> {
  const norm = normText(genre);
  if (!norm || isGospelGenre(norm)) return new Set();
  const list = GENRE_AFFINITY[norm] ?? [];
  return new Set(list.map((g) => g.toLowerCase()));
}

function buildExcludedSet<T extends { id: string }>(
  pool: readonly T[],
  recentPlayedTrackIds: readonly string[],
  recentWindow: number,
): Set<string> {
  const poolIds = new Set(pool.map((t) => t.id));
  const maxExcluded = Math.min(Math.max(0, recentWindow), Math.max(0, pool.length - 1));
  const excluded = new Set<string>();
  for (const id of recentPlayedTrackIds) {
    if (excluded.size >= maxExcluded) break;
    if (!poolIds.has(id) || excluded.has(id)) continue;
    excluded.add(id);
  }
  return excluded;
}

function pickFromCandidates<T>(candidates: readonly T[], random: () => number): T | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const rand = random();
  const index = Math.min(candidates.length - 1, Math.max(0, Math.floor(rand * candidates.length)));
  return candidates[index];
}

function pickAvoidingRecent<T extends { id: string }>(
  pool: readonly T[],
  recentPlayedTrackIds: readonly string[],
  recentWindow: number,
  random: () => number,
): T | null {
  if (pool.length === 0) return null;
  if (pool.length === 1) return pool[0];
  const excluded = buildExcludedSet(pool, recentPlayedTrackIds, recentWindow);
  const fresh = pool.filter((track) => !excluded.has(track.id));
  return pickFromCandidates(fresh.length > 0 ? fresh : pool, random);
}

/**
 * Picks the next Auto-DJ track according to the active mode:
 * - `vibe` (default): 3-level cascade (same subgenre -> same genre -> safe affinity map),
 *   strictly isolating Gospel tracks in both directions.
 * - `category`: locks selection to `options.category` (and `options.subgenre` when provided).
 * - `playlist`: locks selection to tracks inside `options.playlistTrackIds` respecting the recent window.
 * - `random`: picks uniformly across all cached tracks avoiding the recent window.
 */
export function pickAutoDjTrack<T extends AutoDjTrack>(
  cached: readonly T[],
  recentPlayedTrackIds: readonly string[],
  options: AutoDjOptions = {},
): T | null {
  if (cached.length === 0) return null;

  const recentWindow = Math.max(0, options.recentWindow ?? DEFAULT_AUTO_DJ_RECENT_WINDOW);
  const random = options.random ?? Math.random;
  const mode: AutoDjMode = options.mode ?? 'vibe';

  if (mode === 'random') {
    return pickAvoidingRecent(cached, recentPlayedTrackIds, recentWindow, random);
  }

  if (mode === 'playlist') {
    const allowedIds =
      options.playlistTrackIds instanceof Set
        ? options.playlistTrackIds
        : new Set(options.playlistTrackIds ?? []);
    if (allowedIds.size === 0) return null;
    const playlistPool = cached.filter((t) => allowedIds.has(t.id));
    if (playlistPool.length === 0) return null;
    return pickAvoidingRecent(playlistPool, recentPlayedTrackIds, recentWindow, random);
  }

  if (mode === 'category') {
    const targetCategory = normText(options.category);
    if (!targetCategory) return null;
    const catPool = cached.filter((t) => normText(t.genre) === targetCategory);
    if (catPool.length === 0) return null;

    const targetSub = normText(options.subgenre);
    if (targetSub) {
      const subPool = catPool.filter((t) => normText(t.subgenre) === targetSub);
      if (subPool.length > 0) {
        return pickAvoidingRecent(subPool, recentPlayedTrackIds, recentWindow, random);
      }
    }
    return pickAvoidingRecent(catPool, recentPlayedTrackIds, recentWindow, random);
  }

  // `vibe` mode (default)
  const lastTrack = options.lastTrack ?? null;

  if (lastTrack && isGospelGenre(lastTrack.genre)) {
    const gospelPool = cached.filter((t) => isGospelGenre(t.genre));
    if (gospelPool.length === 0) return null;

    const excluded = buildExcludedSet(gospelPool, recentPlayedTrackIds, recentWindow);
    const fresh = gospelPool.filter((t) => !excluded.has(t.id));
    const candidates = fresh.length > 0 ? fresh : gospelPool;

    const targetSub = normText(lastTrack.subgenre);
    if (targetSub) {
      const sameSub = candidates.filter((t) => normText(t.subgenre) === targetSub);
      if (sameSub.length > 0) return pickFromCandidates(sameSub, random);
    }
    return pickFromCandidates(candidates, random);
  }

  // Non-Gospel vibe: never mix Gospel tracks in.
  const nonGospelPool = cached.filter((t) => !isGospelGenre(t.genre));
  if (nonGospelPool.length === 0) return null;

  const lastGenre = normText(lastTrack?.genre);
  const lastSubgenre = normText(lastTrack?.subgenre);
  if (lastGenre) {
    const excluded = buildExcludedSet(nonGospelPool, recentPlayedTrackIds, recentWindow);
    const fresh = nonGospelPool.filter((t) => !excluded.has(t.id));
    const candidates = fresh.length > 0 ? fresh : nonGospelPool;

    // Level 1: same subgenre (within same genre)
    if (lastSubgenre) {
      const sameSub = candidates.filter(
        (t) => normText(t.subgenre) === lastSubgenre && normText(t.genre) === lastGenre,
      );
      if (sameSub.length > 0) return pickFromCandidates(sameSub, random);
    }

    // Level 2: same genre
    const sameGenre = candidates.filter((t) => normText(t.genre) === lastGenre);
    if (sameGenre.length > 0) return pickFromCandidates(sameGenre, random);

    // Level 3: safe affinity genres
    const affinity = getAffinitySet(lastGenre);
    if (affinity.size > 0) {
      const affine = candidates.filter((t) => affinity.has(normText(t.genre)));
      if (affine.length > 0) return pickFromCandidates(affine, random);
    }
  }

  return pickAvoidingRecent(nonGospelPool, recentPlayedTrackIds, recentWindow, random);
}
