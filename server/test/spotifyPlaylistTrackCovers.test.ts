import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import type { FetchFn } from '../src/services/spotify.js';
import { setup } from './helpers.js';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const htmlResponse = (html: string) =>
  new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

const PLAYLIST_ID = '37i9dQZF1E8ABWfNWImBVL';
const PLAYLIST_COVER = 'https://i.scdn.co/image/radio-cover';
const TRACK_A = '2U8tH2LXMh5EQvI6oBhSHJ';
const TRACK_B = '3X4sErWRnQCmhhZMGv6r51';

const embedHtml = () => {
  const nextData = {
    props: {
      pageProps: {
        state: {
          data: {
            entity: {
              name: 'Are You Okay? Radio',
              subtitle: 'Spotify',
              coverArt: { sources: [{ url: PLAYLIST_COVER, width: 640 }] },
              trackList: [
                { uri: `spotify:track:${TRACK_A}`, title: 'Are You Okay?', subtitle: 'Thomas Reid', duration: 220396 },
                { uri: `spotify:track:${TRACK_B}`, title: 'when we were 16', subtitle: 'Rxseboy', duration: 195745 },
              ],
            },
          },
        },
      },
    },
  };
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></body></html>`;
};

const fullTrack = (id: string, album: string, cover: string, durationMs: number) => ({
  id,
  uri: `spotify:track:${id}`,
  name: id,
  duration_ms: durationMs,
  artists: [{ name: 'X' }],
  album: { name: album, images: [{ url: cover, width: 640 }] },
});

function makeFetch(tracksEndpoint: 'ok' | 'fail', calls: string[] = []): FetchFn {
  return async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('accounts.spotify.com/api/token')) return jsonResponse({ access_token: 'app-tok', expires_in: 3600 });
    if (url.includes(`/v1/playlists/${PLAYLIST_ID}`)) return jsonResponse({ error: { status: 404 } }, 404);
    if (url.includes(`open.spotify.com/embed/playlist/${PLAYLIST_ID}`)) return htmlResponse(embedHtml());
    if (url.includes('/v1/tracks?ids=')) {
      if (tracksEndpoint === 'fail') return jsonResponse({ error: { status: 403, message: 'Forbidden' } }, 403);
      return jsonResponse({
        tracks: [
          fullTrack(TRACK_A, 'Album A', 'https://i.scdn.co/image/cover-a', 221000),
          fullTrack(TRACK_B, 'Album B', 'https://i.scdn.co/image/cover-b', 196000),
        ],
      });
    }
    if (url.includes('open.spotify.com/oembed')) {
      if (url.includes(TRACK_A)) return jsonResponse({ thumbnail_url: 'https://i.scdn.co/image/oembed-a' });
      return jsonResponse({}, 404);
    }
    return jsonResponse({}, 404);
  };
}

const importRadio = (app: ReturnType<typeof createApp>) =>
  request(app)
    .post('/api/playlists/import')
    .send({ url: `https://open.spotify.com/playlist/${PLAYLIST_ID}`, enqueue: false })
    .expect((res) => {
      if (res.status !== 200 && res.status !== 201) throw new Error(`unexpected ${res.status}`);
    });

describe('Spotify embed playlist import keeps per-track album covers (#63)', () => {
  it('hydrates each track with its own cover via /v1/tracks?ids= and keeps the playlist cover on the playlist', async () => {
    const calls: string[] = [];
    const { config, jukebox } = setup({ SPOTIFY_CLIENT_ID: 'cid', SPOTIFY_CLIENT_SECRET: 'csec' }, makeFetch('ok', calls));
    const app = createApp({ config, jukebox });
    try {
      const res = await importRadio(app);
      expect(res.body.playlist.thumbnail).toBe(PLAYLIST_COVER);
      const byId = Object.fromEntries(res.body.tracks.map((t: { sourceId: string }) => [t.sourceId, t]));
      expect(byId[TRACK_A]).toMatchObject({ thumbnail: 'https://i.scdn.co/image/cover-a', album: 'Album A', durationSec: 221 });
      expect(byId[TRACK_B]).toMatchObject({ thumbnail: 'https://i.scdn.co/image/cover-b', album: 'Album B', durationSec: 196 });
      expect(calls.some((u) => u.includes(`/v1/tracks?ids=${TRACK_A},${TRACK_B}`))).toBe(true);
      expect(calls.some((u) => u.includes('oembed'))).toBe(false);
    } finally {
      jukebox.stop();
    }
  });

  it('degrades gracefully when /v1/tracks fails: oEmbed covers, never the playlist cover', async () => {
    const { config, jukebox } = setup({ SPOTIFY_CLIENT_ID: 'cid', SPOTIFY_CLIENT_SECRET: 'csec' }, makeFetch('fail'));
    const app = createApp({ config, jukebox });
    try {
      const res = await importRadio(app);
      expect(res.body.playlist.thumbnail).toBe(PLAYLIST_COVER);
      const byId = Object.fromEntries(res.body.tracks.map((t: { sourceId: string }) => [t.sourceId, t]));
      expect(byId[TRACK_A].thumbnail).toBe('https://i.scdn.co/image/oembed-a');
      expect(byId[TRACK_B].thumbnail).toBeNull();
      expect(byId[TRACK_A].durationSec).toBe(220);
      for (const t of res.body.tracks) expect(t.thumbnail).not.toBe(PLAYLIST_COVER);
    } finally {
      jukebox.stop();
    }
  });

  it('re-import fixes tracks whose thumbnail was contaminated with the playlist cover', async () => {
    const { config, jukebox } = setup({ SPOTIFY_CLIENT_ID: 'cid', SPOTIFY_CLIENT_SECRET: 'csec' }, makeFetch('ok'));
    const app = createApp({ config, jukebox });
    try {
      // Simulate a track persisted by the old buggy import.
      const old = jukebox.tracks.upsertFromResult({
        source: 'spotify',
        sourceId: TRACK_A,
        title: 'Are You Okay?',
        artist: 'Thomas Reid',
        album: null,
        durationSec: 220,
        thumbnail: PLAYLIST_COVER,
        spotifyUri: `spotify:track:${TRACK_A}`,
      });
      expect(old.thumbnail).toBe(PLAYLIST_COVER);

      await importRadio(app);
      const healed = jukebox.tracks.get(old.id)!;
      expect(healed.thumbnail).toBe('https://i.scdn.co/image/cover-a');
      expect(healed.album).toBe('Album A');
    } finally {
      jukebox.stop();
    }
  });
});
