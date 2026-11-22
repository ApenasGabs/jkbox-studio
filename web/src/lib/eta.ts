import type { QueueEntry } from './types';

/**
 * Computes estimated wait time in seconds for each queued item:
 * `(remaining time of current track) + sum of durations of preceding queued items`.
 * Returns `null` for an item when the current track's remaining time is unknown.
 */
export function computeQueueEtas(
  queue: Pick<QueueEntry, 'track'>[],
  currentRemainingSec: number | null,
): (number | null)[] {
  if (currentRemainingSec === null || !Number.isFinite(currentRemainingSec)) {
    return queue.map(() => null);
  }
  let accumulatedSec = Math.max(0, currentRemainingSec);
  return queue.map((entry) => {
    const eta = accumulatedSec;
    const duration = entry.track.durationSec;
    if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
      accumulatedSec += duration;
    }
    return eta;
  });
}

/** Formats an ETA in seconds into a compact badge label (`< 1 min` or `~X min`). */
export function formatEta(etaSec: number | null | undefined): string | null {
  if (etaSec == null || !Number.isFinite(etaSec) || etaSec < 0) return null;
  if (etaSec < 60) return '< 1 min';
  return `~${Math.round(etaSec / 60)} min`;
}
