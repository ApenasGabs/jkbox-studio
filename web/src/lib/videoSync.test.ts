import { describe, expect, it } from 'vitest';
import {
  SPOTIFY_VIDEO_DRIFT_THRESHOLD_SEC,
  clampVideoSeekSec,
  planSpotifyVideoSync,
  shouldSeekForDrift,
} from './videoSync';

describe('videoSync helpers', () => {
  it('clamps seek times safely against known media durations', () => {
    expect(clampVideoSeekSec(-5, 180)).toBe(0);
    expect(clampVideoSeekSec(Number.NaN, 180)).toBe(0);
    expect(clampVideoSeekSec(42.5, null)).toBe(42.5);
    expect(clampVideoSeekSec(42.5, 180)).toBe(42.5);
    expect(clampVideoSeekSec(185, 180)).toBeCloseTo(179.9, 5);
    expect(clampVideoSeekSec(5, 0.05)).toBe(0);
  });

  it('seeks only when drift exceeds the 2.75s tolerance threshold', () => {
    expect(SPOTIFY_VIDEO_DRIFT_THRESHOLD_SEC).toBe(2.75);
    expect(shouldSeekForDrift(10, 10)).toBe(false);
    expect(shouldSeekForDrift(10, 12.5)).toBe(false);
    expect(shouldSeekForDrift(10, 12.75)).toBe(false);
    expect(shouldSeekForDrift(10, 12.8)).toBe(true);
    expect(shouldSeekForDrift(15, 12.1)).toBe(true);
    expect(shouldSeekForDrift(Number.NaN, 12)).toBe(false);
  });

  it('plans play/pause and defers seeks until loadedmetadata (readyState >= 1)', () => {
    expect(
      planSpotifyVideoSync({
        readyState: 0,
        currentTime: 0,
        duration: 200,
        mediaPaused: true,
        targetTimeSec: 34,
        targetPaused: false,
      }),
    ).toEqual({
      play: true,
      pause: false,
      seekSec: null,
      deferSeekSec: 34,
    });

    expect(
      planSpotifyVideoSync({
        readyState: 1,
        currentTime: 32.5,
        duration: 200,
        mediaPaused: false,
        targetTimeSec: 34,
        targetPaused: false,
        nowMs: 5000,
        lastSeekAtMs: 0,
      }),
    ).toEqual({
      play: false,
      pause: false,
      seekSec: null,
      deferSeekSec: null,
    });

    expect(
      planSpotifyVideoSync({
        readyState: 2,
        currentTime: 30,
        duration: 200,
        mediaPaused: false,
        targetTimeSec: 34,
        targetPaused: true,
        nowMs: 5000,
        lastSeekAtMs: 0,
      }),
    ).toEqual({
      play: false,
      pause: true,
      seekSec: 34,
      deferSeekSec: null,
    });
  });

  it('skips seeks while already seeking or inside the seek cooldown window', () => {
    expect(
      planSpotifyVideoSync({
        readyState: 3,
        seeking: true,
        currentTime: 10,
        duration: 200,
        mediaPaused: false,
        targetTimeSec: 40,
        targetPaused: false,
        nowMs: 5000,
        lastSeekAtMs: 0,
      }).seekSec,
    ).toBeNull();

    expect(
      planSpotifyVideoSync({
        readyState: 3,
        seeking: false,
        currentTime: 10,
        duration: 200,
        mediaPaused: false,
        targetTimeSec: 40,
        targetPaused: false,
        nowMs: 2000,
        lastSeekAtMs: 1200,
        seekCooldownMs: 1500,
      }).seekSec,
    ).toBeNull();
  });
});
