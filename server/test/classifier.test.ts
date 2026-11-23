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

  it('prevents substring false positives, Djonga conflict, and Gospel over-matching', () => {
    expect(
      normalizeGenreAndSubgenre([], {
        title: '2345meia78',
        artist: 'Gabriel O Pensador',
      }),
    ).toEqual({ genre: 'Rap & Trap', subgenre: 'Rap Nacional' });

    expect(
      normalizeGenreAndSubgenre([], {
        title: 'Leal',
        artist: 'Djonga',
      }),
    ).toEqual({ genre: 'Rap & Trap', subgenre: 'Rap Nacional' });

    expect(
      normalizeGenreAndSubgenre([], {
        title: 'Saudade',
        artist: 'Christian & Ralf',
      }),
    ).toEqual({ genre: 'Sertanejo', subgenre: 'Sertanejo Raiz' });

    expect(
      normalizeGenreAndSubgenre(['samba'], {
        title: 'Louvor à Mangueira',
        artist: 'Escola de Samba',
      }),
    ).toEqual({ genre: 'Samba & Pagode', subgenre: 'Samba Raiz' });

    expect(
      normalizeGenreAndSubgenre([], {
        title: 'Louvor à Mangueira',
        artist: 'Desconhecido',
      }),
    ).toBeNull();

    expect(
      normalizeGenreAndSubgenre(['popular', 'gypsy'], {
        title: 'Brown Umbrella',
        artist: 'Unknown Artist',
      }),
    ).toBeNull();
  });

  it('does not poison artist_genres on failures or individual track genres, preserves year, and normalizes legacy ID3 genres', async () => {
    const config = tempConfig();
    const db = openDb(config.dbPath);
    const tracks = new TrackRepository(db);
    let itunesAttempt = 0;

    const fetchFn: FetchFn = async (input) => {
      const url = String(input);
      if (url.includes('itunes.apple.com/search')) {
        itunesAttempt += 1;
        if (itunesAttempt === 1) {
          return jsonResponse({}, 503);
        }
        if (url.includes('YearOnly')) {
          return jsonResponse({
            results: [{ artistName: 'YearOnly', trackName: 'Retro', releaseDate: '1984-05-01T00:00:00Z' }],
          });
        }
        if (url.includes('Recuperado')) {
          return jsonResponse({
            results: [{ artistName: 'Recuperado', trackName: 'Faixa 2', primaryGenreName: 'Sertanejo', releaseDate: '2020-01-01T00:00:00Z' }],
          });
        }
        return jsonResponse({ results: [] });
      }
      return jsonResponse({}, 404);
    };

    const classifier = new ClassifierService(db, tracks, undefined, fetchFn, () => {}, true);

    const t1 = tracks.insertLocal('/music/rec1.mp3', { title: 'Faixa 1', artist: 'Recuperado', genre: 'Funk' });
    await classifier.classifyTrack(t1);
    expect(db.prepare('SELECT * FROM artist_genres WHERE artist_key = ?').get('recuperado')).toBeUndefined();

    // Subsequent track by the same artist must still hit iTunes (not blocked by a poisoned heuristic cache)
    // and must not inherit t1's individual ID3 genre.
    const t2 = tracks.insertLocal('/music/rec2.mp3', { title: 'Faixa 2', artist: 'Recuperado' });
    const r2 = await classifier.classifyTrack(t2);
    expect(r2).toMatchObject({ updated: true, genre: 'Sertanejo', source: 'itunes' });
    expect(itunesAttempt).toBe(2);

    // Year-only external response must still be persisted and feed the 70s/80s Flashback heuristic.
    const tYear = tracks.insertLocal('/music/yearonly.mp3', { title: 'Retro', artist: 'YearOnly' });
    const rYear = await classifier.classifyTrack(tYear);
    expect(rYear).toMatchObject({ updated: true, genre: 'Flashback', subgenre: 'Flashback 70s/80s' });
    expect(tracks.get(tYear.id)?.year).toBe(1984);

    // Legacy non-canonical ID3 tags with genreManual=0 must be normalized to canonical categories.
    const legacy = tracks.insertLocal('/music/legacy.mp3', {
      title: 'Tempo Perdido',
      artist: 'Legião Urbana',
      genre: 'Brazilian Rock',
      subgenre: 'Rock Nacional',
    });
    const summary = await classifier.autocategorizeAll();
    expect(summary.updatedTrackIds).toContain(legacy.id);
    expect(tracks.get(legacy.id)).toMatchObject({ genre: 'Rock', subgenre: 'Rock Nacional' });
    db.close();
  });

  it('clears autoDjSubgenre on category change, annotates search with genres, and classifies Spotify tracks without local download', async () => {
    const fetchFn: FetchFn = async (input) => {
      const url = String(input);
      if (url.includes('itunes.apple.com/search')) {
        return jsonResponse({
          results: [{ artistName: 'Djavan', trackName: 'Oceano', primaryGenreName: 'MPB', releaseDate: '1989-01-01T00:00:00Z' }],
        });
      }
      return jsonResponse({}, 404);
    };
    const { config, jukebox } = setup({ HOST_PIN: '1234' }, fetchFn);
    const app = createApp({ config, jukebox });

    await request(app)
      .post('/api/config/autodj')
      .set('x-host-pin', '1234')
      .send({ mode: 'category', category: 'Funk', subgenre: 'Funk Mandelão' })
      .expect(200);

    const switched = await request(app)
      .post('/api/config/autodj')
      .set('x-host-pin', '1234')
      .send({ mode: 'category', category: 'Samba & Pagode' })
      .expect(200);
    expect(switched.body).toMatchObject({ autoDjMode: 'category', autoDjCategory: 'Samba & Pagode', autoDjSubgenre: null });

    // Stored YouTube track should expose genre/subgenre when returned by unified search annotate()
    const ytTrack = jukebox.tracks.upsertFromResult({
      source: 'youtube',
      sourceId: 'yt000000000',
      title: 'test song 0',
      artist: 'Djavan',
      durationSec: 200,
    });
    jukebox.tracks.update(ytTrack.id, { status: 'ready', genre: 'MPB', subgenre: 'MPB Clássica' });

    const searchRes = await request(app).get('/api/search').query({ q: 'test song', source: 'youtube' }).expect(200);
    expect(searchRes.body.results[0]).toMatchObject({
      source: 'youtube',
      sourceId: 'yt000000000',
      trackId: ytTrack.id,
      genre: 'MPB',
      subgenre: 'MPB Clássica',
    });

    // Spotify track without local download (status = error/pending) is still eligible for autocategorizeAll()
    const spotifyPending = jukebox.tracks.upsertFromResult({
      source: 'spotify',
      sourceId: 'sp1234567890',
      title: 'Oceano',
      artist: 'Djavan',
      durationSec: 230,
      spotifyUri: 'spotify:track:sp1234567890',
    });
    jukebox.tracks.update(spotifyPending.id, { status: 'error' });

    // Coalesce concurrent autocategorizeLibrary() runs
    const [s1, s2] = await Promise.all([jukebox.autocategorizeLibrary(), jukebox.autocategorizeLibrary()]);
    expect(s1).toEqual(s2);
    expect(jukebox.tracks.get(spotifyPending.id)).toMatchObject({ genre: 'MPB', subgenre: 'MPB Clássica' });
  });
});
