import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { LyricsService } from '../src/services/lyrics.js';
import type { FetchFn } from '../src/services/spotify.js';
import { TrackRepository } from '../src/services/tracks.js';
import type { Track } from '../src/types.js';
import { setup, tempConfig, ytResult } from './helpers.js';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function isLrclib(input: unknown): boolean {
  return String(input).startsWith('https://lrclib.net/');
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function readyTrack(tracks: TrackRepository, id: string, title: string): Track {
  const track = tracks.upsertFromResult(ytResult(id, title, 'Artist'));
  tracks.update(track.id, { status: 'ready', filePath: import.meta.filename });
  return tracks.get(track.id)!;
}

describe('offline lyrics prefetch (#64)', () => {
  it('prefetches and persists lyrics in background on download ready without blocking playback', async () => {
    const gate = deferred();
    const lrclibCalls: string[] = [];
    const fetchFn = vi.fn(async (input: unknown) => {
      if (!isLrclib(input)) return json({}, 404);
      lrclibCalls.push(String(input));
      await gate.promise;
      return json({ syncedLyrics: '[00:01.00] Offline party', plainLyrics: 'Offline party' });
    }) as unknown as FetchFn;

    const { jukebox } = setup({ LYRICS_PREFETCH: 'true', LYRICS_PREFETCH_INTERVAL_MS: '0' }, fetchFn);
    const track = jukebox.tracks.upsertFromResult(ytResult('aaaaaaaaaaa', 'Party Song', 'Artist'));
    jukebox.queue.enqueue(track.id, 'guest', 'Guest');
    jukebox.downloads.ensure(track.id);

    // Playback starts while the LRCLIB request is still pending.
    await vi.waitFor(() => expect(jukebox.queue.state().nowPlaying?.item.track.id).toBe(track.id));
    await vi.waitFor(() => expect(lrclibCalls.length).toBe(1));
    expect(jukebox.lyrics.getCached(track.id)).toBeNull();

    gate.resolve();
    await vi.waitFor(() => expect(jukebox.lyrics.getCached(track.id)?.syncedLrc).toBe('[00:01.00] Offline party'));
  });

  it('does not prefetch on download ready when LYRICS_PREFETCH=false', async () => {
    const fetchFn = vi.fn(async () => json({}, 404)) as unknown as FetchFn;
    const { jukebox } = setup({ LYRICS_PREFETCH: 'false' }, fetchFn);
    const track = jukebox.tracks.upsertFromResult(ytResult('bbbbbbbbbbb', 'Quiet Song', 'Artist'));
    const ready = new Promise<void>((resolve) => jukebox.downloads.once('ready', () => resolve()));
    jukebox.downloads.ensure(track.id);
    await ready;
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(fetchFn).mock.calls.filter(([input]) => isLrclib(input))).toHaveLength(0);
  });

  it('prefetches lyrics for already-cached tracks during playlist import', async () => {
    const fetchFn = vi.fn(async (input: unknown) =>
      isLrclib(input) ? json({ plainLyrics: 'Imported words' }) : json({}, 404),
    ) as unknown as FetchFn;
    const { jukebox } = setup({ LYRICS_PREFETCH: 'false', LYRICS_PREFETCH_INTERVAL_MS: '0' }, fetchFn);
    const cached = readyTrack(jukebox.tracks, 'aaaaaaaaaaa', 'Song aaaaaaaaaaa');
    jukebox.lyricsPrefetchEnabled = true;

    await jukebox.importPlaylist({ url: 'https://www.youtube.com/playlist?list=PLlyrics', enqueue: false });

    await vi.waitFor(() => expect(jukebox.lyrics.getCached(cached.id)?.plainLyrics).toBe('Imported words'));
  });

  it('skips HTTP for tracks that already have lyrics in SQLite', async () => {
    const fetchFn = vi.fn(async () => json({ plainLyrics: 'Fresh' })) as unknown as FetchFn;
    const config = tempConfig();
    const db = openDb(config.dbPath);
    const tracks = new TrackRepository(db);
    const service = new LyricsService(db, config.musicDir, fetchFn, () => {}, undefined, { minIntervalMs: 0 });
    const track = readyTrack(tracks, 'ccccccccccc', 'Known Song');

    expect(await service.prefetch(track)).toBe('found');
    expect(fetchFn).toHaveBeenCalledTimes(1);

    expect(await service.prefetch(track)).toBe('cached');
    const summary = await service.prefetchMissing([track]);
    expect(summary).toEqual({ total: 1, alreadyCached: 1, found: 0, empty: 0, transient: 0 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('backfill respects the concurrency limit and keeps transient failures out of the cache', async () => {
    let active = 0;
    let maxActive = 0;
    const fetchFn = vi.fn(async (input: unknown) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
      const url = String(input);
      if (url.includes('Offline')) throw new Error('network down');
      if (url.includes('Instrumental')) return json({ instrumental: true });
      if (url.includes('Nothing')) return url.includes('/search?') ? json([]) : json({}, 404);
      return json({ plainLyrics: 'La la la' });
    }) as unknown as FetchFn;

    const config = tempConfig();
    const db = openDb(config.dbPath);
    const tracks = new TrackRepository(db);
    const service = new LyricsService(db, config.musicDir, fetchFn, () => {}, undefined, {
      concurrency: 2,
      minIntervalMs: 0,
    });
    const list = [
      readyTrack(tracks, 'ddddddddddd', 'Song One'),
      readyTrack(tracks, 'eeeeeeeeeee', 'Song Two'),
      readyTrack(tracks, 'fffffffffff', 'Song Three'),
      readyTrack(tracks, 'ggggggggggg', 'Instrumental Jam'),
      readyTrack(tracks, 'hhhhhhhhhhh', 'Nothing Here'),
      readyTrack(tracks, 'iiiiiiiiiii', 'Offline Track'),
    ];

    const summary = await service.prefetchMissing(list);
    expect(summary).toEqual({ total: 6, alreadyCached: 0, found: 3, empty: 2, transient: 1 });
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBe(2);

    const offline = list[5];
    expect(service.getCached(offline.id)).toBeNull();
    expect(service.getCached(list[3].id)?.instrumental).toBe(true);
    expect(service.getCached(list[4].id)?.source).toBe('none');
  });

  it('spaces background lookups by the configured interval to respect LRCLIB rate limits', async () => {
    const starts: number[] = [];
    const fetchFn = vi.fn(async () => {
      starts.push(Date.now());
      return json({ plainLyrics: 'ok' });
    }) as unknown as FetchFn;
    const config = tempConfig();
    const db = openDb(config.dbPath);
    const tracks = new TrackRepository(db);
    const service = new LyricsService(db, config.musicDir, fetchFn, () => {}, undefined, {
      concurrency: 2,
      minIntervalMs: 40,
    });
    const list = [
      readyTrack(tracks, 'jjjjjjjjjjj', 'Paced One'),
      readyTrack(tracks, 'kkkkkkkkkkk', 'Paced Two'),
      readyTrack(tracks, 'lllllllllll', 'Paced Three'),
    ];
    await service.prefetchMissing(list);
    expect(starts).toHaveLength(3);
    expect(starts[2] - starts[0]).toBeGreaterThanOrEqual(70);
  });

  it('exposes a host-protected backfill endpoint returning the summary', async () => {
    const fetchFn = vi.fn(async (input: unknown) => {
      if (!isLrclib(input)) return json({}, 404);
      if (String(input).includes('Broken')) throw new Error('offline');
      return json({ syncedLyrics: '[00:01.00] Hi', plainLyrics: 'Hi' });
    }) as unknown as FetchFn;
    const { config, jukebox } = setup({ HOST_PIN: '4321', LYRICS_PREFETCH_INTERVAL_MS: '0' }, fetchFn);
    const app = createApp({ config, jukebox });
    readyTrack(jukebox.tracks, 'mmmmmmmmmmm', 'Good Song');
    const broken = readyTrack(jukebox.tracks, 'nnnnnnnnnnn', 'Broken Song');

    await request(app).post('/api/library/lyrics/prefetch').expect(403);
    const res = await request(app).post('/api/library/lyrics/prefetch').set('X-Host-Pin', '4321').expect(200);
    expect(res.body).toEqual({ total: 2, alreadyCached: 0, found: 1, empty: 0, transient: 1 });
    expect(jukebox.lyrics.getCached(broken.id)).toBeNull();
  });
});
