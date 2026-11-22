import { describe, expect, it } from 'vitest';
import { mimeFor, parseRange } from '../src/lib/stream.js';

describe('parseRange', () => {
  it('parses explicit, open and suffix ranges', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
  });

  it('rejects unsatisfiable ranges', () => {
    expect(parseRange('bytes=1000-', 1000)).toBeNull();
    expect(parseRange('bytes=50-10', 1000)).toBeNull();
    expect(parseRange('items=0-1', 1000)).toBeNull();
    expect(parseRange('bytes=-', 1000)).toBeNull();
  });

  it('maps audio mime types', () => {
    expect(mimeFor('/x/a.m4a')).toBe('audio/mp4');
    expect(mimeFor('/x/a.MP3')).toBe('audio/mpeg');
  });
});
