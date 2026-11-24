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

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

describe('Spotify album & editorial radio (37i9dQZF1...) playlist import (#45)', () => {
  it('imports a Spotify album URL via POST /api/playlists/import', async () => {
    const fetchFn: FetchFn = async (input) => {
      const url = String(input);
      if (url.includes('accounts.spotify.com/api/token')) {
        return jsonResponse({ access_token: 'app-tok', expires_in: 3600 });
      }
      if (url.includes('/v1/albums/2eiEUZlcSFCm5bmFi2SyWB')) {
        return jsonResponse({
          name: 'Álbum Teste',
          artists: [{ name: 'Artista A' }],
          images: [{ url: 'https://i.scdn.co/image/album-cover', width: 640 }],
          total_tracks: 2,
          tracks: {
            total: 2,
            next: null,
            items: [
              {
                id: 'trk1111111111111111111',
                uri: 'spotify:track:trk1111111111111111111',
                name: 'Faixa Um',
                duration_ms: 185000,
                artists: [{ name: 'Artista A' }],
              },
              {
                id: 'trk2222222222222222222',
                uri: 'spotify:track:trk2222222222222222222',
                name: 'Faixa Dois',
                duration_ms: 210000,
                artists: [{ name: 'Artista A' }, { name: 'Artista B' }],
              },
            ],
          },
        });
      }
      return jsonResponse({ error: { status: 404, message: 'Not found' } }, 404);
    };

    const { config, jukebox } = setup(
      { SPOTIFY_CLIENT_ID: 'cid', SPOTIFY_CLIENT_SECRET: 'csec' },
      fetchFn,
    );
    const app = createApp({ config, jukebox });

    try {
      const res = await request(app)
        .post('/api/playlists/import')
        .send({
          url: 'https://open.spotify.com/album/2eiEUZlcSFCm5bmFi2SyWB?si=v_sU7ge2TNuJtlJCP97qZQ&utm_source=copy-link',
          enqueue: false,
        })
        .expect(201);

      expect(res.body.created).toBe(true);
      expect(res.body.imported).toBe(2);
      expect(res.body.playlist.name).toBe('Álbum Teste');
      expect(res.body.playlist.source).toBe('spotify');
      expect(res.body.playlist.sourceId).toBe('album:2eiEUZlcSFCm5bmFi2SyWB');
    } finally {
      jukebox.stop();
    }
  });

  it('falls back to Spotify public embed when Web API returns 404 for 37i9dQZF1 radio playlists', async () => {
    const nextData = {
      props: {
        pageProps: {
          state: {
            data: {
              entity: {
                name: 'Are You Okay? Radio',
                subtitle: 'Spotify',
                coverArt: { sources: [{ url: 'https://i.scdn.co/image/radio-cover', width: 640 }] },
                trackList: [
                  {
                    uri: 'spotify:track:2U8tH2LXMh5EQvI6oBhSHJ',
                    title: 'Are You Okay?',
                    subtitle: 'Thomas Reid,\u00a0Rxseboy,\u00a0Powfu',
                    duration: 220396,
                    entityType: 'track',
                  },
                  {
                    uri: 'spotify:track:3X4sErWRnQCmhhZMGv6r51',
                    title: 'when we were 16',
                    subtitle: 'Rxseboy,\u00a0Powfu',
                    duration: 195745,
                    entityType: 'track',
                  },
                ],
              },
            },
          },
        },
      },
    };

    const fetchFn: FetchFn = async (input) => {
      const url = String(input);
      if (url.includes('accounts.spotify.com/api/token')) {
        return jsonResponse({ access_token: 'app-tok', expires_in: 3600 });
      }
      if (url.includes('/v1/playlists/37i9dQZF1E8ABWfNWImBVL')) {
        return jsonResponse({ error: { status: 404, message: 'Resource not found' } }, 404);
      }
      if (url.includes('open.spotify.com/embed/playlist/37i9dQZF1E8ABWfNWImBVL')) {
        return htmlResponse(
          `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></body></html>`,
        );
      }
      return jsonResponse({}, 404);
    };

    const { config, jukebox } = setup(
      { SPOTIFY_CLIENT_ID: 'cid', SPOTIFY_CLIENT_SECRET: 'csec' },
      fetchFn,
    );
    const app = createApp({ config, jukebox });

    try {
      const res = await request(app)
        .post('/api/playlists/import')
        .send({
          url: 'https://open.spotify.com/playlist/37i9dQZF1E8ABWfNWImBVL?si=et53NfDJSVqW2NBxrHE39g&utm_source=copy-link',
          enqueue: false,
        })
        .expect(201);

      expect(res.body.created).toBe(true);
      expect(res.body.imported).toBe(2);
      expect(res.body.playlist.name).toBe('Are You Okay? Radio');
      expect(res.body.tracks[0].artist).toBe('Thomas Reid, Rxseboy, Powfu');
      expect(res.body.tracks[0].durationSec).toBe(220);
    } finally {
      jukebox.stop();
    }
  });

  it('returns an actionable error message when a 37i9dQZF1 radio fails both API and embed', async () => {
    const fetchFn: FetchFn = async (input) => {
      const url = String(input);
      if (url.includes('accounts.spotify.com/api/token')) {
        return jsonResponse({ access_token: 'app-tok', expires_in: 3600 });
      }
      return jsonResponse({ error: { status: 404, message: 'Resource not found' } }, 404);
    };

    const { config, jukebox } = setup(
      { SPOTIFY_CLIENT_ID: 'cid', SPOTIFY_CLIENT_SECRET: 'csec' },
      fetchFn,
    );
    const app = createApp({ config, jukebox });

    try {
      const res = await request(app)
        .post('/api/playlists/import')
        .send({ url: 'https://open.spotify.com/playlist/37i9dQZF1E8ABWfNWImBVL', enqueue: false })
        .expect(404);

      expect(res.body.error).toMatch(/Rádio\/Mix oficial do Spotify/i);
    } finally {
      jukebox.stop();
    }
  });
});
