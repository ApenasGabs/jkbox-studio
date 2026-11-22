import { describe, expect, it } from 'vitest';
import { findActiveLineIndex, formatOffsetMs, interpolatePlaybackSec, parseLrc } from './lrc';

describe('LRC parser and sync helpers', () => {
  it('parses [mm:ss.xx] and [mm:ss.xxx] timestamps accurately', () => {
    const lrc = [
      '[00:05.50] First line',
      '[00:12.05] Second line',
      '[01:23.456] Third line',
      '[02:00] Fourth line without decimals',
      '[00:00.5] Short fraction',
    ].join('\n');

    expect(parseLrc(lrc)).toEqual([
      { timeSec: 0.5, text: 'Short fraction' },
      { timeSec: 5.5, text: 'First line' },
      { timeSec: 12.05, text: 'Second line' },
      { timeSec: 83.456, text: 'Third line' },
      { timeSec: 120, text: 'Fourth line without decimals' },
    ]);
  });

  it('expands multiple timestamp tags per line and sorts chronologically', () => {
    const lrc = [
      '[01:10.00][00:25.25] Refrão repetido',
      '[00:10.00] Verso inicial',
    ].join('\n');

    expect(parseLrc(lrc)).toEqual([
      { timeSec: 10, text: 'Verso inicial' },
      { timeSec: 25.25, text: 'Refrão repetido' },
      { timeSec: 70, text: 'Refrão repetido' },
    ]);
  });

  it('ignores metadata tags, BOM, blank lines, and empty timestamp lines', () => {
    const lrc = '\uFEFF[ar:Queen]\r\n[ti:Bohemian Rhapsody]\r\n[offset:+500]\r\n\r\n[00:01.50] Is this the real life?\r\n[00:03.00]\r\nUntimed note\r\n[00:04.20] Is this just fantasy?';

    expect(parseLrc(lrc)).toEqual([
      { timeSec: 1.5, text: 'Is this the real life?' },
      { timeSec: 4.2, text: 'Is this just fantasy?' },
    ]);
    expect(parseLrc(null)).toEqual([]);
    expect(parseLrc('')).toEqual([]);
  });

  it('finds active line index across boundaries and applies offsetMs dynamically', () => {
    const lines = parseLrc('[00:10.00] Line 1\n[00:20.00] Line 2\n[00:30.00] Line 3');

    expect(findActiveLineIndex([], 15)).toBe(-1);
    expect(findActiveLineIndex(lines, Number.NaN)).toBe(-1);
    expect(findActiveLineIndex(lines, 9.99)).toBe(-1);
    expect(findActiveLineIndex(lines, 10)).toBe(0);
    expect(findActiveLineIndex(lines, 19.99)).toBe(0);
    expect(findActiveLineIndex(lines, 20)).toBe(1);
    expect(findActiveLineIndex(lines, 45)).toBe(2);

    // Positive offset advances lyrics (appears earlier)
    expect(findActiveLineIndex(lines, 9.6, 500)).toBe(0);
    expect(findActiveLineIndex(lines, 19.6, 500)).toBe(1);

    // Negative offset delays lyrics (appears later)
    expect(findActiveLineIndex(lines, 10.2, -500)).toBe(-1);
    expect(findActiveLineIndex(lines, 10.5, -500)).toBe(0);
    expect(findActiveLineIndex(lines, 20.4, -500)).toBe(0);
    expect(findActiveLineIndex(lines, 20.5, -500)).toBe(1);
  });

  it('formats offset ms and interpolates playback seconds cleanly', () => {
    expect(formatOffsetMs(0)).toBe('0ms');
    expect(formatOffsetMs(500)).toBe('+500ms');
    expect(formatOffsetMs(-1000)).toBe('-1000ms');

    expect(interpolatePlaybackSec(10, 450, false)).toBeCloseTo(10.45);
    expect(interpolatePlaybackSec(10, 450, true)).toBe(10);
    expect(interpolatePlaybackSec(99.8, 500, false, 100)).toBe(100);
  });
});
