export const DEFAULT_AUTO_DJ_RECENT_WINDOW = 10;

export interface AutoDjOptions {
  recentWindow?: number;
  random?: () => number;
}

/**
 * Picks a random cached track while avoiding the last N distinct played tracks.
 * When fewer than `recentWindow + 1` cached tracks exist, excludes up to `cached.length - 1`
 * most-recent tracks so playback cycles cleanly instead of stalling or repeating immediately.
 */
export function pickAutoDjTrack<T extends { id: string }>(
  cached: readonly T[],
  recentPlayedTrackIds: readonly string[],
  options: AutoDjOptions = {},
): T | null {
  if (cached.length === 0) return null;
  if (cached.length === 1) return cached[0];

  const recentWindow = Math.max(0, options.recentWindow ?? DEFAULT_AUTO_DJ_RECENT_WINDOW);
  const cachedIds = new Set(cached.map((track) => track.id));
  const maxExcluded = Math.min(recentWindow, cached.length - 1);
  const excluded = new Set<string>();

  for (const id of recentPlayedTrackIds) {
    if (excluded.size >= maxExcluded) break;
    if (!cachedIds.has(id) || excluded.has(id)) continue;
    excluded.add(id);
  }

  const pool = cached.filter((track) => !excluded.has(track.id));
  const candidates = pool.length > 0 ? pool : cached;
  const rand = (options.random ?? Math.random)();
  const index = Math.min(candidates.length - 1, Math.max(0, Math.floor(rand * candidates.length)));
  return candidates[index];
}
