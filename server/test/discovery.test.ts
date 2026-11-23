import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createJukebox } from '../src/container.js';
import { normalizeTrackDedupeKey } from '../src/services/discovery.js';
import type { FetchFn } from '../src/services/spotify.js';
import { FakeMedia, tempConfig } from './helpers.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createFakeFetch(options: {
  deezerArtists?: Record<string, { id: number; name: string }[]>;
  deezerRelated?: Record<number, { id: number; name: string }[]>;
  deezerTop?: Record<number, { id: number; title: string; duration: number; artist: { id: number; name: string }; album: { title: string; cover_medium: string } }[]>;
  deezerTrackSearch?: Record<string, { id: number; title: string; duration: number; artist: { id: number; name: string }; album: { title: string; cover_medium: string } }[]>;
  spotifyTracks?: Record<string, { id: string; uri: string; name: string; duration_ms: number; artists: { id?: string; name: string }[]; album?: { name: string; images?: { url: string; width?: number }[] } }[]>;
  spotifyArtistGenres?: Record<string, string[]>;
  failDeezer?: boolean;
}) {
  const calls: string[] = [];

  const fetchFn: FetchFn = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);

    if (url.startsWith('https://api.deezer.com')) {
      if (options.failDeezer) return json({ error: { message: 'Deezer unavailable' } }, 503);
      const parsed = new URL(url);

      if (parsed.pathname === '/search/artist') {
        const q = (parsed.searchParams.get('q') ?? '').toLowerCase();
        const match = Object.entries(options.deezerArtists ?? {}).find(([k]) => q.includes(k.toLowerCase()));
        return json({ data: match ? match[1] : [] });
      }
      const relMatch = parsed.pathname.match(/^\/artist\/(\d+)\/related$/);
      if (relMatch) {
        return json({ data: options.deezerRelated?.[Number(relMatch[1])] ?? [] });
      }
      const topMatch = parsed.pathname.match(/^\/artist\/(\d+)\/top$/);
      if (topMatch) {
        return json({ data: options.deezerTop?.[Number(topMatch[1])] ?? [] });
      }
      if (parsed.pathname === '/search/track') {
        const q = (parsed.searchParams.get('q') ?? '').toLowerCase();
        const match = Object.entries(options.deezerTrackSearch ?? {}).find(([k]) => q.includes(k.toLowerCase()));
        return json({ data: match ? match[1] : [] });
      }
      return json({ data: [] });
    }

    if (url.startsWith('https://accounts.spotify.com/api/token')) {
      return json({ access_token: 'app-token', expires_in: 3600 });
    }

    if (url.startsWith('https://api.spotify.com/v1')) {
      const parsed = new URL(url);
      if (parsed.pathname.includes('/recommendations') || parsed.pathname.includes('/related-artists')) {
        return json({ error: { status: 403, message: 'Deprecated in dev mode' } }, 403);
      }
      if (parsed.pathname === '/v1/search') {
        const type = parsed.searchParams.get('type');
        const q = (parsed.searchParams.get('q') ?? '').toLowerCase();
        if (type === 'track') {
          const match = Object.entries(options.spotifyTracks ?? {}).find(([k]) => q.includes(k.toLowerCase()));
          return json({ tracks: { items: match ? match[1] : [] } });
        }
        if (type === 'artist') {
          const match = Object.entries(options.spotifyArtistGenres ?? {}).find(([k]) => q.includes(k.toLowerCase()));
          return json({
            artists: {
              items: match ? [{ id: 'sp-art', name: match[0], genres: match[1] }] : [],
            },
          });
        }
      }
      const trackMatch = parsed.pathname.match(/^\/v1\/tracks\/([^/]+)$/);
      if (trackMatch) {
        const id = decodeURIComponent(trackMatch[1]);
        const all = Object.values(options.spotifyTracks ?? {}).flat();
        const found = all.find((t) => t.id === id);
        if (found) return json(found);
      }
      return json({});
    }

    if (url.startsWith('https://itunes.apple.com/search')) {
      return json({ results: [] });
    }

    return json({}, 404);
  };

  return { fetchFn, calls };
}

function seedLocalTrack(
  jukebox: ReturnType<typeof createJukebox>,
  dir: string,
  meta: { title: string; artist: string; genre?: string | null; subgenre?: string | null },
) {
  const filePath = path.join(dir, `${meta.title.replace(/\W+/g, '_')}.mp3`);
  fs.writeFileSync(filePath, Buffer.alloc(128, 1));
  return jukebox.tracks.insertLocal(filePath, meta);
}

