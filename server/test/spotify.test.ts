import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createJukebox } from '../src/container.js';
import { pickYoutubeVideoCandidate } from '../src/services/spotify.js';
import { FakeMedia, setup, ytResult } from './helpers.js';

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

const ALL_SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-public',
  'playlist-modify-private',
  'user-read-playback-state',
  'user-modify-playback-state',
].join(' ');

interface FakeSpotifyOptions {
  tokenScope?: string;
  devices?: {
    id: string;
    name: string;
    type: string;
    is_active?: boolean;
    is_restricted?: boolean;
    volume_percent?: number | null;
    supports_volume?: boolean;
  }[];
  playbackState?: {
    is_playing: boolean;
    progress_ms: number;
    device?: { id: string; name: string; type: string; is_active: boolean; is_restricted: boolean; volume_percent: number | null };
    item?: ReturnType<typeof track> | null;
  } | null;
  playerError?: { status: number; reason?: string; message: string } | null;
  searchEmptyFor?: string[];
}

/** Minimal fake of the Spotify accounts + Web API endpoints we use. */
function fakeSpotify(options: FakeSpotifyOptions = {}) {
  const calls: { method: string; url: string; body?: string; auth?: string }[] = [];
  const playlistItems: { item: ReturnType<typeof track> }[] = [];
  const devices = options.devices ?? [
    { id: 'spk-sala', name: 'Caixa da Sala', type: 'Speaker', is_active: true, is_restricted: false, volume_percent: 65, supports_volume: true },
    { id: 'tv-quarto', name: 'TV Quarto', type: 'TV', is_active: false, is_restricted: false, volume_percent: 40, supports_volume: true },
  ];
  let playbackState = options.playbackState ?? null;
  let playerError = options.playerError ?? null;

  const fetchFn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    calls.push({ method, url, body: init.body as string | undefined, auth: headers.get('Authorization') ?? undefined });
    if (url.endsWith('/api/token')) {
      const params = new URLSearchParams(init.body as string);
      if (params.get('grant_type') === 'client_credentials') return json({ access_token: 'app-token', expires_in: 3600 });
      return json({
        access_token: 'user-token',
        refresh_token: 'refresh',
        expires_in: 3600,
        ...(options.tokenScope !== undefined ? { scope: options.tokenScope } : { scope: ALL_SCOPES }),
      });
    }
    if (url.includes('/v1/search')) {
      const parsed = new URL(url);
      const q = parsed.searchParams.get('q') ?? '';
      if (options.searchEmptyFor?.some((term) => q.toLowerCase().includes(term.toLowerCase()))) {
        return json({ tracks: { items: [] } });
      }
      return json({ tracks: { items: [track('t1', 'One More Time')] } });
    }
    if (url.includes('/v1/tracks/t2')) return json(track('t2', 'Digital Love'));
    if (url.includes('/v1/tracks/t3')) return json(track('t3', 'Harder Better Faster'));
    if (url.endsWith('/v1/me/playlists') && method === 'POST') return json({ id: 'pl1' }, 201);
    if (url.includes('/v1/playlists/pl1/items') && method === 'POST') {
      for (const uri of JSON.parse(init.body as string).uris as string[]) {
        playlistItems.push({ item: track(uri.split(':')[2], 'x') });
      }
      return json({ snapshot_id: 's' }, 201);
    }
    if (url.includes('/v1/playlists/pl1/items')) return json({ items: playlistItems, next: null });
    if (url.includes('/v1/playlists/pl1')) return json({ id: 'pl1' });
    if (url.endsWith('/v1/me/player/devices') && method === 'GET') {
      return json({ devices });
    }
    if (url.includes('/v1/me/player') && playerError) {
      return json({ error: { status: playerError.status, message: playerError.message, reason: playerError.reason } }, playerError.status);
    }
    if (url.endsWith('/v1/me/player') && method === 'GET') {
      if (!playbackState) return new Response(null, { status: 204 });
      return json(playbackState);
    }
    if (url.endsWith('/v1/me/player') && method === 'PUT') {
      return new Response(null, { status: 204 });
    }
    if (url.includes('/v1/me/player/play') && method === 'PUT') {
      return new Response(null, { status: 204 });
    }
    if (url.includes('/v1/me/player/pause') && method === 'PUT') {
      return new Response(null, { status: 204 });
    }
    if (url.includes('/v1/me/player/volume') && method === 'PUT') {
      return new Response(null, { status: 204 });
    }
    return json({ error: { message: 'not found' } }, 404);
  });
  return {
    fetchFn: fetchFn as unknown as typeof fetch,
    calls,
    playlistItems,
    setPlaybackState(next: FakeSpotifyOptions['playbackState']) {
      playbackState = next ?? null;
    },
    setPlayerError(next: FakeSpotifyOptions['playerError']) {
      playerError = next ?? null;
    },
  };
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

  it('requests playback scopes and reports playbackAuthorized status accurately', async () => {
    const fakeLegacy = fakeSpotify({ tokenScope: 'playlist-read-private' });
    const ctx1 = setup(SPOTIFY_ENV, fakeLegacy.fetchFn);
    const app1 = createApp({ config: ctx1.config, jukebox: ctx1.jukebox });

    const authRes = await request(app1).get('/api/spotify/auth').expect(302);
    const scopes = new URL(authRes.headers.location).searchParams.get('scope')?.split(' ') ?? [];
    expect(scopes).toContain('user-read-playback-state');
    expect(scopes).toContain('user-modify-playback-state');

    const state1 = new URL(authRes.headers.location).searchParams.get('state');
    await request(app1).get('/api/spotify/callback').query({ code: 'c', state: state1 });
    expect((await request(app1).get('/api/spotify/status').expect(200)).body).toMatchObject({
      connected: true,
      playbackAuthorized: false,
    });

    const fakeFull = fakeSpotify({ tokenScope: ALL_SCOPES });
    const ctx2 = setup(SPOTIFY_ENV, fakeFull.fetchFn);
    const app2 = createApp({ config: ctx2.config, jukebox: ctx2.jukebox });
    const state2 = new URL((await request(app2).get('/api/spotify/auth')).headers.location).searchParams.get('state');
    await request(app2).get('/api/spotify/callback').query({ code: 'c', state: state2 });
    expect((await request(app2).get('/api/spotify/status').expect(200)).body).toMatchObject({
      connected: true,
      playbackAuthorized: true,
    });
  });

  it('lists devices, enforces HOST_PIN, switches/persists playbackOutput, and controls volume/pause/resume', async () => {
    const fake = fakeSpotify();
    const { config, jukebox } = setup({ ...SPOTIFY_ENV, HOST_PIN: '4321' }, fake.fetchFn);
    const app = createApp({ config, jukebox });
    const state = new URL((await request(app).get('/api/spotify/auth').query({ pin: '4321' })).headers.location).searchParams.get('state');
    await request(app).get('/api/spotify/callback').query({ code: 'c', state });

    await request(app).get('/api/spotify/devices').expect(403);
    await request(app).post('/api/spotify/device').send({ deviceId: 'spk-sala' }).expect(403);
    await request(app).post('/api/spotify/player/pause').expect(403);
    await request(app).post('/api/spotify/player/resume').expect(403);
    await request(app).post('/api/spotify/player/volume').send({ volume: 50 }).expect(403);

    const devicesRes = await request(app).get('/api/spotify/devices').set('x-host-pin', '4321').expect(200);
    expect(devicesRes.body.playbackOutput).toEqual({ type: 'local' });
    expect(devicesRes.body.devices).toHaveLength(2);
    expect(devicesRes.body.devices[0]).toMatchObject({ id: 'spk-sala', name: 'Caixa da Sala', type: 'Speaker', isActive: true });

    await request(app).post('/api/spotify/device').set('x-host-pin', '4321').send({ deviceId: '' }).expect(400);
    await request(app).post('/api/spotify/device').set('x-host-pin', '4321').send({ deviceId: 'unknown-dev' }).expect(404);

    // Select first Spotify Connect speaker
    const sel1 = await request(app).post('/api/spotify/device').set('x-host-pin', '4321').send({ deviceId: 'spk-sala' }).expect(200);
    expect(sel1.body.playbackOutput).toEqual({ type: 'spotify', deviceId: 'spk-sala', deviceName: 'Caixa da Sala' });

    // Verify persistence across restart on the same DB
    const restarted = createJukebox(config, { media: new FakeMedia(), fetchFn: fake.fetchFn, log: () => {} });
    expect(restarted.playbackOutput).toEqual({ type: 'spotify', deviceId: 'spk-sala', deviceName: 'Caixa da Sala' });
    restarted.stop();

    // Transfer between two Spotify Connect devices while playing
    await request(app)
      .post('/api/queue')
      .send({ result: (await request(app).get('/api/search').query({ q: 'https://open.spotify.com/track/t2' })).body.results[0], clientId: 'a' })
      .expect(201);
    await vi.waitFor(() =>
      expect(fake.calls.some((c) => c.method === 'PUT' && c.url.includes('/v1/me/player/play?device_id=spk-sala'))).toBe(true),
    );
    const sel2 = await request(app).post('/api/spotify/device').set('x-host-pin', '4321').send({ deviceId: 'tv-quarto' }).expect(200);
    expect(sel2.body.playbackOutput).toEqual({ type: 'spotify', deviceId: 'tv-quarto', deviceName: 'TV Quarto' });
    const transferCall = fake.calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/v1/me/player')).at(-1);
    expect(JSON.parse(transferCall!.body!)).toEqual({ device_ids: ['tv-quarto'], play: true });

    // Pause, resume, volume validation + clamping
    await request(app).post('/api/spotify/player/pause').set('x-host-pin', '4321').expect(200, { ok: true, paused: true });
    await request(app).post('/api/spotify/player/resume').set('x-host-pin', '4321').expect(200, { ok: true, paused: false });
    await request(app).post('/api/spotify/player/volume').set('x-host-pin', '4321').send({ volume: 120 }).expect(400);
    await request(app).post('/api/spotify/player/volume').set('x-host-pin', '4321').send({ volume: 73.6 }).expect(200, { ok: true, volume: 74 });
    expect(fake.calls.some((c) => c.url.includes('/v1/me/player/volume?volume_percent=74&device_id=tv-quarto'))).toBe(true);

    // Return to Local Player
    const backLocal = await request(app).post('/api/spotify/device').set('x-host-pin', '4321').send({ deviceId: null }).expect(200);
    expect(backLocal.body.playbackOutput).toEqual({ type: 'local' });
    jukebox.stop();
  });

  it('surfaces 403 PREMIUM_REQUIRED and 404 NO_ACTIVE_DEVICE clearly', async () => {
    const fake = fakeSpotify();
    const { config, jukebox } = setup(SPOTIFY_ENV, fake.fetchFn);
    const app = createApp({ config, jukebox });
    const state = new URL((await request(app).get('/api/spotify/auth')).headers.location).searchParams.get('state');
    await request(app).get('/api/spotify/callback').query({ code: 'c', state });

    fake.setPlayerError({ status: 403, reason: 'PREMIUM_REQUIRED', message: 'Player command failed: Premium required' });
    const prem = await request(app).post('/api/spotify/device').send({ deviceId: 'spk-sala' }).expect(403);
    expect(prem.body.code).toBe('PREMIUM_REQUIRED');
    expect(jukebox.playbackOutput).toEqual({ type: 'local' });

    fake.setPlayerError({ status: 404, reason: 'NO_ACTIVE_DEVICE', message: 'Player command failed: No active device found' });
    const noDev = await request(app).post('/api/spotify/device').send({ deviceId: 'spk-sala' }).expect(404);
    expect(noDev.body.code).toBe('NO_ACTIVE_DEVICE');
    jukebox.stop();
  });

  it('matches YouTube tracks, skips unavailable tracks with notice, polls progress, and advances on track end', async () => {
    const fake = fakeSpotify({ searchEmptyFor: ['Unavailable Song'] });
    const { config, jukebox } = setup(SPOTIFY_ENV, fake.fetchFn);
    const app = createApp({ config, jukebox });
    const state = new URL((await request(app).get('/api/spotify/auth')).headers.location).searchParams.get('state');
    await request(app).get('/api/spotify/callback').query({ code: 'c', state });

    const notices: { message: string; error: boolean }[] = [];
    jukebox.on('notice', (message, error) => notices.push({ message, error }));

    await request(app).post('/api/spotify/device').send({ deviceId: 'spk-sala' }).expect(200);

    // 1. Track unavailable on Spotify -> notice + auto-skip to next compatible track
    await request(app).post('/api/queue').send({ result: ytResult('unavail0001', 'Unavailable Song', 'Nobody'), clientId: 'a' }).expect(201);
    await request(app).post('/api/queue').send({ result: ytResult('match000002', 'One More Time', 'Daft Punk'), clientId: 'b' }).expect(201);
    await jukebox.downloads.idle();

    await vi.waitFor(() => {
      expect(jukebox.queue.state().nowPlaying?.item.track.title).toBe('One More Time');
    });
    expect(notices.some((n) => n.error && n.message.includes('Unavailable Song'))).toBe(true);
    await vi.waitFor(() =>
      expect(fake.calls.some((c) => c.url.includes('/v1/me/player/play') && c.body?.includes('spotify:track:t1'))).toBe(true),
    );

    // 2. Enqueue a 3rd track (Spotify native), poll progress, then simulate track completion -> auto-advance
    const t3 = (await request(app).get('/api/search').query({ q: 'https://open.spotify.com/track/t3' })).body.results[0];
    await request(app).post('/api/queue').send({ result: t3, clientId: 'c' }).expect(201);

    const progressEvents: { positionSec: number; paused: boolean }[] = [];
    jukebox.queue.on('progress', (positionSec, paused) => progressEvents.push({ positionSec, paused }));

    fake.setPlaybackState({
      is_playing: true,
      progress_ms: 45_000,
      item: track('t1', 'One More Time'),
    });
    await jukebox.pollSpotifyPlayback();
    expect(progressEvents.at(-1)).toEqual({ positionSec: 45, paused: false });

    // Track finishes and rewinds to 0 paused -> auto-advance to t3!
    fake.setPlaybackState({
      is_playing: false,
      progress_ms: 0,
      item: track('t1', 'One More Time'),
    });
    await jukebox.pollSpotifyPlayback();
    expect(jukebox.queue.state().nowPlaying?.item.track.sourceId).toBe('t3');

    await vi.waitFor(() =>
      expect(fake.calls.some((c) => c.url.includes('/v1/me/player/play') && c.body?.includes('spotify:track:t3'))).toBe(true),
    );

    await jukebox.downloads.idle();
    jukebox.stop();
  });

  it('propagates 403/404 on Local -> Spotify switch while playing and keeps output local', async () => {
    const fake = fakeSpotify();
    const { config, jukebox } = setup(SPOTIFY_ENV, fake.fetchFn);
    const app = createApp({ config, jukebox });
    const state = new URL((await request(app).get('/api/spotify/auth')).headers.location).searchParams.get('state');
    await request(app).get('/api/spotify/callback').query({ code: 'c', state });

    const spotifyResult = (await request(app).get('/api/search').query({ q: 'https://open.spotify.com/track/t2' })).body.results[0];
    await request(app).post('/api/queue').send({ result: spotifyResult, clientId: 'a' }).expect(201);
    await jukebox.downloads.idle();
    expect(jukebox.queue.state().nowPlaying?.item.track.sourceId).toBe('t2');

    fake.setPlayerError({ status: 403, reason: 'PREMIUM_REQUIRED', message: 'Premium required' });
    const res = await request(app).post('/api/spotify/device').send({ deviceId: 'spk-sala' }).expect(403);
    expect(res.body.code).toBe('PREMIUM_REQUIRED');
    expect(jukebox.playbackOutput).toEqual({ type: 'local' });

    fake.setPlayerError({ status: 404, reason: 'NO_ACTIVE_DEVICE', message: 'No active device' });
    const res404 = await request(app).post('/api/spotify/device').send({ deviceId: 'spk-sala' }).expect(404);
    expect(res404.body.code).toBe('NO_ACTIVE_DEVICE');
    expect(jukebox.playbackOutput).toEqual({ type: 'local' });
    jukebox.stop();
  });

  it('does not falsely skip on Spotify -> Spotify transfer handoff and starts unstarted tracks', async () => {
    const fake = fakeSpotify();
    const { config, jukebox } = setup(SPOTIFY_ENV, fake.fetchFn);
    const app = createApp({ config, jukebox });
    const state = new URL((await request(app).get('/api/spotify/auth')).headers.location).searchParams.get('state');
    await request(app).get('/api/spotify/callback').query({ code: 'c', state });

    await request(app).post('/api/spotify/device').send({ deviceId: 'spk-sala' }).expect(200);
    const t2 = (await request(app).get('/api/search').query({ q: 'https://open.spotify.com/track/t2' })).body.results[0];
    const t3 = (await request(app).get('/api/search').query({ q: 'https://open.spotify.com/track/t3' })).body.results[0];
    await request(app).post('/api/queue').send({ result: t2, clientId: 'a' }).expect(201);
    await request(app).post('/api/queue').send({ result: t3, clientId: 'b' }).expect(201);

    await vi.waitFor(() =>
      expect(fake.calls.some((c) => c.url.includes('/v1/me/player/play?device_id=spk-sala'))).toBe(true),
    );
    // Simulate track t2 was actively playing before transfer
    fake.setPlaybackState({ is_playing: true, progress_ms: 20_000, item: track('t2', 'Digital Love') });
    await jukebox.pollSpotifyPlayback();

    // During transfer to tv-quarto, Spotify briefly reports null (204): must NOT skip t2!
    fake.setPlaybackState(null);
    await request(app).post('/api/spotify/device').send({ deviceId: 'tv-quarto' }).expect(200);
    await jukebox.pollSpotifyPlayback();
    expect(jukebox.queue.state().nowPlaying?.item.track.sourceId).toBe('t2');
    expect(jukebox.playbackOutput).toEqual({ type: 'spotify', deviceId: 'tv-quarto', deviceName: 'TV Quarto' });

    // Serialized concurrent switches settle cleanly on the final requested output
    const [r1, r2] = await Promise.all([
      request(app).post('/api/spotify/device').send({ deviceId: 'spk-sala' }),
      request(app).post('/api/spotify/device').send({ deviceId: null }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(jukebox.playbackOutput).toEqual({ type: 'local' });

    await jukebox.downloads.idle();
    jukebox.stop();
  });

  it('starts pending YouTube tracks immediately in Spotify mode and ensures download on disconnectSpotify', async () => {
    const fake = fakeSpotify();
    const { config, jukebox } = setup(SPOTIFY_ENV, fake.fetchFn);
    const ensureSpy = vi.spyOn(jukebox.downloads, 'ensure');
    const app = createApp({ config, jukebox });
    const state = new URL((await request(app).get('/api/spotify/auth')).headers.location).searchParams.get('state');
    await request(app).get('/api/spotify/callback').query({ code: 'c', state });

    await request(app).post('/api/spotify/device').send({ deviceId: 'spk-sala' }).expect(200);

    // Manually insert pending YouTube track (simulating slow yt-dlp download)
    const pendingTrack = jukebox.tracks.upsertFromResult(ytResult('slowyt00001', 'One More Time', 'Daft Punk'));
    expect(pendingTrack.status).toBe('pending');
    jukebox.queue.enqueue(pendingTrack.id, 'u1', 'Ana');

    // Starts immediately on Spotify without waiting for track.status === 'ready'
    expect(jukebox.queue.state().nowPlaying?.item.track.id).toBe(pendingTrack.id);
    await vi.waitFor(() =>
      expect(fake.calls.some((c) => c.url.includes('/v1/me/player/play') && c.body?.includes('spotify:track:t1'))).toBe(true),
    );

    ensureSpy.mockClear();
    jukebox.disconnectSpotify();
    expect(jukebox.playbackOutput).toEqual({ type: 'local' });
    expect(ensureSpy).toHaveBeenCalledWith(pendingTrack.id);
    await jukebox.downloads.idle();
    jukebox.stop();
  });

  it('preserves Headers instances and tuple headers in SpotifyService api requests', async () => {
    const fake = fakeSpotify();
    const { jukebox } = setup(SPOTIFY_ENV, fake.fetchFn);
    await jukebox.spotify['api']('/tracks/t2', { headers: new Headers({ 'X-Custom': 'yes' }) }, 'app');
    const lastFetchCall = vi.mocked(fake.fetchFn).mock.calls.at(-1)!;
    const passedHeaders = new Headers(lastFetchCall[1]?.headers);
    expect(passedHeaders.get('Authorization')).toBe('Bearer app-token');
    expect(passedHeaders.get('X-Custom')).toBe('yes');

    await jukebox.spotify['api']('/tracks/t2', { headers: [['X-Tuple', 'ok']] }, 'app');
    const tupleCall = vi.mocked(fake.fetchFn).mock.calls.at(-1)!;
    const tupleHeaders = new Headers(tupleCall[1]?.headers);
    expect(tupleHeaders.get('Authorization')).toBe('Bearer app-token');
    expect(tupleHeaders.get('X-Tuple')).toBe('ok');
    jukebox.stop();
  });

  it('maps data.item into SpotifyPlaybackState.track and ignores non-track items', async () => {
    const fake = fakeSpotify({
      playbackState: {
        is_playing: true,
        progress_ms: 12_345,
        item: track('auto1', 'Around the World'),
      },
    });
    const { config, jukebox } = setup(SPOTIFY_ENV, fake.fetchFn);
    const app = createApp({ config, jukebox });
    const state = new URL((await request(app).get('/api/spotify/auth')).headers.location).searchParams.get('state');
    await request(app).get('/api/spotify/callback').query({ code: 'c', state });

    const pb = await jukebox.spotify.getPlaybackState();
    expect(pb).toMatchObject({
      isPlaying: true,
      progressMs: 12_345,
      trackUri: 'spotify:track:auto1',
      trackId: 'auto1',
      durationMs: 200_000,
      track: {
        source: 'spotify',
        sourceId: 'auto1',
        title: 'Around the World',
        artist: 'Daft Punk',
        album: 'Discovery',
        durationSec: 200,
        thumbnail: 'cover.jpg',
        spotifyUri: 'spotify:track:auto1',
      },
    });

    fake.setPlaybackState({
      is_playing: true,
      progress_ms: 5_000,
      item: { ...track('ep1', 'Podcast Ep'), type: 'episode' },
    });
    const episodePb = await jukebox.spotify.getPlaybackState();
    expect(episodePb?.track).toBeNull();
    jukebox.stop();
  });

  it('adopts Spotify Autoplay tracks when queue drains or is idle without pause/restart, keeps history, and prioritizes Jukebox requests', async () => {
    const fake = fakeSpotify();
    const { config, jukebox, media } = setup(SPOTIFY_ENV, fake.fetchFn);
    const ensureSpy = vi.spyOn(jukebox.downloads, 'ensure');
    const app = createApp({ config, jukebox });
    const state = new URL((await request(app).get('/api/spotify/auth')).headers.location).searchParams.get('state');
    await request(app).get('/api/spotify/callback').query({ code: 'c', state });

    await request(app).post('/api/spotify/device').send({ deviceId: 'spk-sala' }).expect(200);

    // 1. Idle queue: Spotify starts playing a track directly on the connected speaker
    fake.setPlaybackState({
      is_playing: true,
      progress_ms: 14_000,
      item: track('auto1', 'Around the World'),
    });
    await jukebox.pollSpotifyPlayback();

    const adopted1 = jukebox.queue.state().nowPlaying;
    expect(adopted1).not.toBeNull();
    expect(adopted1?.item.requesterId).toBe('spotify-autoplay');
    expect(adopted1?.item.requesterName).toBe('Spotify Auto-DJ');
    expect(adopted1?.item.track.title).toBe('Around the World');
    expect(adopted1?.positionSec).toBe(14);
    expect(adopted1?.paused).toBe(false);
    // Must NOT call playTrack/pausePlayback or download immediately on adoption
    expect(fake.calls.filter((c) => c.url.includes('/v1/me/player/play'))).toHaveLength(0);
    expect(fake.calls.filter((c) => c.url.includes('/v1/me/player/pause'))).toHaveLength(0);
    expect(ensureSpy).not.toHaveBeenCalled();

    // 2. Successive Autoplay track change: auto1 finishes -> downloads auto1 in background, records in history, adopts auto2
    fake.setPlaybackState({
      is_playing: true,
      progress_ms: 3_000,
      item: track('auto2', 'Voyager'),
    });
    await jukebox.pollSpotifyPlayback();
    await jukebox.downloads.idle();

    expect(jukebox.queue.state().nowPlaying?.item.track.sourceId).toBe('auto2');
    expect(jukebox.queue.state().nowPlaying?.item.requesterName).toBe('Spotify Auto-DJ');
    expect(ensureSpy).toHaveBeenCalledTimes(1);
    expect(media.downloads).toHaveLength(1);
    expect(jukebox.queue.history().map((h) => h.track.sourceId)).toContain('auto1');

    // Still must NOT call playTrack or pausePlayback for Spotify Auto-DJ transitions
    expect(fake.calls.filter((c) => c.url.includes('/v1/me/player/play'))).toHaveLength(0);
    expect(fake.calls.filter((c) => c.url.includes('/v1/me/player/pause'))).toHaveLength(0);

    // 3. Replaying an already-cached track via Spotify Auto-DJ does NOT duplicate download on natural end
    const auto1TrackId = adopted1!.item.trackId;
    expect(jukebox.tracks.isCached(jukebox.tracks.get(auto1TrackId)!)).toBe(true);
    ensureSpy.mockClear();

    // 4. Guest enqueues a Jukebox request while auto2 is playing -> auto2 stays playing, request takes priority when auto2 ends
    const t2 = (await request(app).get('/api/search').query({ q: 'https://open.spotify.com/track/t2' })).body.results[0];
    await request(app).post('/api/queue').send({ result: t2, clientId: 'guest-1', name: 'Bia' }).expect(201);
    expect(jukebox.queue.state().nowPlaying?.item.track.sourceId).toBe('auto2');
    expect(jukebox.queue.state().queue).toHaveLength(1);
    await jukebox.downloads.idle();

    // Even if Spotify Autoplay started auto3 right as auto2 ended, Jukebox overrides with Bia's request (t2)
    fake.setPlaybackState({
      is_playing: true,
      progress_ms: 2_000,
      item: track('auto3', 'Superheroes'),
    });
    await jukebox.pollSpotifyPlayback();

    expect(jukebox.queue.state().nowPlaying?.item.track.sourceId).toBe('t2');
    expect(jukebox.queue.state().nowPlaying?.item.requesterName).toBe('Bia');
    await vi.waitFor(() =>
      expect(fake.calls.some((c) => c.url.includes('/v1/me/player/play') && c.body?.includes('spotify:track:t2'))).toBe(true),
    );

    // 5. When last Jukebox track (t2) finishes and Spotify starts Autoplay (auto1 cached), Jukebox adopts auto1 without pause/play
    const playCallsBefore = fake.calls.filter((c) => c.url.includes('/v1/me/player/play')).length;
    const pauseCallsBefore = fake.calls.filter((c) => c.url.includes('/v1/me/player/pause')).length;
    fake.setPlaybackState({ is_playing: true, progress_ms: 30_000, item: track('t2', 'Digital Love') });
    await jukebox.pollSpotifyPlayback();

    fake.setPlaybackState({ is_playing: true, progress_ms: 1_500, item: track('auto1', 'Around the World') });
    await jukebox.pollSpotifyPlayback();

    expect(jukebox.queue.state().nowPlaying?.item.track.sourceId).toBe('auto1');
    expect(jukebox.queue.state().nowPlaying?.item.requesterId).toBe('spotify-autoplay');
    expect(fake.calls.filter((c) => c.url.includes('/v1/me/player/play')).length).toBe(playCallsBefore);
    expect(fake.calls.filter((c) => c.url.includes('/v1/me/player/pause')).length).toBe(pauseCallsBefore);

    // Finish auto1 naturally again -> already cached, so media.downloads must NOT increase
    const downloadsBeforeReplay = media.downloads.length;
    fake.setPlaybackState({ is_playing: true, progress_ms: 45_000, item: track('auto1', 'Around the World') });
    await jukebox.pollSpotifyPlayback();
    fake.setPlaybackState({ is_playing: false, progress_ms: 0, item: track('auto1', 'Around the World') });
    await jukebox.pollSpotifyPlayback();
    await jukebox.downloads.idle();
    expect(media.downloads).toHaveLength(downloadsBeforeReplay);
    expect(jukebox.queue.state().nowPlaying).toBeNull();
    jukebox.stop();
  });

  it('does not download or immediately re-adopt when a Spotify Auto-DJ track is skipped or removed prematurely', async () => {
    const fake = fakeSpotify();
    const { config, jukebox } = setup(SPOTIFY_ENV, fake.fetchFn);
    const ensureSpy = vi.spyOn(jukebox.downloads, 'ensure');
    const app = createApp({ config, jukebox });
    const state = new URL((await request(app).get('/api/spotify/auth')).headers.location).searchParams.get('state');
    await request(app).get('/api/spotify/callback').query({ code: 'c', state });

    await request(app).post('/api/spotify/device').send({ deviceId: 'spk-sala' }).expect(200);
    fake.setPlaybackState({ is_playing: true, progress_ms: 20_000, item: track('autoSkip', 'Skipped Song') });
    await jukebox.pollSpotifyPlayback();
    expect(jukebox.queue.state().nowPlaying?.item.track.sourceId).toBe('autoSkip');

    // Host skips prematurely while Spotify still reports autoSkip playing -> no download, no zombie re-adoption
    await request(app).post('/api/player/skip').expect(200);
    expect(jukebox.queue.state().nowPlaying).toBeNull();
    expect(ensureSpy).not.toHaveBeenCalled();

    await jukebox.pollSpotifyPlayback();
    expect(jukebox.queue.state().nowPlaying).toBeNull();

    // Once Spotify moves to a new track, adoption resumes normally
    fake.setPlaybackState({ is_playing: true, progress_ms: 4_000, item: track('autoFresh', 'Fresh Song') });
    await jukebox.pollSpotifyPlayback();
    expect(jukebox.queue.state().nowPlaying?.item.track.sourceId).toBe('autoFresh');

    // Host removes playing track prematurely -> no download
    const playingId = jukebox.queue.state().nowPlaying!.item.id;
    await request(app).delete(`/api/queue/${playingId}`).expect(204);
    expect(ensureSpy).not.toHaveBeenCalled();
    jukebox.stop();
  });

  it('prioritizes compatible official YouTube music videos and falls back safely to audio search', async () => {
    const candidates = [
      { source: 'youtube' as const, sourceId: 'react111111', title: 'Daft Punk - Digital Love Reaction!', artist: 'Reactor', durationSec: 205 },
      { source: 'youtube' as const, sourceId: 'short222222', title: 'Daft Punk - Digital Love (Official Music Video)', artist: 'Daft Punk', durationSec: 45 },
      { source: 'youtube' as const, sourceId: 'audio333333', title: 'Daft Punk - Digital Love (Official Audio)', artist: 'Daft Punk - Topic', durationSec: 200 },
      { source: 'youtube' as const, sourceId: 'clip4444444', title: 'Daft Punk - Digital Love (Official Music Video)', artist: 'Daft Punk', durationSec: 208 },
    ];
    expect(pickYoutubeVideoCandidate(candidates, { title: 'Digital Love', artist: 'Daft Punk', durationSec: 200 })?.sourceId).toBe(
      'clip4444444',
    );

    const fake = fakeSpotify();
    const { jukebox, media } = setup(SPOTIFY_ENV, fake.fetchFn);
    const searchSpy = vi.spyOn(media, 'search').mockImplementation(async (query: string) => {
      media.searches.push(query);
      if (query.includes('official video')) {
        return [
          { source: 'youtube', sourceId: 'audio000001', title: 'Daft Punk - Digital Love (Official Audio)', artist: 'Daft Punk - Topic', durationSec: 200 },
          { source: 'youtube', sourceId: 'video000002', title: 'Daft Punk - Digital Love (Clipe Oficial)', artist: 'Daft Punk', durationSec: 206 },
        ];
      }
      return [ytResult('fallback001', 'Digital Love Audio', 'Daft Punk')];
    });

    const spotifyTrack = jukebox.tracks.upsertFromResult({
      source: 'spotify',
      sourceId: 'sp-vid-1',
      title: 'Digital Love',
      artist: 'Daft Punk',
      durationSec: 200,
      spotifyUri: 'spotify:track:sp-vid-1',
    });

    expect(jukebox.downloads.ensure(spotifyTrack.id)).toBe(false);
    await jukebox.downloads.idle();

    expect(media.searches[0]).toBe('Daft Punk - Digital Love official video');
    expect(media.downloads).toEqual(['video000002']);
    expect(media.videoDownloads).toEqual(['video000002']);
    const saved = jukebox.tracks.get(spotifyTrack.id)!;
    expect(saved.status).toBe('ready');
    expect(saved.youtubeId).toBe('video000002');
    expect(saved.videoPath).toBeTruthy();

    // Fallback when video search fails or has no compatible duration
    searchSpy.mockImplementation(async (query: string) => {
      media.searches.push(query);
      if (query.includes('official video')) throw new Error('search failed');
      return [ytResult('fallback999', 'Fallback Audio', 'Daft Punk')];
    });
    const fallbackTrack = jukebox.tracks.upsertFromResult({
      source: 'spotify',
      sourceId: 'sp-vid-2',
      title: 'Harder Better Faster',
      artist: 'Daft Punk',
      durationSec: 224,
      spotifyUri: 'spotify:track:sp-vid-2',
    });
    jukebox.downloads.ensure(fallbackTrack.id);
    await jukebox.downloads.idle();
    expect(jukebox.tracks.get(fallbackTrack.id)?.youtubeId).toBe('fallback999');
    jukebox.stop();
  });
});
