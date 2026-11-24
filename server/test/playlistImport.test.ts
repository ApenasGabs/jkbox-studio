import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { FetchFn } from '../src/services/spotify.js';
import type { SearchResult } from '../src/types.js';
import { setup, ytResult } from './helpers.js';

const SPOTIFY_ENV = {
  SPOTIFY_CLIENT_ID: 'cid',
  SPOTIFY_CLIENT_SECRET: 'secret',
  PUBLIC_URL: 'http://192.168.0.10:3000',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeSpotifyPlaylistFetch(options: {
  playlists?: Record<
    string,
    {
      status?: number;
      name?: string;
      description?: string | null;
      images?: { url: string; width?: number }[];
      total?: number;
      tracks?: {
        id: string;
        name: string;
        artist: string;
        album?: string;
        durationMs?: number;
        cover?: string;
      }[];
    }
  >;
  itunesGenres?: Record<string, string>;
} = {}): FetchFn {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/token')) {
      return jsonResponse({ access_token: 'app-token', expires_in: 3600 });
    }
    if (url.includes('itunes.apple.com/search')) {
      const parsed = new URL(url);
      const term = (parsed.searchParams.get('term') ?? '').toLowerCase();
      for (const [needle, genre] of Object.entries(options.itunesGenres ?? {})) {
        if (term.includes(needle.toLowerCase())) {
          return jsonResponse({
            results: [{ artistName: needle, primaryGenreName: genre, releaseDate: '2018-05-01T00:00:00Z' }],
          });
        }
      }
      return jsonResponse({ results: [] });
    }
    const itemsMatch = url.match(/\/v1\/playlists\/([^/]+)\/items/);
    if (itemsMatch) {
      const id = decodeURIComponent(itemsMatch[1]);
      const pl = options.playlists?.[id];
      if (!pl) return jsonResponse({ error: { message: 'Not found' } }, 404);
      if (pl.status && pl.status >= 400) {
        return jsonResponse({ error: { message: 'Access denied' } }, pl.status);
      }
      const tracks = pl.tracks ?? [];
      return jsonResponse({
        total: pl.total ?? tracks.length,
        next: null,
        items: tracks.map((t) => ({
          item: {
            id: t.id,
            uri: `spotify:track:${t.id}`,
            name: t.name,
            duration_ms: t.durationMs ?? 200_000,
            artists: [{ name: t.artist }],
            album: {
              name: t.album ?? 'Álbum Teste',
              images: [{ url: t.cover ?? `https://img.test/${t.id}.jpg`, width: 640 }],
            },
            type: 'track',
          },
        })),
      });
    }
    const metaMatch = url.match(/\/v1\/playlists\/([^/?]+)/);
    if (metaMatch) {
      const id = decodeURIComponent(metaMatch[1]);
      const pl = options.playlists?.[id];
      if (!pl) return jsonResponse({ error: { message: 'Not found' } }, 404);
      if (pl.status && pl.status >= 400) {
        return jsonResponse({ error: { message: 'Access denied' } }, pl.status);
      }
      return jsonResponse({
        id,
        name: pl.name ?? `Playlist ${id}`,
        description: pl.description ?? null,
        images: pl.images ?? [{ url: `https://img.test/pl-${id}.jpg`, width: 640 }],
        tracks: { total: pl.total ?? pl.tracks?.length ?? 0 },
      });
    }
    if (url.includes('/v1/search')) {
      return jsonResponse({ artists: { items: [] }, tracks: { items: [] } });
    }
    return jsonResponse({ error: { message: 'not found' } }, 404);
  }) as unknown as FetchFn;
}