describe('DiscoveryService & /api/discovery', () => {
  it('normalizes artist + title deduplication keys across accents and video/live tags', () => {
    expect(normalizeTrackDedupeKey('Chitãozinho & Xororó - Topic', 'Evidências (Ao Vivo)')).toBe(
      normalizeTrackDedupeKey('Chitaozinho & Xororo', 'Evidencias [Official Video]'),
    );
    expect(normalizeTrackDedupeKey('Exaltasamba', 'Tá Vendo Aquela Lua (Official Audio)')).toBe(
      normalizeTrackDedupeKey('Exaltasamba', 'Ta Vendo Aquela Lua'),
    );
  });

  it('discovers similar tracks via Deezer -> Spotify enrichment without calling deprecated Spotify endpoints', async () => {
    const config = tempConfig({ SPOTIFY_CLIENT_ID: 'cid', SPOTIFY_CLIENT_SECRET: 'sec' });
    const media = new FakeMedia();
    const fake = createFakeFetch({
      deezerArtists: {
        exaltasamba: [{ id: 101, name: 'Exaltasamba' }],
      },
      deezerRelated: {
        101: [
          { id: 201, name: 'Raça Negra' },
          { id: 202, name: 'Sorriso Maroto' },
        ],
      },
      deezerTop: {
        101: [
          {
            id: 1001,
            title: 'Tá Vendo Aquela Lua',
            duration: 210,
            artist: { id: 101, name: 'Exaltasamba' },
            album: { title: '25 Anos', cover_medium: 'https://cdn.example/exalta.jpg' },
          },
          {
            id: 1002,
            title: 'Telegrama',
            duration: 240,
            artist: { id: 101, name: 'Exaltasamba' },
            album: { title: 'Luz do Desejo', cover_medium: 'https://cdn.example/telegrama.jpg' },
          },
        ],
        201: [
          {
            id: 2001,
            title: 'Cheia de Manias',
            duration: 205,
            artist: { id: 201, name: 'Raça Negra' },
            album: { title: 'Raça Negra', cover_medium: 'https://cdn.example/rn.jpg' },
          },
        ],
        202: [
          {
            id: 3001,
            title: 'Sinais',
            duration: 198,
            artist: { id: 202, name: 'Sorriso Maroto' },
            album: { title: 'Sinais', cover_medium: 'https://cdn.example/sm.jpg' },
          },
        ],
      },
      spotifyTracks: {
        'cheia de manias': [
          {
            id: 'spCheia1',
            uri: 'spotify:track:spCheia1',
            name: 'Cheia de Manias',
            duration_ms: 205_000,
            artists: [{ name: 'Raça Negra' }],
            album: { name: 'Raça Negra', images: [{ url: 'https://sp.example/rn.jpg', width: 640 }] },
          },
        ],
      },
      spotifyArtistGenres: {
        'raça negra': ['pagode'],
        'sorriso maroto': ['pagode'],
        exaltasamba: ['pagode'],
      },
    });

    const jukebox = createJukebox(config, {
      media,
      fetchFn: fake.fetchFn,
      log: () => {},
      externalClassifierLookup: true,
    });
    const app = createApp({ config, jukebox });

    // Local track already in library (with Ao Vivo suffix) -> must be deduplicated out!
    const existing = seedLocalTrack(jukebox, config.musicDir, {
      title: 'Tá Vendo Aquela Lua (Ao Vivo)',
      artist: 'Exaltasamba',
      genre: 'Samba & Pagode',
      subgenre: 'Pagode 90',
    });
    const playlist = jukebox.playlists!.create({ name: 'Pagodinho' });
    jukebox.playlists!.addTrack(playlist.id, existing.id);

    const res = await request(app)
      .post('/api/discovery/suggest')
      .send({ mode: 'playlist', playlistId: playlist.id, limit: 5 })
      .expect(200);

    expect(res.body.mode).toBe('playlist');
    expect(res.body.sourcesUsed).toContain('deezer');
    expect(res.body.sourcesUsed).toContain('spotify');

    const titles = res.body.suggestions.map((s: { title: string }) => s.title);
    expect(titles).not.toContain('Tá Vendo Aquela Lua');
    expect(titles).toContain('Cheia de Manias');
    expect(titles).toContain('Sinais');
    expect(titles).toContain('Telegrama');

    // Enriched with Spotify URI & auto-categorized
    const cheia = res.body.suggestions.find((s: { title: string }) => s.title === 'Cheia de Manias');
    expect(cheia).toMatchObject({
      source: 'spotify',
      sourceId: 'spCheia1',
      spotifyUri: 'spotify:track:spCheia1',
      genre: 'Samba & Pagode',
      subgenre: 'Pagode 90',
    });

    // Must never call deprecated Spotify endpoints or download during preview
    expect(fake.calls.some((u) => u.includes('/recommendations') || u.includes('/related-artists'))).toBe(false);
    expect(media.downloads).toEqual([]);
    expect(jukebox.tracks.findBySource('spotify', 'spCheia1')).toBeNull();
  });

  it('strictly isolates Gospel in both directions (Gospel seeds never suggest secular, secular seeds never suggest Gospel)', async () => {
    const config = tempConfig();
    const media = new FakeMedia();
    const fake = createFakeFetch({
      deezerArtists: {
        'aline barros': [{ id: 500, name: 'Aline Barros' }],
        'henrique & juliano': [{ id: 600, name: 'Henrique & Juliano' }],
      },
      deezerRelated: {
        500: [
          { id: 501, name: 'Gabriela Rocha' },
          { id: 502, name: 'Anitta' }, // incompatible secular artist returned by Deezer
        ],
        600: [
          { id: 601, name: 'Jorge & Mateus' },
          { id: 501, name: 'Gabriela Rocha' }, // Gospel artist leaked into secular related
        ],
      },
      deezerTop: {
        501: [
          {
            id: 5001,
            title: 'Lugar Secreto',
            duration: 300,
            artist: { id: 501, name: 'Gabriela Rocha' },
            album: { title: 'Céu', cover_medium: 'https://cdn.example/gr.jpg' },
          },
        ],
        502: [
          {
            id: 5002,
            title: 'Show das Poderosas',
            duration: 180,
            artist: { id: 502, name: 'Anitta' },
            album: { title: 'Anitta', cover_medium: 'https://cdn.example/anitta.jpg' },
          },
        ],
        601: [
          {
            id: 6001,
            title: 'Sosseguei',
            duration: 210,
            artist: { id: 601, name: 'Jorge & Mateus' },
            album: { title: 'Como. Sempre Feito. Nunca', cover_medium: 'https://cdn.example/jm.jpg' },
          },
        ],
      },
    });

    const jukebox = createJukebox(config, {
      media,
      fetchFn: fake.fetchFn,
      log: () => {},
      externalClassifierLookup: false,
    });
    const app = createApp({ config, jukebox });

    seedLocalTrack(jukebox, config.musicDir, {
      title: 'Ressuscita-me',
      artist: 'Aline Barros',
      genre: 'Gospel',
      subgenre: 'Louvor & Adoração',
    });
    seedLocalTrack(jukebox, config.musicDir, {
      title: 'Liberdade Provisória',
      artist: 'Henrique & Juliano',
      genre: 'Sertanejo',
      subgenre: 'Sertanejo Universitário',
    });

    const gospelRes = await request(app)
      .post('/api/discovery/suggest')
      .send({ mode: 'category', category: 'Gospel', limit: 10 })
      .expect(200);

    const gospelArtists = gospelRes.body.suggestions.map((s: { artist: string }) => s.artist);
    expect(gospelArtists).toContain('Gabriela Rocha');
    expect(gospelArtists).not.toContain('Anitta');

    const secularRes = await request(app)
      .post('/api/discovery/suggest')
      .send({ mode: 'category', category: 'Sertanejo', limit: 10 })
      .expect(200);

    const secularArtists = secularRes.body.suggestions.map((s: { artist: string }) => s.artist);
    expect(secularArtists).toContain('Jorge & Mateus');
    expect(secularArtists).not.toContain('Gabriela Rocha');
  });

  it('falls back to yt-dlp when Deezer fails and Spotify is not configured', async () => {
    const config = tempConfig();
    const media = new FakeMedia();
    const fake = createFakeFetch({ failDeezer: true });
    const jukebox = createJukebox(config, {
      media,
      fetchFn: fake.fetchFn,
      log: () => {},
      externalClassifierLookup: false,
    });
    const app = createApp({ config, jukebox });

    seedLocalTrack(jukebox, config.musicDir, {
      title: 'Tempo Perdido',
      artist: 'Legião Urbana',
      genre: 'Rock',
      subgenre: 'Rock Nacional',
    });

    const res = await request(app)
      .post('/api/discovery/suggest')
      .send({ mode: 'category', category: 'Rock', subgenre: 'Rock Nacional', limit: 5 })
      .expect(200);

    expect(res.body.sourcesUsed).toEqual(['youtube']);
    expect(res.body.suggestions.length).toBeGreaterThan(0);
    expect(res.body.suggestions[0].source).toBe('youtube');
    expect(media.searches.length).toBeGreaterThan(0);
  });

  it('populates library, playlist, or queue with auto-categorization and low-priority downloads preempted by guest requests', async () => {
    const config = tempConfig({ DOWNLOAD_CONCURRENCY: '1' });
    const media = new FakeMedia();
    const fake = createFakeFetch({});
    const jukebox = createJukebox(config, {
      media,
      fetchFn: fake.fetchFn,
      log: () => {},
      externalClassifierLookup: false,
    });
    const app = createApp({ config, jukebox });

    const playlist = jukebox.playlists!.create({ name: 'Rock BR' });

    // Hold downloads so we can inspect queueing order:
    // 1. Active placeholder track blocks slot 1
    // 2. Discovery populates 2 tracks (low priority)
    // 3. Guest requests 1 track via /api/queue (high priority) -> must run BEFORE the 2nd discovery track!
    media.hold();
    await request(app)
      .post('/api/queue')
      .send({
        result: { source: 'youtube', sourceId: 'holdtrack01', title: 'Holding', artist: 'Test' },
        clientId: 'guest-0',
      })
      .expect(201);

    const populateRes = await request(app)
      .post('/api/discovery/populate')
      .send({
        target: 'playlist',
        playlistId: playlist.id,
        tracks: [
          { source: 'youtube', sourceId: 'legiaotrack', title: 'Eduardo e Mônica', artist: 'Legião Urbana' },
          { source: 'deezer', sourceId: '987654', title: 'Pro Dia Nascer Feliz', artist: 'Barão Vermelho' },
        ],
      })
      .expect(200);

    expect(populateRes.body).toMatchObject({
      target: 'playlist',
      playlistId: playlist.id,
      total: 2,
      added: 2,
      duplicates: 0,
      queuedDownloads: 2,
    });

    // Auto-categorization was applied to populated tracks
    expect(populateRes.body.tracks[0]).toMatchObject({
      genre: 'Rock',
      subgenre: 'Rock Nacional',
    });
    expect(populateRes.body.tracks[1]).toMatchObject({
      genre: 'Rock',
      subgenre: 'Rock Nacional',
    });

    // Guest immediate request while discovery tracks are still pending
    await request(app)
      .post('/api/queue')
      .send({
        result: { source: 'youtube', sourceId: 'guestfast01', title: 'Guest Priority', artist: 'Pitty' },
        clientId: 'guest-1',
        name: 'Convidado VIP',
      })
      .expect(201);

    media.release();
    await jukebox.downloads.idle();

    // `holdtrack01` started first, then `guestfast01` MUST run before both low-priority discovery tracks!
    const guestIdx = media.downloads.indexOf('guestfast01');
    const legiaoIdx = media.downloads.indexOf('legiaotrack');
    expect(guestIdx).toBeGreaterThan(0);
    expect(legiaoIdx).toBeGreaterThan(guestIdx);
    // Deezer track resolved its youtubeId via media.search and downloaded too
    expect(media.searches.some((q) => q.includes('Pro Dia Nascer Feliz'))).toBe(true);

    // Also test vibe mode + queue populate target
    const vibeSuggest = await request(app)
      .post('/api/discovery/suggest')
      .send({ mode: 'vibe', limit: 5 })
      .expect(200);
    expect(vibeSuggest.body.mode).toBe('vibe');

    const queuePopulate = await request(app)
      .post('/api/discovery/populate')
      .send({
        target: 'queue',
        clientId: 'host-1',
        name: 'Host',
        tracks: [{ source: 'youtube', sourceId: 'vibequeue01', title: 'Malandragem', artist: 'Cássia Eller' }],
      })
      .expect(200);
    expect(queuePopulate.body).toMatchObject({ target: 'queue', total: 1, added: 1 });
    await jukebox.downloads.idle();
  });

  it('enforces HOST_PIN and validates REST payloads on discovery endpoints', async () => {
    const config = tempConfig({ HOST_PIN: '9999' });
    const media = new FakeMedia();
    const jukebox = createJukebox(config, { media, log: () => {}, externalClassifierLookup: false });
    const app = createApp({ config, jukebox });

    await request(app).post('/api/discovery/suggest').send({ mode: 'vibe' }).expect(403);
    await request(app)
      .post('/api/discovery/populate')
      .send({ target: 'library', tracks: [{ source: 'youtube', sourceId: 'aaaaaaaaaaa', title: 'X', artist: 'Y' }] })
      .expect(403);

    await request(app)
      .post('/api/discovery/suggest')
      .set('x-host-pin', '9999')
      .send({ mode: 'invalid' })
      .expect(400);

    await request(app)
      .post('/api/discovery/suggest')
      .set('x-host-pin', '9999')
      .send({ mode: 'playlist', playlistId: 'non-existent' })
      .expect(404);

    await request(app)
      .post('/api/discovery/suggest')
      .set('x-host-pin', '9999')
      .send({ mode: 'category', category: 'Rock', limit: 99 })
      .expect(400);

    await request(app)
      .post('/api/discovery/populate')
      .set('x-host-pin', '9999')
      .send({ target: 'playlist', playlistId: 'missing', tracks: [{ source: 'youtube', sourceId: 'aaaaaaaaaaa', title: 'X', artist: 'Y' }] })
      .expect(404);
  });

  it('fails closed on Gospel seeds when classifier returns null for unknown artists without genre', async () => {
    const config = tempConfig();
    const media = new FakeMedia();
    const fake = createFakeFetch({
      deezerArtists: {
        'aline barros': [{ id: 700, name: 'Aline Barros' }],
      },
      deezerRelated: {
        700: [
          { id: 701, name: 'Gabriela Rocha' },
          { id: 702, name: 'Banda Secular Desconhecida' },
        ],
      },
      deezerTop: {
        701: [
          {
            id: 7001,
            title: 'Lugar Secreto',
            duration: 300,
            artist: { id: 701, name: 'Gabriela Rocha' },
            album: { title: 'Céu', cover_medium: 'https://cdn.example/gr.jpg' },
          },
        ],
        702: [
          {
            id: 7002,
            title: 'Noite na Balada',
            duration: 200,
            artist: { id: 702, name: 'Banda Secular Desconhecida' },
            album: { title: 'Festa', cover_medium: 'https://cdn.example/sec.jpg' },
          },
        ],
      },
    });

    const jukebox = createJukebox(config, {
      media,
      fetchFn: fake.fetchFn,
      log: () => {},
      externalClassifierLookup: false,
    });
    const app = createApp({ config, jukebox });

    const g1 = seedLocalTrack(jukebox, config.musicDir, {
      title: 'Ressuscita-me',
      artist: 'Aline Barros',
      genre: 'Gospel',
      subgenre: 'Louvor & Adoração',
    });
    const g2 = seedLocalTrack(jukebox, config.musicDir, {
      title: 'Sonda-me',
      artist: 'Aline Barros',
      genre: 'Gospel',
      subgenre: 'Louvor & Adoração',
    });
    // Mix in an uncategorized track + 1 misclassified track so Gospel remains majority
    const uncat = seedLocalTrack(jukebox, config.musicDir, {
      title: 'Faixa Sem Genero',
      artist: 'Aline Barros',
      genre: null,
      subgenre: null,
    });
    const playlist = jukebox.playlists!.create({ name: 'Culto Domingo' });
    jukebox.playlists!.addTrack(playlist.id, g1.id);
    jukebox.playlists!.addTrack(playlist.id, g2.id);
    jukebox.playlists!.addTrack(playlist.id, uncat.id);

    const res = await request(app)
      .post('/api/discovery/suggest')
      .send({ mode: 'playlist', playlistId: playlist.id, limit: 10 })
      .expect(200);

    const titles = res.body.suggestions.map((s: { title: string }) => s.title);
    expect(titles).toContain('Lugar Secreto');
    expect(titles).not.toContain('Noite na Balada');
  });

  it('applies normalized deduplication and Gospel isolation inside populate()', async () => {
    const config = tempConfig();
    const media = new FakeMedia();
    const fake = createFakeFetch({});
    const jukebox = createJukebox(config, {
      media,
      fetchFn: fake.fetchFn,
      log: () => {},
      externalClassifierLookup: false,
    });
    const app = createApp({ config, jukebox });

    const existingPagode = seedLocalTrack(jukebox, config.musicDir, {
      title: 'Tá Vendo Aquela Lua (Ao Vivo)',
      artist: 'Exaltasamba',
      genre: 'Samba & Pagode',
      subgenre: 'Pagode 90',
    });
    const existingGospel = seedLocalTrack(jukebox, config.musicDir, {
      title: 'Ressuscita-me',
      artist: 'Aline Barros',
      genre: 'Gospel',
      subgenre: 'Louvor & Adoração',
    });

    // 1. Populating library with Deezer variant of an existing local track must reuse existing and count as duplicate
    const libRes = await request(app)
      .post('/api/discovery/populate')
      .send({
        target: 'library',
        tracks: [{ source: 'deezer', sourceId: '1001', title: 'Tá Vendo Aquela Lua', artist: 'Exaltasamba' }],
      })
      .expect(200);

    expect(libRes.body).toMatchObject({ total: 1, added: 0, duplicates: 1, queuedDownloads: 0 });
    expect(libRes.body.tracks[0].id).toBe(existingPagode.id);
    expect(jukebox.tracks.findBySource('deezer', '1001')).toBeNull();

    // 2. Populating a secular playlist reuses existing library track first time, blocks Gospel track, and dedupes on repeat
    const secularPlaylist = jukebox.playlists!.create({ name: 'Pagodinho' });
    jukebox.playlists!.addTrack(
      secularPlaylist.id,
      seedLocalTrack(jukebox, config.musicDir, {
        title: 'Cheia de Manias',
        artist: 'Raça Negra',
        genre: 'Samba & Pagode',
      }).id,
    );

    const plFirstRes = await request(app)
      .post('/api/discovery/populate')
      .send({
        target: 'playlist',
        playlistId: secularPlaylist.id,
        tracks: [
          { source: 'deezer', sourceId: '1001', title: 'Tá Vendo Aquela Lua', artist: 'Exaltasamba' },
          { source: 'deezer', sourceId: '5001', title: 'Lugar Secreto', artist: 'Gabriela Rocha' },
        ],
      })
      .expect(200);

    expect(plFirstRes.body).toMatchObject({ total: 2, added: 1, duplicates: 0, queuedDownloads: 0 });
    expect(plFirstRes.body.tracks).toHaveLength(1);
    expect(plFirstRes.body.tracks[0].id).toBe(existingPagode.id);
    expect(jukebox.tracks.findBySource('deezer', '5001')).toBeNull();

    const plDupRes = await request(app)
      .post('/api/discovery/populate')
      .send({
        target: 'playlist',
        playlistId: secularPlaylist.id,
        tracks: [{ source: 'youtube', sourceId: 'yt_lua_0001', title: 'Ta Vendo Aquela Lua [Official Video]', artist: 'Exaltasamba' }],
      })
      .expect(200);
    expect(plDupRes.body).toMatchObject({ total: 1, added: 0, duplicates: 1, queuedDownloads: 0 });

    // 3. Gospel playlist rejects secular and unknown tracks
    const gospelPlaylist = jukebox.playlists!.create({ name: 'Louvor da Manhã' });
    jukebox.playlists!.addTrack(gospelPlaylist.id, existingGospel.id);

    const gospelPlRes = await request(app)
      .post('/api/discovery/populate')
      .send({
        target: 'playlist',
        playlistId: gospelPlaylist.id,
        tracks: [
          { source: 'deezer', sourceId: '8881', title: 'Show das Poderosas', artist: 'Anitta' },
          { source: 'deezer', sourceId: '8882', title: 'Som Misterioso', artist: 'Artista Desconhecido' },
        ],
      })
      .expect(200);

    expect(gospelPlRes.body).toMatchObject({ total: 2, added: 0, duplicates: 0, queuedDownloads: 0 });
    expect(gospelPlRes.body.tracks).toEqual([]);
    expect(jukebox.tracks.findBySource('deezer', '8881')).toBeNull();
    expect(jukebox.tracks.findBySource('deezer', '8882')).toBeNull();

    // 4. Active Gospel queue rejects secular track and accepts Gospel track
    jukebox.queue.enqueue(existingGospel.id, 'host-1', 'Host');
    const queueRes = await request(app)
      .post('/api/discovery/populate')
      .send({
        target: 'queue',
        tracks: [
          { source: 'deezer', sourceId: '9991', title: 'Show das Poderosas', artist: 'Anitta' },
          { source: 'deezer', sourceId: '9992', title: 'Lugar Secreto', artist: 'Gabriela Rocha' },
        ],
      })
      .expect(200);

    expect(queueRes.body).toMatchObject({ total: 2, added: 1, duplicates: 0 });
    expect(queueRes.body.tracks).toHaveLength(1);
    expect(queueRes.body.tracks[0].artist).toBe('Gabriela Rocha');
    expect(jukebox.tracks.findBySource('deezer', '9991')).toBeNull();
  });
});
