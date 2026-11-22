import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { setup, ytResult } from './helpers.js';

const SPOTIFY_ENV = { SPOTIFY_CLIENT_ID: 'cid', SPOTIFY_CLIENT_SECRET: 'secret', PUBLIC_URL: 'http://192.168.0.10:3000' };

const track = (id: string, name: string) => ({
  id,
  uri: `spotify:track:${id}`,
  name,
  duration_ms: 200_000,
  artists: [{ name: 'Daft Punk' }],
  album: { name: 'Discovery', images: [{ url: 'cover.jpg', width: 640 }] },
  type: 'track',
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Minimal fake of the Spotify accounts + Web API endpoints we use. */
function fakeSpotify() {
  const calls: { method: string; url: string; body?: string; auth?: string }[] = [];
  const playlistItems: { item: ReturnType<typeof track> }[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ method, url, body: init.body as string | undefined, auth: headers.Authorization });
    if (url.endsWith('/api/token')) {
      const params = new URLSearchParams(init.body as string);
      if (params.get('grant_type') === 'client_credentials') return json({ access_token: 'app-token', expires_in: 3600 });
      return json({ access_token: 'user-token', refresh_token: 'refresh', expires_in: 3600 });
    }
    if (url.includes('/v1/search')) return json({ tracks: { items: [track('t1', 'One More Time')] } });
    if (url.includes('/v1/tracks/t2')) return json(track('t2', 'Digital Love'));
    if (url.endsWith('/v1/me/playlists') && method === 'POST') return json({ id: 'pl1' }, 201);
    if (url.includes('/v1/playlists/pl1/items') && method === 'POST') {
      for (const uri of JSON.parse(init.body as string).uris as string[]) {
        playlistItems.push({ item: track(uri.split(':')[2], 'x') });
      }
      return json({ snapshot_id: 's' }, 201);
    }
    if (url.includes('/v1/playlists/pl1/items')) return json({ items: playlistItems, next: null });
    if (url.includes('/v1/playlists/pl1')) return json({ id: 'pl1' });
    return json({ error: { message: 'not found' } }, 404);
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls, playlistItems };
}

