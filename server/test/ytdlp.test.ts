import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { buildVideoFormatSelector, entryToResult, parseProgressLine, YtDlp } from '../src/services/ytdlp.js';

describe('yt-dlp helpers', () => {
  it('builds lightweight mp4 format selector using max height', () => {
    expect(buildVideoFormatSelector(720)).toBe(
      'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best',
    );
    expect(buildVideoFormatSelector(480)).toBe(
      'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best',
    );
    expect(buildVideoFormatSelector(50)).toBe(
      'bestvideo[height<=144][ext=mp4]+bestaudio[ext=m4a]/best[height<=144][ext=mp4]/best',
    );
  });

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

  it('extracts playlist metadata and tracks via getPlaylistDetails', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout, stderr });
    const ytdlp = new YtDlp('yt-dlp', 'm4a');
    const runSpy = vi
      .spyOn(ytdlp as unknown as { run: (args: string[]) => Promise<string> }, 'run')
      .mockResolvedValueOnce(
        JSON.stringify({
          id: 'PLabc123',
          title: 'Sertanejo Top',
          description: 'Modão e universitário',
          playlist_count: 2,
          thumbnails: [{ url: 'https://img.test/pl-sm.jpg', width: 120 }, { url: 'https://img.test/pl-lg.jpg', width: 640 }],
          entries: [
            { id: 'aaaaaaaaaaa', title: 'Evidências', channel: 'Chitãozinho', duration: 279 },
            { id: 'bbbbbbbbbbb', title: 'Boate Azul', channel: 'Bruno & Marrone', duration: 210 },
          ],
        }),
      );
    void child;

    const details = await ytdlp.getPlaylistDetails('https://www.youtube.com/playlist?list=PLabc123', 50);
    expect(runSpy).toHaveBeenCalledWith([
      'https://www.youtube.com/playlist?list=PLabc123',
      '--flat-playlist',
      '-J',
      '--playlist-end',
      '50',
    ]);
    expect(details).toMatchObject({
      title: 'Sertanejo Top',
      description: 'Modão e universitário',
      thumbnail: 'https://img.test/pl-lg.jpg',
      totalCount: 2,
    });
    expect(details.tracks).toHaveLength(2);
    expect(details.tracks[0]).toMatchObject({ source: 'youtube', sourceId: 'aaaaaaaaaaa', title: 'Evidências' });
  });
});
