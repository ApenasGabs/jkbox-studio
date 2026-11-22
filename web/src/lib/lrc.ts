export interface LrcLine {
  timeSec: number;
  text: string;
}

const TIMESTAMP_TAG_RE = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

/** Parses LRC formatted text into chronologically sorted timed lines, ignoring metadata tags. */
export function parseLrc(lrc: string | null | undefined): LrcLine[] {
  if (!lrc) return [];
  const normalized = lrc.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines: LrcLine[] = [];

  for (const rawLine of normalized.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    TIMESTAMP_TAG_RE.lastIndex = 0;
    const timestamps: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = TIMESTAMP_TAG_RE.exec(trimmed)) !== null) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const millis = match[3] ? Number(match[3].padEnd(3, '0')) : 0;
      timestamps.push(minutes * 60 + seconds + millis / 1000);
    }

    if (timestamps.length === 0) continue;

    const text = trimmed.replace(TIMESTAMP_TAG_RE, '').trim();
    if (!text) continue;

    for (const timeSec of timestamps) {
      lines.push({ timeSec, text });
    }
  }

  lines.sort((a, b) => a.timeSec - b.timeSec);
  return lines;
}

/**
 * Returns the index of the active lyric line for `currentTimeSec` adjusted by `offsetMs`,
 * or `-1` if `lines` is empty or playback hasn't reached the first line yet.
 */
export function findActiveLineIndex(lines: readonly LrcLine[], currentTimeSec: number, offsetMs = 0): number {
  if (lines.length === 0 || !Number.isFinite(currentTimeSec)) return -1;
  const safeOffsetMs = Number.isFinite(offsetMs) ? offsetMs : 0;
  const effectiveTime = currentTimeSec + safeOffsetMs / 1000;

  if (effectiveTime < lines[0].timeSec) return -1;

  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid].timeSec <= effectiveTime) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Formats a sync offset in milliseconds (e.g. `0ms`, `+500ms`, `-500ms`). */
export function formatOffsetMs(offsetMs: number): string {
  if (!Number.isFinite(offsetMs) || offsetMs === 0) return '0ms';
  const rounded = Math.round(offsetMs);
  return `${rounded > 0 ? '+' : ''}${rounded}ms`;
}

/** Computes smoothly interpolated playback seconds between WebSocket progress ticks. */
export function interpolatePlaybackSec(
  baseSec: number,
  elapsedMs: number,
  paused: boolean,
  maxSec?: number | null,
): number {
  const safeBase = Number.isFinite(baseSec) && baseSec > 0 ? baseSec : 0;
  if (paused || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return safeBase;
  const next = safeBase + elapsedMs / 1000;
  if (maxSec != null && Number.isFinite(maxSec) && maxSec > 0) {
    return Math.min(maxSec, next);
  }
  return next;
}