describe('Spotify integration', () => {
  it('degrades gracefully when not configured', async () => {
    const { config, jukebox } = setup();
    const app = createApp({ config, jukebox });
    await request(app).get('/api/spotify/auth').expect(503);
    await request(app).post('/api/spotify/import').expect(503);
    expect((await request(app).get('/api/spotify/status').expect(200)).body).toMatchObject({ configured: false });
  });

  it('searches the catalog with client credentials and resolves links', async () => {
    const fake = fakeSpotify();
    const { config, jukebox } = setup(SPOTIFY_ENV, fake.fetchFn);
    const app = createApp({ config, jukebox });

    const res = await request(app).get('/api/search').query({ q: 'one more time', source: 'spotify' }).expect(200);
    expect(res.body.results[0]).toMatchObject({
      source: 'spotify',
      sourceId: 't1',
      artist: 'Daft Punk',
      thumbnail: 'cover.jpg',
      spotifyUri: 'spotify:track:t1',
    });
    expect(fake.calls.find((c) => c.url.includes('/search'))?.auth).toBe('Bearer app-token');

    const link = await request(app).get('/api/search').query({ q: 'https://open.spotify.com/track/t2' }).expect(200);
    expect(link.body.results[0]).toMatchObject({ sourceId: 't2', title: 'Digital Love' });
  });

  it('runs OAuth, creates the shared playlist, syncs enqueued songs and downloads via YouTube match', async () => {
    const fake = fakeSpotify();
    const { config, jukebox, media } = setup(SPOTIFY_ENV, fake.fetchFn);
    const app = createApp({ config, jukebox });

    const auth = await request(app).get('/api/spotify/auth').expect(302);
    const location = new URL(auth.headers.location);
    expect(location.origin).toBe('https://accounts.spotify.com');
    expect(location.searchParams.get('redirect_uri')).toBe('http://192.168.0.10:3000/api/spotify/callback');
    const state = location.searchParams.get('state')!;

    await request(app).get('/api/spotify/callback').query({ code: 'c', state: 'wrong' }).expect(302).expect('Location', /spotify=error/);
    await request(app).get('/api/spotify/callback').query({ code: 'c', state }).expect(302).expect('Location', '/?spotify=connected');
    expect(jukebox.spotify.status()).toMatchObject({ connected: true, playlistId: 'pl1' });

    const spotifyResult = (await request(app).get('/api/search').query({ q: 'https://open.spotify.com/track/t2' })).body.results[0];
    await request(app).post('/api/queue').send({ result: spotifyResult, clientId: 'a', name: 'Bia' }).expect(201);
    await jukebox.downloads.idle();
    await vi.waitFor(() => expect(fake.playlistItems.map((p) => p.item.id)).toEqual(['t2']));

    // Spotify -> YouTube match spotDL-style, then downloaded.
    expect(media.searches).toContain('Daft Punk - Digital Love audio');
    expect(media.downloads).toEqual(['yt000000000']);
    expect(jukebox.queue.state().nowPlaying?.item.track).toMatchObject({ source: 'spotify', status: 'ready' });

    // YouTube songs are matched in the Spotify catalog before syncing.
    await request(app).post('/api/queue').send({ result: ytResult('aaaaaaaaaaa'), clientId: 'b' }).expect(201);
    await vi.waitFor(() => expect(fake.playlistItems.map((p) => p.item.id)).toEqual(['t2', 't1']));
    await jukebox.downloads.idle();
  });

  it('imports songs added to the shared playlist from the Spotify app', async () => {
    const fake = fakeSpotify();
    const { config, jukebox } = setup(SPOTIFY_ENV, fake.fetchFn);
    const app = createApp({ config, jukebox });
    const state = new URL((await request(app).get('/api/spotify/auth')).headers.location).searchParams.get('state');
    await request(app).get('/api/spotify/callback').query({ code: 'c', state });

    fake.playlistItems.push({ item: { ...track('t9', 'Aerodynamic') } });
    expect((await request(app).post('/api/spotify/import').expect(200)).body).toEqual({ imported: 1 });
    expect((await request(app).post('/api/spotify/import').expect(200)).body).toEqual({ imported: 0 });
    const all = [jukebox.queue.state().nowPlaying?.item, ...jukebox.queue.state().queue].filter(Boolean);
    expect(all.map((e) => e!.track.title)).toContain('Aerodynamic');
    expect(all[0]!.requesterName).toBe('Spotify');
    await jukebox.downloads.idle();
    // Imported songs must not be mirrored back into the playlist they came from.
    expect(fake.calls.filter((c) => c.method === 'POST' && c.url.includes('/playlists/pl1/items'))).toHaveLength(0);
    expect(fake.playlistItems).toHaveLength(1);
  });

  it('links an existing playlist without re-importing its old songs and never recreates it silently', async () => {
    const fake = fakeSpotify();
    const { config, jukebox } = setup(SPOTIFY_ENV, fake.fetchFn);
    const app = createApp({ config, jukebox });
    const state = new URL((await request(app).get('/api/spotify/auth')).headers.location).searchParams.get('state');
    await request(app).get('/api/spotify/callback').query({ code: 'c', state });
    fake.playlistItems.push({ item: track('old1', 'Old Song') });

    await request(app).post('/api/spotify/playlist').send({ playlist: 'https://open.spotify.com/playlist/../me' }).expect(400);
    await request(app).post('/api/spotify/playlist').send({ playlist: 'missing' }).expect(404);
    expect(jukebox.spotify.playlistId).toBe('pl1');

    const linked = await request(app).post('/api/spotify/playlist').send({ playlist: 'https://open.spotify.com/playlist/pl1?si=x' }).expect(200);
    expect(linked.body).toMatchObject({ playlistId: 'pl1' });
    expect((await request(app).post('/api/spotify/import').expect(200)).body).toEqual({ imported: 0 });

    // A linked playlist that disappears is reported, not replaced by a brand-new one.
    fake.playlistItems.length = 0;
    const creates = () => fake.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/me/playlists')).length;
    const before = creates();
    jukebox.spotify['settings'].set('spotify_playlist_id', 'gone');
    await expect(jukebox.spotify.ensurePlaylist()).rejects.toMatchObject({ status: 404 });
    expect(creates()).toBe(before);
  });
});
