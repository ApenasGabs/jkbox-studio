import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  buildAudioFormatSelector,
  buildVideoFormatSelector,
  entryToResult,
  parseProgressLine,
  resolveTempDir,
  YtDlp,
} from '../src/services/ytdlp.js';

describe('yt-dlp helpers', () => {
  it('builds video-only mp4 format selector using max height without audio muxing', () => {
    expect(buildVideoFormatSelector(720)).toBe(
      'bestvideo[height<=720][ext=mp4][vcodec^=avc1]/bestvideo[height<=720][ext=mp4]/best[height<=720][ext=mp4]',
    );
    expect(buildVideoFormatSelector(480)).toBe(
      'bestvideo[height<=480][ext=mp4][vcodec^=avc1]/bestvideo[height<=480][ext=mp4]/best[height<=480][ext=mp4]',
    );
    expect(buildVideoFormatSelector(50)).toBe(
      'bestvideo[height<=144][ext=mp4][vcodec^=avc1]/bestvideo[height<=144][ext=mp4]/best[height<=144][ext=mp4]',
    );
  });

  it('builds audio format selectors prioritizing native stream copy', () => {
    expect(buildAudioFormatSelector('m4a')).toBe('bestaudio[ext=m4a]/bestaudio/best');
    expect(buildAudioFormatSelector('opus')).toBe('bestaudio[acodec=opus]/bestaudio/best');
    expect(buildAudioFormatSelector('mp3')).toBe('bestaudio/best');
  });

  it('resolves fast temp directory in /tmp when available', () => {
    const tempDir = resolveTempDir();
    expect(tempDir).toBe(fs.existsSync('/tmp') ? '/tmp/jkbox-ytdlp' : expect.any(String));
  });

  it('invokes audio download with native selector, -N 4, temp paths, and no thumbnail embedding', async () => {
    const ytdlp = new YtDlp('yt-dlp', 'm4a');
    const runSpy = vi
      .spyOn(ytdlp as unknown as { run: (args: string[], onLine?: (l: string) => void) => Promise<string> }, 'run')
      .mockImplementation(async (_args, onLine) => {
        onLine?.('jkbox-progress:50:100:NA');
        onLine?.('/data/music/track-1.m4a');
        return '';
      });
    const onProgress = vi.fn();

    const result = await ytdlp.download('dQw4w9WgXcQ', '/data/music/track-1', onProgress);

    expect(result).toEqual({ filePath: '/data/music/track-1.m4a' });
    expect(onProgress).toHaveBeenCalledWith(0.5);
    const args = runSpy.mock.calls[0]?.[0] ?? [];
    expect(args).toContain('-N');
    expect(args[args.indexOf('-N') + 1]).toBe('4');
    expect(args).toContain('bestaudio[ext=m4a]/bestaudio/best');
    expect(args).toContain('home:/data/music');
    expect(args.some((a) => a.startsWith('temp:') && a.includes('jkbox-ytdlp'))).toBe(true);
    expect(args).toContain('track-1.%(ext)s');
    expect(args).not.toContain('--embed-thumbnail');
    expect(args).not.toContain('--convert-thumbnails');
  });

  it('invokes opus audio download with opus acodec selector', async () => {
    const ytdlp = new YtDlp('yt-dlp', 'opus');
    const runSpy = vi
      .spyOn(ytdlp as unknown as { run: (args: string[], onLine?: (l: string) => void) => Promise<string> }, 'run')
      .mockResolvedValue('');

    await ytdlp.download('dQw4w9WgXcQ', '/data/music/track-2', () => {});

    const args = runSpy.mock.calls[0]?.[0] ?? [];
    expect(args).toContain('bestaudio[acodec=opus]/bestaudio/best');
  });

  it('invokes video-only download with -N 4, temp paths, and no merge-output-format', async () => {
    const ytdlp = new YtDlp('yt-dlp', 'm4a');
    const runSpy = vi
      .spyOn(ytdlp as unknown as { run: (args: string[], onLine?: (l: string) => void) => Promise<string> }, 'run')
      .mockImplementation(async (_args, onLine) => {
        onLine?.('/data/music/track-1.video.mp4');
        return '';
      });

    const result = await ytdlp.downloadVideo('dQw4w9WgXcQ', '/data/music/track-1.video', 720, () => {});

    expect(result).toEqual({ filePath: '/data/music/track-1.video.mp4' });
    const args = runSpy.mock.calls[0]?.[0] ?? [];
    expect(args).toContain('-N');
    expect(args[args.indexOf('-N') + 1]).toBe('4');
    expect(args).toContain(buildVideoFormatSelector(720));
    expect(args).toContain('home:/data/music');
    expect(args.some((a) => a.startsWith('temp:') && a.includes('jkbox-ytdlp'))).toBe(true);
    expect(args).toContain('track-1.video.%(ext)s');
    expect(args).not.toContain('--merge-output-format');
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
