import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { ClassifierService, normalizeGenreAndSubgenre } from '../src/services/classifier.js';
import { SpotifyService, type FetchFn } from '../src/services/spotify.js';
import { TrackRepository } from '../src/services/tracks.js';
import { setup, tempConfig } from './helpers.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('normalizeGenreAndSubgenre', () => {
  it('normalizes canonical categories and subgenres from external tags and BR heuristics', () => {
    expect(
      normalizeGenreAndSubgenre(['brazilian funk', 'funk carioca'], {
        title: 'Rap do Solitário',
        artist: 'MC Marcinho',
        year: 2002,
      }),
    ).toEqual({ genre: 'Funk', subgenre: 'Funk Anos 2000' });

    expect(
      normalizeGenreAndSubgenre([], {
        title: 'Set dos Mandrake (Funk Mandelão)',
        artist: 'MC Ryan SP',
      }),
    ).toEqual({ genre: 'Funk', subgenre: 'Funk Mandelão' });

    expect(
      normalizeGenreAndSubgenre(['pagode'], {
        title: 'Cheia de Manias',
        artist: 'Raça Negra',
        year: 1992,
      }),
    ).toEqual({ genre: 'Samba & Pagode', subgenre: 'Pagode 90' });

    expect(
      normalizeGenreAndSubgenre(['sertanejo'], {
        title: 'Evidências',
        artist: 'Chitãozinho & Xororó',
        year: 1990,
      }),
    ).toEqual({ genre: 'Sertanejo', subgenre: 'Sertanejo Raiz' });

    expect(
      normalizeGenreAndSubgenre([], {
        title: 'Meu Pedaço de Pecado',
        artist: 'João Gomes',
      }),
    ).toEqual({ genre: 'Forró & Piseiro', subgenre: 'Piseiro' });

    expect(
      normalizeGenreAndSubgenre(['pop'], {
        title: 'Take On Me',
        artist: 'a-ha',
        year: 1985,
      }),
    ).toEqual({ genre: 'Flashback', subgenre: 'Flashback 70s/80s' });
  });

  it('keeps Gospel strictly prioritized over Pop/Rock/MPB tags', () => {
    expect(
      normalizeGenreAndSubgenre(['brazilian pop', 'christian'], {
        title: 'Lugar Secreto',
        artist: 'Gabriela Rocha',
      }),
    ).toEqual({ genre: 'Gospel', subgenre: 'Louvor & Adoração' });

    expect(
      normalizeGenreAndSubgenre([], {
        title: 'Raridade',
        artist: 'Anderson Freire',
      }),
    ).toEqual({ genre: 'Gospel', subgenre: 'Gospel Pentecostal' });
  });
});

describe('ClassifierService cascade, cache and manual protection', () => {
  it('uses Spotify artist genres first, caches per artist, and falls back to iTunes then heuristics', async () => {
    const config = tempConfig({
      SPOTIFY_CLIENT_ID: 'cid',
      SPOTIFY_CLIENT_SECRET: 'csec',
    });
    const db = openDb(config.dbPath);
    const tracks = new TrackRepository(db);
    let spotifyCalls = 0;
    let itunesCalls = 0;

    const fetchFn: FetchFn = async (input) => {
      const url = String(input);
      if (url.includes('accounts.spotify.com/api/token')) {
        return jsonResponse({ access_token: 'app-tok', expires_in: 3600 });
      }
      if (url.includes('api.spotify.com/v1/search')) {
        spotifyCalls += 1;
        if (url.includes('Djavan')) {
          return jsonResponse({
            artists: { items: [{ id: 'art-dj', name: 'Djavan', genres: ['mpb', 'bossa nova'] }] },
          });
        }
        return jsonResponse({ artists: { items: [] } });
      }
      if (url.includes('itunes.apple.com/search')) {
        itunesCalls += 1;
        return jsonResponse({
          results: [
            {
              artistName: 'Alok',
              trackName: 'Hear Me Now',
              primaryGenreName: 'Electronic',
              releaseDate: '2016-10-21T07:00:00Z',
            },
          ],
        });
      }
      return jsonResponse({}, 404);
    };

    const { Settings } = await import('../src/db.js');
    const settings = new Settings(db);
    const spotify = new SpotifyService(config.spotify, settings, fetchFn);
    const classifier = new ClassifierService(db, tracks, spotify, fetchFn, () => {}, true);

    const t1 = tracks.insertLocal('/music/djavan1.mp3', { title: 'Sina (Official Audio)', artist: 'Djavan' });
    const t2 = tracks.insertLocal('/music/djavan2.mp3', { title: 'Flor de Lis', artist: 'Djavan' });
    const t3 = tracks.insertLocal('/music/alok.mp3', { title: 'Hear Me Now', artist: 'Alok' });

    const r1 = await classifier.classifyTrack(t1);
    expect(r1).toMatchObject({ updated: true, genre: 'MPB', subgenre: 'Bossa Nova', source: 'spotify' });
    expect(spotifyCalls).toBe(1);

    // Second track by same artist hits artist_genres cache instead of calling Spotify again.
    const r2 = await classifier.classifyTrack(t2);
    expect(r2).toMatchObject({ updated: true, genre: 'MPB', subgenre: 'Bossa Nova', source: 'cache' });
    expect(spotifyCalls).toBe(1);

    // Unknown on Spotify -> falls back to iTunes Search API and extracts year + genre.
    const r3 = await classifier.classifyTrack(t3);
    expect(r3).toMatchObject({ updated: true, genre: 'Eletrônica', subgenre: 'Brazilian Bass', source: 'itunes' });
    expect(itunesCalls).toBe(1);
    expect(tracks.get(t3.id)?.year).toBe(2016);
    db.close();
  });

  it('never overwrites tracks with genreManual=1 during autocategorize', async () => {
    const { config, jukebox } = setup({ HOST_PIN: '1234' });
    const app = createApp({ config, jukebox });

    fs.writeFileSync(path.join(config.musicDir, 'manual.mp3'), Buffer.alloc(64));
    fs.writeFileSync(path.join(config.musicDir, 'auto.mp3'), Buffer.alloc(64));

    const manual = jukebox.tracks.insertLocal(path.join(config.musicDir, 'manual.mp3'), {
      title: 'Rap do Solitário',
      artist: 'MC Marcinho',
    });
    const autoTrack = jukebox.tracks.insertLocal(path.join(config.musicDir, 'auto.mp3'), {
      title: 'Sina',
      artist: 'Djavan',
    });

    // Host manually sets custom category/subgenre -> sets genreManual = true
    await request(app)
      .patch(`/api/tracks/${manual.id}/metadata`)
      .set('x-host-pin', '1234')
      .send({ genre: 'Clássicos da Festa', subgenre: 'Especial' })
      .expect(200);

    // Protected endpoint requires HOST_PIN
    await request(app).post('/api/library/autocategorize').expect(403);

    const res = await request(app).post('/api/library/autocategorize').set('x-host-pin', '1234').expect(200);
    expect(res.body).toMatchObject({ processed: 1, updated: 1, skippedManual: 1, failed: 0 });

    expect(jukebox.tracks.get(manual.id)).toMatchObject({
      genre: 'Clássicos da Festa',
      subgenre: 'Especial',
      genreManual: true,
    });
    expect(jukebox.tracks.get(autoTrack.id)).toMatchObject({
      genre: 'MPB',
      subgenre: 'MPB Clássica',
      genreManual: false,
    });
  });
});
