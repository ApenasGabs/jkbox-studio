import { describe, expect, it } from 'vitest';
import { computeQueueEtas, formatEta } from './eta';

describe('queue ETA helpers', () => {
  it('computes cumulative wait time from remaining current track plus preceding items', () => {
    const queue = [
      { track: { durationSec: 180 } },
      { track: { durationSec: 240 } },
      { track: { durationSec: 90 } },
    ] as Parameters<typeof computeQueueEtas>[0];

    expect(computeQueueEtas(queue, 45)).toEqual([45, 225, 465]);
  });

  it('updates item ETAs as current track progresses', () => {
    const queue = [
      { track: { durationSec: 120 } },
      { track: { durationSec: 180 } },
    ] as Parameters<typeof computeQueueEtas>[0];

    expect(computeQueueEtas(queue, 110).map(formatEta)).toEqual(['~2 min', '~4 min']);
    expect(computeQueueEtas(queue, 20).map(formatEta)).toEqual(['< 1 min', '~2 min']);
  });

  it('returns null when current track remaining duration is unknown', () => {
    const queue = [{ track: { durationSec: 180 } }] as Parameters<typeof computeQueueEtas>[0];
    expect(computeQueueEtas(queue, null)).toEqual([null]);
  });

  it('formats ETA labels cleanly', () => {
    expect(formatEta(null)).toBeNull();
    expect(formatEta(0)).toBe('< 1 min');
    expect(formatEta(59)).toBe('< 1 min');
    expect(formatEta(60)).toBe('~1 min');
    expect(formatEta(350)).toBe('~6 min');
  });
});
