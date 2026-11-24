/** Drift threshold (seconds) above which Spotify-synced video applies a smooth seek. */
export const SPOTIFY_VIDEO_DRIFT_THRESHOLD_SEC = 2.75;

/** Minimum interval (ms) between consecutive drift seeks to avoid stutter. */
export const SPOTIFY_VIDEO_SEEK_COOLDOWN_MS = 1500;

export interface SpotifyVideoSyncInput {
  readyState: number;
  seeking?: boolean;
  currentTime: number;
  duration?: number | null;
  mediaPaused: boolean;
  targetTimeSec: number;
  targetPaused: boolean;
  driftThresholdSec?: number;
  nowMs?: number;
  lastSeekAtMs?: number;
  seekCooldownMs?: number;
}

export interface SpotifyVideoSyncPlan {
  play: boolean;
  pause: boolean;
  seekSec: number | null;
  deferSeekSec: number | null;
}

/** Clamps a desired seek position to `[0, duration - 0.1]` when duration is known. */
export function clampVideoSeekSec(targetSec: number, durationSec?: number | null): number {
  const safeTarget = Number.isFinite(targetSec) && targetSec > 0 ? targetSec : 0;
  if (durationSec == null || !Number.isFinite(durationSec) || durationSec <= 0) {
    return safeTarget;
  }
  if (durationSec <= 0.1) return 0;
  return Math.min(safeTarget, Math.max(0, durationSec - 0.1));
}

/** Returns true only when playback drift exceeds the configured tolerance (~2.5-3s). */
export function shouldSeekForDrift(
  currentSec: number,
  targetSec: number,
  thresholdSec = SPOTIFY_VIDEO_DRIFT_THRESHOLD_SEC,
): boolean {
  if (!Number.isFinite(currentSec) || !Number.isFinite(targetSec)) return false;
  const safeCurrent = Math.max(0, currentSec);
  const safeTarget = Math.max(0, targetSec);
  return Math.abs(safeCurrent - safeTarget) > thresholdSec;
}

/**
 * Computes play/pause and drift-tolerant seek actions for muted Kiosk video
 * synchronized against Spotify Connect playback state.
 */
export function planSpotifyVideoSync(input: SpotifyVideoSyncInput): SpotifyVideoSyncPlan {
  const play = !input.targetPaused && input.mediaPaused;
  const pause = input.targetPaused && !input.mediaPaused;
  const safeTarget = Number.isFinite(input.targetTimeSec) && input.targetTimeSec > 0 ? input.targetTimeSec : 0;

  if (input.readyState < 1) {
    return {
      play,
      pause,
      seekSec: null,
      deferSeekSec: safeTarget > 0 ? safeTarget : null,
    };
  }

  if (input.seeking) {
    return { play, pause, seekSec: null, deferSeekSec: null };
  }

  const cooldownMs = input.seekCooldownMs ?? SPOTIFY_VIDEO_SEEK_COOLDOWN_MS;
  if (
    input.nowMs !== undefined &&
    input.lastSeekAtMs !== undefined &&
    input.lastSeekAtMs > 0 &&
    input.nowMs - input.lastSeekAtMs < cooldownMs
  ) {
    return { play, pause, seekSec: null, deferSeekSec: null };
  }

  const clampedTarget = clampVideoSeekSec(safeTarget, input.duration);
  const threshold = input.driftThresholdSec ?? SPOTIFY_VIDEO_DRIFT_THRESHOLD_SEC;
  const seekSec = shouldSeekForDrift(input.currentTime, clampedTarget, threshold) ? clampedTarget : null;

  return { play, pause, seekSec, deferSeekSec: null };
}
