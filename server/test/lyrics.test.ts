import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { attachRealtime } from '../src/realtime.js';
import { LyricsService, pickBestMatch, sanitizeTrackMetadata } from '../src/services/lyrics.js';
import type { FetchFn } from '../src/services/spotify.js';
import { TrackRepository } from '../src/services/tracks.js';
import { setup, tempConfig, ytResult } from './helpers.js';

let server: http.Server | null = null;
afterEach(
  () =>
    new Promise<void>((resolve) => {
      if (!server) return resolve();
      const current = server;
      server = null;
      current.close(() => resolve());
    }),
);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function nextMessage(ws: WebSocket, predicate: (msg: any) => boolean): Promise<any> {
  return new Promise((resolve) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(String(raw));
      if (predicate(msg)) {
        ws.off('message', onMessage);
        resolve(msg);
      }
    };
    ws.on('message', onMessage);
  });
}

describe('lyrics service and API', () => {
  it('migrates an existing v1 database to v2 with the lyrics table without losing tracks', () => {
    const config = tempConfig();
    const legacy = new DatabaseSync(config.dbPath);
    legacy.exec(`
      CREATE TABLE tracks (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL DEFAULT '',
        album TEXT,
        duration_sec INTEGER,
        thumbnail TEXT,
        youtube_id TEXT,
        spotify_uri TEXT,
        file_path TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        progress REAL NOT NULL DEFAULT 0,
        error TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE (source, source_id)
      );
      INSERT INTO tracks (id, source, source_id, title, artist, created_at)
      VALUES ('t-legacy', 'youtube', 'dQw4w9WgXcQ', 'Never Gonna Give You Up', 'Rick Astley', 1000);
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const db = openDb(config.dbPath);
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    expect(version).toBe(5);

    const tracks = new TrackRepository(db);
    expect(tracks.get('t-legacy')?.title).toBe('Never Gonna Give You Up');
    expect(tracks.get('t-legacy')?.videoPath).toBeNull();
    const cols = db.prepare('PRAGMA table_info(lyrics)').all() as { name: string }[];
    expect(cols.map((c) => c.name)).toEqual([
      'track_id',
      'synced_lrc',
      'plain_lyrics',
      'instrumental',
      'source',
      'offset_ms',
      'fetched_at',
    ]);
    db.close();
  });

  it('sanitizes YouTube titles and artist suffixes cleanly', () => {
    expect(sanitizeTrackMetadata('Daft Punk - One More Time (Official Video) [HD]', 'DaftPunkVEVO')).toEqual({
      title: 'One More Time',
      artist: 'Daft Punk',
    });
    expect(sanitizeTrackMetadata('Blinding Lights (Official Audio) (Lyrics)', 'The Weeknd - Topic')).toEqual({
      title: 'Blinding Lights',
      artist: 'The Weeknd',
    });
    expect(sanitizeTrackMetadata('Believer [4K] feat. Someone', 'Imagine Dragons Official')).toEqual({
      title: 'Believer',
      artist: 'Imagine Dragons',
    });
    expect(sanitizeTrackMetadata('Another Brick in the Wall - Part 2 (Remastered 2011)', 'Pink Floyd')).toEqual({
      title: 'Another Brick in the Wall - Part 2',
      artist: 'Pink Floyd',
    });
  });

  it('picks the best LRCLIB search candidate by synced availability, title, artist, and duration', () => {
    const match = pickBestMatch(
      [
        { id: 1, trackName: 'One More Time', artistName: 'Daft Punk', duration: 320, plainLyrics: 'Plain only' },
        {
          id: 2,
          trackName: 'One More Time (Live)',
          artistName: 'Daft Punk',
          duration: 580,
          syncedLyrics: '[00:01.00] Live',
        },
        {
          id: 3,
          trackName: 'One More Time',
          artistName: 'Daft Punk',
          duration: 321,
          syncedLyrics: '[00:10.00] One more time',
        },
      ],
      'One More Time',
      'Daft Punk',
      320,
    );
    expect(match?.id).toBe(3);
  });

  it('prioritizes local .lrc sidecar files over LRCLIB and caches the result', async () => {
    const fetchFn = vi.fn(async () => json({ error: 'should not be called' }, 500)) as unknown as FetchFn;
    const { config, jukebox } = setup({}, fetchFn);
    const app = createApp({ config, jukebox });

    const trackDir = path.join(config.musicDir, 'rock');
    fs.mkdirSync(trackDir, { recursive: true });
    const audioPath = path.join(trackDir, 'Queen - Bohemian Rhapsody.mp3');
    const lrcPath = path.join(trackDir, 'Queen - Bohemian Rhapsody.lrc');
    fs.writeFileSync(audioPath, 'audio');
    fs.writeFileSync(lrcPath, '[ti:Bohemian Rhapsody]\n[00:01.50] Is this the real life?\n[00:04.20] Is this just fantasy?\n');

    const track = jukebox.tracks.insertLocal(audioPath, { title: 'Bohemian Rhapsody', artist: 'Queen' });

    const res = await request(app).get(`/api/tracks/${track.id}/lyrics`).expect(200);
    expect(res.body).toMatchObject({
      trackId: track.id,
      source: 'local',
      instrumental: false,
      offsetMs: 0,
      plainLyrics: 'Is this the real life?\nIs this just fantasy?',
    });
    expect(res.body.syncedLrc).toContain('[00:01.50] Is this the real life?');
    expect(fetchFn).not.toHaveBeenCalled();

    // Remove the file on disk to prove subsequent reads are served from SQLite cache.
    fs.unlinkSync(lrcPath);
    const cached = await request(app).get(`/api/tracks/${track.id}/lyrics`).expect(200);
    expect(cached.body.source).toBe('local');
    expect(cached.body.syncedLrc).toContain('[00:01.50]');
  });

  it('fetches from LRCLIB /api/get with User-Agent, caches in SQLite, and avoids repeat external calls', async () => {
    const calls: { url: string; userAgent: string | null; hasSignal: boolean }[] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      const headers = new Headers(init.headers);
      calls.push({ url, userAgent: headers.get('User-Agent'), hasSignal: Boolean(init.signal) });
      return json({
        id: 10,
        trackName: 'One More Time',
        artistName: 'Daft Punk',
        duration: 320,
        instrumental: false,
        syncedLyrics: '[00:12.34] One more time',
        plainLyrics: 'One more time',
      });
    }) as unknown as FetchFn;

    const { config, jukebox } = setup({}, fetchFn);
    const app = createApp({ config, jukebox });
    const track = jukebox.tracks.upsertFromResult({
      ...ytResult('dQw4w9WgXcQ', 'Daft Punk - One More Time (Official Video)', 'DaftPunkVEVO'),
      album: 'Discovery',
      durationSec: 320,
    });

    const first = await request(app).get(`/api/tracks/${track.id}/lyrics`).expect(200);
    expect(first.body).toMatchObject({
      trackId: track.id,
      source: 'lrclib',
      syncedLrc: '[00:12.34] One more time',
      plainLyrics: 'One more time',
      instrumental: false,
      offsetMs: 0,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].userAgent).toBe('jkbox-studio/0.1.0 (https://github.com/ApenasGabs/jkbox-studio)');
    expect(calls[0].hasSignal).toBe(true);
    const parsed = new URL(calls[0].url);
    expect(parsed.pathname).toBe('/api/get');
    expect(parsed.searchParams.get('track_name')).toBe('One More Time');
    expect(parsed.searchParams.get('artist_name')).toBe('Daft Punk');
    expect(parsed.searchParams.get('album_name')).toBe('Discovery');
    expect(parsed.searchParams.get('duration')).toBe('320');

    // Second request uses SQLite cache without calling fetch again.
    const second = await request(app).get(`/api/tracks/${track.id}/lyrics`).expect(200);
    expect(second.body.syncedLrc).toBe('[00:12.34] One more time');
    expect(calls).toHaveLength(1);
  });

  it('falls back to /api/search on 404 and caches negative results when nothing matches', async () => {
    const urls: string[] = [];
    let mode: 'fallback-hit' | 'miss' = 'fallback-hit';
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/api/get')) return json({ statusCode: 404, message: 'Not found' }, 404);
      if (url.includes('/api/search')) {
        if (mode === 'miss') return json([]);
        return json([
          {
            id: 99,
            trackName: 'Digital Love',
            artistName: 'Daft Punk',
            duration: 301,
            syncedLyrics: '[00:05.00] Last night I had a dream about you',
            plainLyrics: 'Last night I had a dream about you',
          },
        ]);
      }
      return json({}, 404);
    }) as unknown as FetchFn;

    const { config, jukebox } = setup({}, fetchFn);
    const app = createApp({ config, jukebox });

    const hitTrack = jukebox.tracks.upsertFromResult({
      ...ytResult('aaaaaaaaaaa', 'Digital Love (Lyrics)', 'Daft Punk - Topic'),
      durationSec: 300,
    });
    const hitRes = await request(app).get(`/api/tracks/${hitTrack.id}/lyrics`).expect(200);
    expect(hitRes.body.source).toBe('lrclib');
    expect(hitRes.body.syncedLrc).toContain('Last night I had a dream about you');
    expect(urls.map((u) => new URL(u).pathname)).toEqual(['/api/get', '/api/search']);

    // Negative cache test: 404 + empty search caches source='none' so second call skips LRCLIB.
    mode = 'miss';
    urls.length = 0;
    const missTrack = jukebox.tracks.upsertFromResult(ytResult('bbbbbbbbbbb', 'Unknown Instrumental Jam', 'Nobody'));
    const miss1 = await request(app).get(`/api/tracks/${missTrack.id}/lyrics`).expect(200);
    expect(miss1.body).toMatchObject({ trackId: missTrack.id, source: 'none', syncedLrc: null, plainLyrics: null });
    expect(urls).toHaveLength(2);

    const miss2 = await request(app).get(`/api/tracks/${missTrack.id}/lyrics`).expect(200);
    expect(miss2.body.source).toBe('none');
    expect(urls).toHaveLength(2);
  });

  it('does not cache transient network failures and retries on subsequent calls', async () => {
    let fail = true;
    const fetchFn = vi.fn(async () => {
      if (fail) throw new Error('network down');
      return json({
        syncedLyrics: '[00:01.00] Back online',
        plainLyrics: 'Back online',
      });
    }) as unknown as FetchFn;

    const { config, jukebox } = setup({}, fetchFn);
    const app = createApp({ config, jukebox });
    const track = jukebox.tracks.upsertFromResult(ytResult('ccccccccccc', 'Recovering Song', 'Artist'));

    const first = await request(app).get(`/api/tracks/${track.id}/lyrics`).expect(200);
    expect(first.body.source).toBe('none');
    expect(jukebox.lyrics.getCached(track.id)).toBeNull();

    fail = false;
    const second = await request(app).get(`/api/tracks/${track.id}/lyrics`).expect(200);
    expect(second.body.source).toBe('lrclib');
    expect(second.body.syncedLrc).toBe('[00:01.00] Back online');
  });

  it('supports PATCH offset (host-protected + WS broadcast) and DELETE cache clear + 404 for missing track', async () => {
    let version = 1;
    const fetchFn = vi.fn(async () =>
      json({
        syncedLyrics: `[00:01.00] Line v${version}`,
        plainLyrics: `Line v${version}`,
      }),
    ) as unknown as FetchFn;

    const { config, jukebox } = setup({ HOST_PIN: '4321' }, fetchFn);
    const app = createApp({ config, jukebox });
    server = http.createServer(app);
    const wss = attachRealtime(server, jukebox);
    await new Promise<void>((r) => server!.listen(0, r));
    const wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
    const client = new WebSocket(wsUrl);
    await nextMessage(client, (m) => m.type === 'state');

    await request(app).get('/api/tracks/nonexistent/lyrics').expect(404);
    await request(app).patch('/api/tracks/nonexistent/lyrics/offset').set('x-host-pin', '4321').send({ offsetMs: 100 }).expect(404);
    await request(app).delete('/api/tracks/nonexistent/lyrics').set('x-host-pin', '4321').expect(404);

    const track = jukebox.tracks.upsertFromResult(ytResult('ddddddddddd', 'Sync Song', 'Band'));
    await request(app).get(`/api/tracks/${track.id}/lyrics`).expect(200);

    // Host PIN enforcement & validation
    await request(app).patch(`/api/tracks/${track.id}/lyrics/offset`).send({ offsetMs: 500 }).expect(403);
    await request(app).delete(`/api/tracks/${track.id}/lyrics`).expect(403);
    await request(app)
      .patch(`/api/tracks/${track.id}/lyrics/offset`)
      .set('x-host-pin', '4321')
      .send({ offsetMs: 'bad' })
      .expect(400);

    const wsEvent = nextMessage(client, (m) => m.type === 'lyrics_offset');
    const patched = await request(app)
      .patch(`/api/tracks/${track.id}/lyrics/offset`)
      .set('x-host-pin', '4321')
      .send({ offsetMs: -1250 })
      .expect(200);
    expect(patched.body.offsetMs).toBe(-1250);
    expect(await wsEvent).toEqual({ type: 'lyrics_offset', trackId: track.id, offsetMs: -1250 });

    // Clear cache and force re-fetch
    await request(app).delete(`/api/tracks/${track.id}/lyrics`).set('x-host-pin', '4321').expect(204);
    version = 2;
    const refetched = await request(app).get(`/api/tracks/${track.id}/lyrics`).expect(200);
    expect(refetched.body.syncedLrc).toBe('[00:01.00] Line v2');
    expect(refetched.body.offsetMs).toBe(0);

    client.close();
    wss.close();
  });

  it('coalesces concurrent lookups for the same track into one LRCLIB request', async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return json({ syncedLyrics: '[00:02.00] Coalesced', plainLyrics: 'Coalesced' });
    }) as unknown as FetchFn;

    const { config, jukebox } = setup({}, fetchFn);
    const db = openDb(config.dbPath);
    const service = new LyricsService(db, config.musicDir, fetchFn, () => {});
    const track = jukebox.tracks.upsertFromResult(ytResult('eeeeeeeeeee', 'Concurrent', 'Artist'));

    const [a, b, c] = await Promise.all([service.getForTrack(track), service.getForTrack(track), service.getForTrack(track)]);
    expect(calls).toBe(1);
    expect(a.syncedLrc).toBe('[00:02.00] Coalesced');
    expect(b.syncedLrc).toBe('[00:02.00] Coalesced');
    expect(c.syncedLrc).toBe('[00:02.00] Coalesced');
    db.close();
  });
});
