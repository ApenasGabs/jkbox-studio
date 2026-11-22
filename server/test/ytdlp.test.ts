import { describe, expect, it } from 'vitest';
import { entryToResult, parseProgressLine } from '../src/services/ytdlp.js';

describe('yt-dlp helpers', () => {
  it('parses progress lines', () => {
    expect(parseProgressLine('jkbox-progress:500:1000:NA')).toBe(0.5);
    expect(parseProgressLine('jkbox-progress:250:NA:1000')).toBe(0.25);
    expect(parseProgressLine('jkbox-progress:NA:NA:NA')).toBeNull();
    expect(parseProgressLine('[download] something else')).toBeNull();
  });

  it('maps flat-playlist entries to search results', () => {
    const result = entryToResult({
      id: 'dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
      channel: 'Rick Astley',
      duration: 213.6,
      thumbnails: [
        { url: 'small.jpg', width: 100 },
        { url: 'big.jpg', width: 720 },
      ],
    });
    expect(result).toEqual({
      source: 'youtube',
      sourceId: 'dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
      album: null,
      durationSec: 214,
      thumbnail: 'big.jpg',
    });
  });
});