describe('POST /api/playlists/import', () => {
  it('validates input URLs and maps 400, 404, 422, and 503 errors cleanly', async () => {
    const fetchFn = makeSpotifyPlaylistFetch({
      playlists: {
        privatePl: { status: 403 },
        missingPl: { status: 404 },
        emptyPl: { name: 'Vazia', tracks: [] },
        hugePl: { name: 'Gigante', total: 55, tracks: [] },
      },
    });
    const ctx = setup(SPOTIFY_ENV, fetchFn);
    const app = createApp({ config: ctx.config, jukebox: ctx.jukebox });

    // 400: missing, non-playlist, single track, invalid domain
    await request(app).post('/api/playlists/import').send({}).expect(400);
    await request(app).post('/api/playlists/import').send({ url: 'churrasco pagode' }).expect(400);
    await request(app).post('/api/playlists/import').send({ url: 'https://youtu.be/dQw4w9WgXcQ' }).expect(400);
    await request(app).post('/api/playlists/import').send({ url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC' }).expect(400);
    await request(app).post('/api/playlists/import').send({ url: 'https://example.com/playlist?list=123' }).expect(400);

    // 404: private / non-existent Spotify playlists, albums & YouTube playlists
    await request(app).post('/api/playlists/import').send({ url: 'https://open.spotify.com/album/abc123' }).expect(404);
    await request(app).post('/api/playlists/import').send({ url: 'https://open.spotify.com/playlist/privatePl' }).expect(404);
    await request(app).post('/api/playlists/import').send({ url: 'https://open.spotify.com/playlist/missingPl' }).expect(404);

    vi.spyOn(ctx.media, 'getPlaylistDetails').mockRejectedValueOnce(new Error('ERROR: [youtube:tab] PLpriv: This playlist is private.'));
    await request(app).post('/api/playlists/import').send({ url: 'https://www.youtube.com/playlist?list=PLpriv' }).expect(404);

    // 422: empty & > MAX_BATCH (50)
    await request(app).post('/api/playlists/import').send({ url: 'https://open.spotify.com/playlist/emptyPl' }).expect(422);
    await request(app).post('/api/playlists/import').send({ url: 'https://open.spotify.com/playlist/hugePl' }).expect(422);

    vi.spyOn(ctx.media, 'getPlaylistDetails').mockResolvedValueOnce({
      title: 'YT Vazia',
      tracks: [],
      totalCount: 0,
    });
    await request(app).post('/api/playlists/import').send({ url: 'https://www.youtube.com/playlist?list=PLempty' }).expect(422);

    vi.spyOn(ctx.media, 'getPlaylistDetails').mockResolvedValueOnce({
      title: 'YT Grande',
      totalCount: 51,
      tracks: Array.from({ length: 51 }, (_, i) => ytResult(`yt${String(i).padStart(9, '0')}`)),
    });
    await request(app).post('/api/playlists/import').send({ url: 'https://www.youtube.com/playlist?list=PLbig' }).expect(422);

    // 503: Spotify not configured
    const unconfigured = setup();
    const unconfiguredApp = createApp({ config: unconfigured.config, jukebox: unconfigured.jukebox });
    await request(unconfiguredApp)
      .post('/api/playlists/import')
      .send({ url: 'https://open.spotify.com/playlist/pl1' })
      .expect(503);
  });

  it('imports a YouTube playlist, deduplicates queue, downloads video-first in background without blocking, and is idempotent', async () => {
    const ctx = setup({}, makeSpotifyPlaylistFetch({ itunesGenres: { 'Zeca Pagodinho': 'Samba' } }));
    const app = createApp({ config: ctx.config, jukebox: ctx.jukebox });

    // Pre-cache one track and pre-enqueue it to test alreadyCached + queue deduplication
    const cachedTrack = ctx.jukebox.tracks.upsertFromResult({
      source: 'youtube',
      sourceId: 'yt000000001',
      title: 'Deixa a Vida Me Levar',
      artist: 'Zeca Pagodinho',
      durationSec: 210,
      thumbnail: 'https://img.test/zeca.jpg',
    });
    const cachedFile = path.join(ctx.config.musicDir, `${cachedTrack.id}.m4a`);
    const cachedVideo = path.join(ctx.config.musicDir, `${cachedTrack.id}.video.mp4`);
    fs.writeFileSync(cachedFile, Buffer.alloc(64, 1));
    fs.writeFileSync(cachedVideo, Buffer.alloc(64, 2));
    ctx.jukebox.tracks.update(cachedTrack.id, {
      status: 'ready',
      progress: 1,
      filePath: cachedFile,
      videoPath: cachedVideo,
    });
    ctx.jukebox.queue.enqueue(cachedTrack.id, 'guest-1', 'Lucas');

    vi.spyOn(ctx.media, 'getPlaylistDetails').mockResolvedValue({
      title: 'Churrasco Samba & Rock',
      description: 'Clássicos de domingo',
      thumbnail: 'https://img.test/yt-cover.jpg',
      totalCount: 3,
      tracks: [
        {
          source: 'youtube',
          sourceId: 'yt000000001',
          title: 'Deixa a Vida Me Levar',
          artist: 'Zeca Pagodinho',
          durationSec: 210,
        },
        {
          source: 'youtube',
          sourceId: 'yt000000002',
          title: 'Tempo Perdido',
          artist: 'Legião Urbana',
          durationSec: 300,
          thumbnail: 'https://img.test/legiao.jpg',
        },
        {
          source: 'youtube',
          sourceId: 'yt_private_',
          title: '[Private video]',
          artist: '',
        },
      ],
    });

    // Hold downloads so we verify HTTP response does not wait for download completion
    ctx.media.hold();
    const res = await request(app)
      .post('/api/playlists/import')
      .send({
        url: 'https://www.youtube.com/playlist?list=PLchurrasco1',
        clientId: 'guest-2',
        name: 'Maria',
      })
      .expect(201);

    expect(res.body).toMatchObject({
      created: true,
      imported: 2,
      alreadyCached: 1,
      queued: 1,
      downloading: 1,
      skipped: 2, // 1 private video + 1 already in queue
      playlist: {
        name: 'Churrasco Samba & Rock',
        description: 'Clássicos de domingo',
        source: 'youtube',
        sourceId: 'PLchurrasco1',
        thumbnail: 'https://img.test/yt-cover.jpg',
        cover: 'https://img.test/yt-cover.jpg',
        trackCount: 2,
      },
    });
    expect(res.body.tracks).toHaveLength(2);

    // Release background downloads and wait for downloads + classifier
    ctx.media.release();
    await ctx.jukebox.downloads.idle();
    await ctx.jukebox.classificationIdle();

    expect(ctx.media.downloads).toEqual(['yt000000002']);
    expect(ctx.media.videoDownloads).toEqual(['yt000000002']);

    const downloadedTrack = ctx.jukebox.tracks.findBySource('youtube', 'yt000000002')!;
    expect(downloadedTrack).toMatchObject({
      status: 'ready',
      genre: 'Rock',
      subgenre: 'Rock Nacional',
    });
    expect(downloadedTrack.videoPath).toBeTruthy();
    expect(fs.existsSync(downloadedTrack.videoPath!)).toBe(true);

    // Playlist appears in GET /api/playlists and GET /api/playlists/:id
    const listRes = await request(app).get('/api/playlists').expect(200);
    expect(listRes.body.playlists).toEqual([
      expect.objectContaining({
        id: res.body.playlist.id,
        source: 'youtube',
        sourceId: 'PLchurrasco1',
        trackCount: 2,
      }),
    ]);

    // Idempotent re-import of the same URL does not create a second playlist or duplicate tracks
    const reimport = await request(app)
      .post('/api/playlists/import')
      .send({ url: 'https://music.youtube.com/playlist?list=PLchurrasco1' })
      .expect(200);

    expect(reimport.body).toMatchObject({
      created: false,
      imported: 2,
      alreadyCached: 2,
      queued: 0,
      downloading: 0,
      playlist: {
        id: res.body.playlist.id,
        trackCount: 2,
      },
    });
    const listAfter = await request(app).get('/api/playlists').expect(200);
    expect(listAfter.body.playlists).toHaveLength(1);
  });

  it('imports a Spotify playlist, resolves video-first YouTube clips, and respects genre_manual = 1', async () => {
    const fetchFn = makeSpotifyPlaylistFetch({
      playlists: {
        spRock90: {
          name: 'Rock & Pagode Mix',
          description: 'Playlist importada do Spotify',
          images: [{ url: 'https://img.test/sp-cover.jpg', width: 640 }],
          tracks: [
            {
              id: 'spTrackVideo',
              name: 'Numb',
              artist: 'Linkin Park',
              durationMs: 185_000,
              cover: 'https://img.test/numb.jpg',
            },
            {
              id: 'spTrackManual',
              name: 'Evidências',
              artist: 'Chitãozinho & Xororó',
              durationMs: 279_000,
              cover: 'https://img.test/evid.jpg',
            },
          ],
        },
      },
      itunesGenres: {
        'Linkin Park': 'Rock',
        'Chitãozinho': 'Sertanejo',
      },
    });

    const ctx = setup(SPOTIFY_ENV, fetchFn);
    const app = createApp({ config: ctx.config, jukebox: ctx.jukebox });

    // Pre-create spTrackManual with manual genre lock (genre_manual = 1)
    const locked = ctx.jukebox.tracks.upsertFromResult({
      source: 'spotify',
      sourceId: 'spTrackManual',
      title: 'Evidências',
      artist: 'Chitãozinho & Xororó',
      durationSec: 279,
      spotifyUri: 'spotify:track:spTrackManual',
    });
    ctx.jukebox.tracks.update(locked.id, {
      genre: 'MPB',
      subgenre: 'MPB Clássica',
      genreManual: true,
    });

    // Ensure resolveYoutubeId prioritizes Official Music Video over Official Audio
    vi.spyOn(ctx.media, 'search').mockImplementation(async (query: string): Promise<SearchResult[]> => {
      if (query.includes('Numb') && query.includes('official video')) {
        return [
          {
            source: 'youtube',
            sourceId: 'vidAudioOnly',
            title: 'Linkin Park - Numb (Official Audio)',
            artist: 'Linkin Park - Topic',
            durationSec: 185,
          },
          {
            source: 'youtube',
            sourceId: 'vidClipClip1',
            title: 'Linkin Park - Numb (Official Music Video)',
            artist: 'Linkin Park',
            durationSec: 187,
          },
        ];
      }
      if (query.includes('Evidências') && query.includes('official video')) {
        return [
          {
            source: 'youtube',
            sourceId: 'vidEvidClip1',
            title: 'Chitãozinho & Xororó - Evidências (Clipe Oficial)',
            artist: 'Chitãozinho & Xororó',
            durationSec: 280,
          },
        ];
      }
      return [ytResult('fallback001', query, 'Artist')];
    });

    const res = await request(app)
      .post('/api/playlists/import')
      .send({
        url: 'https://open.spotify.com/intl-pt/playlist/spRock90?si=share123',
        clientId: 'remote-1',
        name: 'Gabi',
      })
      .expect(201);

    expect(res.body).toMatchObject({
      created: true,
      imported: 2,
      alreadyCached: 0,
      queued: 2,
      downloading: 2,
      skipped: 0,
      playlist: {
        name: 'Rock & Pagode Mix',
        source: 'spotify',
        sourceId: 'spRock90',
        cover: 'https://img.test/sp-cover.jpg',
        trackCount: 2,
      },
    });

    await ctx.jukebox.downloads.idle();
    await ctx.jukebox.classificationIdle();

    // Video-first resolution picked official music videos for both Spotify tracks
    expect(ctx.media.downloads).toContain('vidClipClip1');
    expect(ctx.media.downloads).not.toContain('vidAudioOnly');
    expect(ctx.media.videoDownloads).toContain('vidClipClip1');
    expect(ctx.media.videoDownloads).toContain('vidEvidClip1');

    const numbTrack = ctx.jukebox.tracks.findBySource('spotify', 'spTrackVideo')!;
    expect(numbTrack).toMatchObject({
      status: 'ready',
      youtubeId: 'vidClipClip1',
      genre: 'Rock',
    });
    expect(numbTrack.videoPath).toBeTruthy();

    // genre_manual = 1 must NOT be overwritten by auto-categorization
    const manualTrack = ctx.jukebox.tracks.get(locked.id)!;
    expect(manualTrack).toMatchObject({
      genre: 'MPB',
      subgenre: 'MPB Clássica',
      genreManual: true,
    });
  });

  it('disambiguates colliding playlist names across different external sources without 409', async () => {
    const ctx = setup();
    const app = createApp({ config: ctx.config, jukebox: ctx.jukebox });

    ctx.jukebox.playlists!.create({ name: 'Top Hits' });
    vi.spyOn(ctx.media, 'getPlaylistDetails').mockResolvedValue({
      title: 'Top Hits',
      totalCount: 1,
      tracks: [ytResult('ccccccccccc', 'Track C', 'Artist C')],
    });

    const imported = await request(app)
      .post('/api/playlists/import')
      .send({ url: 'https://www.youtube.com/playlist?list=PLtophits99' })
      .expect(201);

    expect(imported.body.playlist.name).toBe('Top Hits (2)');
    expect(imported.body.playlist.source).toBe('youtube');
    expect(imported.body.playlist.sourceId).toBe('PLtophits99');
  });
});
