import { describe, expect, it } from 'vitest';
import { parseInput } from '../src/lib/parseInput.js';

describe('parseInput', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?t=10', 'dQw4w9WgXcQ'],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RD', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ])('detects YouTube video %s', (url, id) => {
    expect(parseInput(url)).toEqual({ kind: 'youtube', videoId: id });
  });

  it('detects YouTube playlists', () => {
    expect(parseInput('https://www.youtube.com/playlist?list=PL123')).toMatchObject({
      kind: 'youtube-playlist',
      playlistId: 'PL123',
    });
  });

  it('detects Spotify links and URIs', () => {
    expect(parseInput('https://open.spotify.com/intl-pt/track/4uLU6hMCjMI75M1A2tKUQC?si=x')).toEqual({
      kind: 'spotify-track',
      id: '4uLU6hMCjMI75M1A2tKUQC',
    });
    expect(parseInput('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M')).toEqual({
      kind: 'spotify-playlist',
      id: '37i9dQZF1DXcBWIGoYBM5M',
    });
    expect(parseInput('https://open.spotify.com/album/abc123')).toEqual({ kind: 'spotify-album', id: 'abc123' });
  });

  it('treats everything else as a text query', () => {
    expect(parseInput('  never gonna give you up ')).toEqual({ kind: 'query', query: 'never gonna give you up' });
    expect(parseInput('https://example.com/song')).toMatchObject({ kind: 'query' });
  });
});
