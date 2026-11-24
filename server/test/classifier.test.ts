import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import {
  ClassifierService,
  artistsMatch,
  cleanTrackMetadataForClassification,
  extractArtistCandidates,
  normalizeGenreAndSubgenre,
} from '../src/services/classifier.js';
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

  it('cleans YouTube/Spotify noise, preserves MTG signal, splits multi-artists safely, and extracts empty artist', () => {
    expect(cleanTrackMetadataForClassification('Minha Música (Visualizer) [2023 Remaster] {Full Album}', 'Tocanna - Topic')).toMatchObject({
      title: 'Minha Música',
      artist: 'Tocanna',
      extractedArtistFromTitle: false,
    });

    expect(cleanTrackMetadataForClassification('4_AQUELA MINA DE VERMELHO (Oficial)', 'DJ ARANA Oficial')).toMatchObject({
      title: 'AQUELA MINA DE VERMELHO',
      artist: 'DJ ARANA',
    });

    expect(cleanTrackMetadataForClassification('DJ YAN DO FLAMENGO (MTG)', '')).toMatchObject({
      title: 'DJ YAN DO FLAMENGO',
      artist: '',
      signals: ['mtg'],
      extractedArtistFromTitle: false,
    });

    expect(cleanTrackMetadataForClassification('Zeca Pagodinho - Quando A Gira Girou', '')).toMatchObject({
      title: 'Quando A Gira Girou',
      artist: 'Zeca Pagodinho',
      extractedArtistFromTitle: true,
    });

    // Unsafe splits like "- Ao Vivo" must NOT turn song title into artist
    expect(cleanTrackMetadataForClassification('Saudade Demais - Ao Vivo', '')).toMatchObject({
      title: 'Saudade Demais - Ao Vivo',
      artist: '',
      extractedArtistFromTitle: false,
    });

    expect(extractArtistCandidates('Tyler, The Creator')).toEqual(['Tyler, The Creator']);
    expect(extractArtistCandidates('Chitãozinho & Xororó')).toEqual(['Chitãozinho & Xororó', 'Chitãozinho', 'Xororó']);
    expect(extractArtistCandidates('DJ Arana x MC Pipokinha')).toEqual(['DJ Arana x MC Pipokinha', 'DJ Arana', 'MC Pipokinha']);
    expect(extractArtistCandidates('DJ JZ, Mc Fael Halls')).toEqual(['DJ JZ', 'Mc Fael Halls']);
    expect(extractArtistCandidates('Anitta feat. MC Zaac & Tropkillaz')).toEqual([
      'Anitta',
      'MC Zaac & Tropkillaz',
      'MC Zaac',
      'Tropkillaz',
    ]);
    expect(extractArtistCandidates('Anitta', 'Minha Música (ft. Tropkillaz)')).toEqual(['Anitta', 'Tropkillaz']);
    expect(cleanTrackMetadataForClassification('Minha Música (feat. MC Zaac) [Official Video]', 'Anitta').artistCandidates).toEqual([
      'Anitta',
      'MC Zaac',
    ]);
    expect(cleanTrackMetadataForClassification('Chitaozinho - Evidências', 'Chitãozinho')).toMatchObject({
      artist: 'Chitaozinho',
      title: 'Evidências',
    });
  });

  it('accurately classifies all audited BR Funk, Eletrônica, Rap Intl and empty-artist cases without AI', async () => {
    const config = tempConfig();
    const db = openDb(config.dbPath);
    const tracks = new TrackRepository(db);
    const seenUrls: string[] = [];

    const fetchFn: FetchFn = async (input) => {
      const url = String(input);
      seenUrls.push(url);
      if (url.includes('api.deezer.com/search') && url.includes('Tocanna')) {
        return jsonResponse({
          data: [
            {
              id: 777,
              title: 'Noite Clara',
              artist: { id: 77, name: 'Tocanna' },
              album: { id: 88, title: 'Noite Clara', genre_id: 132 },
            },
          ],
        });
      }
      if (url.includes('api.deezer.com/genre/132')) {
        return jsonResponse({ id: 132, name: 'Pop' });
      }
      if (url.includes('itunes.apple.com/search')) {
        // Homonymous wrong-artist match for "Baile do Bruxo" must be rejected by strict validation!
        if (url.includes('Baile+do+Bruxo') || url.includes('Tropa+do+Bruxo')) {
          return jsonResponse({
            results: [
              {
                artistName: 'Banda Piseiro Fake',
                trackName: 'Baile do Bruxo',
                primaryGenreName: 'Forró',
                releaseDate: '2024-01-01T00:00:00Z',
              },
            ],
          });
        }
        // Even if iTunes tags MTG as Hip-Hop/Rap, deterministic Funk MTG rule must prevail.
        if (url.includes('DJ+JZ') || url.includes('Mc+Fael+Halls')) {
          return jsonResponse({
            results: [
              {
                artistName: 'DJ JZ',
                trackName: 'MTG Pra Ficar Legal',
                primaryGenreName: 'Hip-Hop/Rap',
              },
            ],
          });
        }
        return jsonResponse({ results: [] });
      }
      return jsonResponse({}, 404);
    };

    const classifier = new ClassifierService(db, tracks, undefined, fetchFn, () => {}, true, {
      musicBrainzMinIntervalMs: 0,
    });

    const tropa = tracks.insertLocal('/music/tropa.mp3', {
      title: 'Baile do Bruxo',
      artist: 'Tropa do Bruxo',
    });
    const arana = tracks.insertLocal('/music/arana.mp3', {
      title: '4_AQUELA MINA DE VERMELHO',
      artist: 'DJ ARANA',
    });
    const mtgFael = tracks.insertLocal('/music/mtg-fael.mp3', {
      title: 'MTG Pra Ficar Legal',
      artist: 'DJ JZ, Mc Fael Halls',
    });
    const mtgYan = tracks.insertLocal('/music/mtg-yan.mp3', {
      title: 'DJ YAN DO FLAMENGO (MTG)',
      artist: '',
    });
    const djMc = tracks.insertLocal('/music/dj-mc.mp3', {
      title: 'Rolê na Quebrada',
      artist: 'DJ YAN MARIOTO, MC Marlon PH',
    });
    const afterclapp = tracks.insertLocal('/music/afterclapp.mp3', {
      title: 'Bota Pra Ferver',
      artist: 'Afterclapp',
    });
    const tyler = tracks.insertLocal('/music/tyler.mp3', {
      title: 'Glitter',
      artist: 'Tyler, The Creator',
    });
    const tocanna = tracks.insertLocal('/music/tocanna.mp3', {
      title: 'Noite Clara (Visualizer) [2023 Remaster] {Full Album}',
      artist: 'Tocanna - Topic',
    });
    const zeca = tracks.insertLocal('/music/zeca.mp3', {
      title: 'Zeca Pagodinho - Quando A Gira Girou',
      artist: '',
    });

    const summary = await classifier.autocategorizeAll();
    expect(summary.failed).toBe(0);

    expect(tracks.get(tropa.id)).toMatchObject({ genre: 'Funk', subgenre: 'Funk Bruxaria' });
    expect(tracks.get(arana.id)).toMatchObject({ genre: 'Funk', subgenre: 'Funk Bruxaria' });
    expect(tracks.get(mtgFael.id)).toMatchObject({ genre: 'Funk', subgenre: 'Funk MTG' });
    expect(tracks.get(mtgYan.id)).toMatchObject({ genre: 'Funk', subgenre: 'Funk MTG' });
    expect(tracks.get(djMc.id)).toMatchObject({ genre: 'Funk' });
    expect(tracks.get(afterclapp.id)).toMatchObject({ genre: 'Eletrônica', subgenre: 'Brazilian Bass' });
    expect(tracks.get(tyler.id)).toMatchObject({ genre: 'Rap & Trap', subgenre: 'Hip Hop Internacional' });
    expect(tracks.get(tocanna.id)).toMatchObject({ genre: 'Pop' });
    expect(tracks.get(zeca.id)).toMatchObject({
      artist: 'Zeca Pagodinho',
      title: 'Quando A Gira Girou',
      genre: 'Samba & Pagode',
      subgenre: 'Samba Raiz',
    });

    // External APIs must receive cleaned Tocanna metadata (no "- Topic", "(Visualizer)", etc.)
    const tocannaUrls = seenUrls.filter((u) => u.includes('Tocanna') || u.includes('Noite'));
    expect(tocannaUrls.length).toBeGreaterThan(0);
    expect(tocannaUrls.every((u) => !u.includes('Topic') && !u.includes('Visualizer') && !u.includes('Remaster'))).toBe(true);

    // Automotivo & Bololô deterministic heuristics
    expect(normalizeGenreAndSubgenre([], { title: 'Automotivo Sinistro', artist: 'DJ Desconhecido' })).toEqual({
      genre: 'Funk',
      subgenre: 'Funk Automotivo',
    });
    expect(normalizeGenreAndSubgenre([], { title: 'Bololô na Favela', artist: 'MC Desconhecido' })).toEqual({
      genre: 'Funk',
      subgenre: 'Funk Mandelão',
    });

    db.close();
  });

  it('uses Deezer and MusicBrainz fallbacks when Spotify returns genres: [] and caches results', async () => {
    const config = tempConfig({
      SPOTIFY_CLIENT_ID: 'cid',
      SPOTIFY_CLIENT_SECRET: 'csec',
    });
    const db = openDb(config.dbPath);
    const tracks = new TrackRepository(db);
    let mbCalls = 0;
    const mbHeaders: string[] = [];

    const fetchFn: FetchFn = async (input, init) => {
      const url = String(input);
      if (url.includes('accounts.spotify.com/api/token')) {
        return jsonResponse({ access_token: 'app-tok', expires_in: 3600 });
      }
      if (url.includes('api.spotify.com/v1/search')) {
        // Spotify returns artist with empty genres: [] (very common for newer artists)
        return jsonResponse({
          artists: { items: [{ id: 'sp-1', name: 'Artista Novo', genres: [] }] },
        });
      }
      if (url.includes('api.deezer.com/search')) {
        if (url.includes('Novo+Indie')) {
          return jsonResponse({
            data: [
              {
                id: 101,
                title: 'Som Novo',
                artist: { id: 1, name: 'Novo Indie' },
                album: { id: 55, title: 'EP 1', genre_id: 152 },
              },
            ],
          });
        }
        return jsonResponse({ data: [] });
      }
      if (url.includes('api.deezer.com/genre/152')) {
        return jsonResponse({ id: 152, name: 'Rock' });
      }
      if (url.includes('itunes.apple.com/search')) {
        return jsonResponse({ results: [] });
      }
      if (url.includes('musicbrainz.org/ws/2/artist')) {
        mbCalls += 1;
        const ua = new Headers(init?.headers).get('User-Agent') ?? '';
        mbHeaders.push(ua);
        if (url.includes('Tyler')) {
          return jsonResponse({
            artists: [
              {
                id: 'mb-tyler',
                name: 'Tyler, The Creator',
                score: 100,
                tags: [
                  { count: 12, name: 'seen live' },
                  { count: 10, name: 'hip hop' },
                ],
              },
            ],
          });
        }
        if (url.includes('Banda+MB')) {
          return jsonResponse({
            artists: [
              {
                id: 'mb-banda',
                name: 'Banda MB',
                score: 98,
                genres: [{ count: 4, name: 'brazilian bass' }],
              },
            ],
          });
        }
        return jsonResponse({ artists: [] });
      }
      return jsonResponse({}, 404);
    };

    const { Settings } = await import('../src/db.js');
    const settings = new Settings(db);
    const spotify = new SpotifyService(config.spotify, settings, fetchFn);
    const classifier = new ClassifierService(db, tracks, spotify, fetchFn, () => {}, true, {
      musicBrainzMinIntervalMs: 0,
    });

    const tDeezer = tracks.insertLocal('/music/deezer.mp3', { title: 'Som Novo', artist: 'Novo Indie' });
    const rDeezer = await classifier.classifyTrack(tDeezer);
    expect(rDeezer).toMatchObject({ updated: true, genre: 'Rock', source: 'deezer' });

    const tMb = tracks.insertLocal('/music/mb-tyler.mp3', { title: 'Glitter', artist: 'Tyler, The Creator' });
    const rMb = await classifier.classifyTrack(tMb);
    expect(rMb).toMatchObject({
      updated: true,
      genre: 'Rap & Trap',
      subgenre: 'Hip Hop Internacional',
      source: 'musicbrainz',
    });
    expect(mbHeaders[0]).toContain('jkbox-studio/');

    // Second track for Tyler, The Creator hits artist_genres cache (no extra MusicBrainz call).
    const tMb2 = tracks.insertLocal('/music/mb-tyler2.mp3', { title: 'Earfquake', artist: 'Tyler, The Creator' });
    const rMb2 = await classifier.classifyTrack(tMb2);
    expect(rMb2).toMatchObject({ updated: true, genre: 'Rap & Trap', source: 'cache' });
    expect(mbCalls).toBe(1);

    // MusicBrainz artist with brazilian bass tag maps to Eletrônica / Brazilian Bass
    const tMbElec = tracks.insertLocal('/music/mb-elec.mp3', { title: 'Pulse', artist: 'Banda MB' });
    const rMbElec = await classifier.classifyTrack(tMbElec);
    expect(rMbElec).toMatchObject({ updated: true, genre: 'Eletrônica', subgenre: 'Brazilian Bass', source: 'musicbrainz' });

    db.close();
  });

  it('supports force re-classification on POST /api/library/autocategorize while always preserving genre_manual=1', async () => {
    const { config, jukebox } = setup({ HOST_PIN: '1234' });
    const app = createApp({ config, jukebox });

    fs.writeFileSync(path.join(config.musicDir, 'wrong-auto.mp3'), Buffer.alloc(64));
    fs.writeFileSync(path.join(config.musicDir, 'manual-lock.mp3'), Buffer.alloc(64));

    const wrongAuto = jukebox.tracks.insertLocal(path.join(config.musicDir, 'wrong-auto.mp3'), {
      title: 'Baile do Bruxo',
      artist: 'Tropa do Bruxo',
      genre: 'Forró & Piseiro',
      subgenre: 'Piseiro',
    });
    const manualLocked = jukebox.tracks.insertLocal(path.join(config.musicDir, 'manual-lock.mp3'), {
      title: 'MTG Pra Ficar Legal',
      artist: 'DJ JZ, Mc Fael Halls',
    });
    await request(app)
      .patch(`/api/tracks/${manualLocked.id}/metadata`)
      .set('x-host-pin', '1234')
      .send({ genre: 'MPB', subgenre: 'Nova MPB' })
      .expect(200);

    // Invalid force type returns 400
    await request(app)
      .post('/api/library/autocategorize')
      .set('x-host-pin', '1234')
      .send({ force: 'yes' })
      .expect(400);

    // Without force, already-categorized wrongAuto is skipped
    const normalRes = await request(app)
      .post('/api/library/autocategorize')
      .set('x-host-pin', '1234')
      .send({ force: false })
      .expect(200);
    expect(normalRes.body).toMatchObject({ processed: 0, updated: 0, skippedManual: 1 });
    expect(jukebox.tracks.get(wrongAuto.id)).toMatchObject({ genre: 'Forró & Piseiro', subgenre: 'Piseiro' });

    // With force=true, wrongAuto is re-classified to Funk / Funk Bruxaria, while manualLocked remains untouched
    const forcedRes = await request(app)
      .post('/api/library/autocategorize')
      .set('x-host-pin', '1234')
      .send({ force: true })
      .expect(200);
    expect(forcedRes.body).toMatchObject({ processed: 1, updated: 1, skippedManual: 1, failed: 0 });
    expect(jukebox.tracks.get(wrongAuto.id)).toMatchObject({
      genre: 'Funk',
      subgenre: 'Funk Bruxaria',
      genreManual: false,
    });
    expect(jukebox.tracks.get(manualLocked.id)).toMatchObject({
      genre: 'MPB',
      subgenre: 'Nova MPB',
      genreManual: true,
    });
  });

  it('prevents Uptown Funk false positive, supports Baile de/dos/das, validates Deezer/MB queries, rejects blind Spotify items[0], and coalesces concurrent force runs', async () => {
    // 1. Generic "funk" in title must NOT override Pop / Soul & Funk external genres, while Baile de/dos/das matches Funk BR.
    expect(
      normalizeGenreAndSubgenre(['Pop', 'Soul & Funk'], {
        title: 'Uptown Funk',
        artist: 'Mark Ronson',
      }),
    ).toEqual({ genre: 'Pop', subgenre: null });
    expect(normalizeGenreAndSubgenre([], { title: 'Baile de Favela', artist: 'MC Joao' })?.genre).toBe('Funk');
    expect(normalizeGenreAndSubgenre([], { title: 'Baile dos Cria', artist: 'MC Desconhecido' })?.genre).toBe('Funk');
    expect(normalizeGenreAndSubgenre([], { title: 'Baile das Novinhas', artist: 'MC Desconhecido' })?.genre).toBe('Funk');

    // 2. Strict artist match helper rejects generic tokens and matches accented variants.
    expect(artistsMatch(['MC'], 'MC Marcinho')).toBe(false);
    expect(artistsMatch(['Legiao Urbana'], 'Legião Urbana')).toBe(true);

    // 3. Spotify searchArtistGenres must NOT pick unrelated items[0]; Deezer ignores non-integer album IDs; MusicBrainz escapes Lucene quotes/backslashes.
    const config = tempConfig({
      SPOTIFY_CLIENT_ID: 'cid',
      SPOTIFY_CLIENT_SECRET: 'csec',
    });
    const db = openDb(config.dbPath);
    const tracks = new TrackRepository(db);
    const requestedUrls: string[] = [];

    const fetchFn: FetchFn = async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes('accounts.spotify.com/api/token')) {
        return jsonResponse({ access_token: 'app-tok', expires_in: 3600 });
      }
      if (url.includes('api.spotify.com/v1/search')) {
        return jsonResponse({
          artists: { items: [{ id: 'wrong', name: 'Homônimo Totalmente Diferente', genres: ['country'] }] },
        });
      }
      if (url.includes('api.deezer.com/search')) {
        return jsonResponse({
          data: [
            {
              id: 500,
              title: 'Safe Track',
              artist: { id: 50, name: 'Artista "Teste" \\ BR' },
              album: { id: 'not-an-int' as unknown as number, title: 'EP' },
            },
          ],
        });
      }
      if (url.includes('itunes.apple.com/search')) {
        return jsonResponse({ results: [] });
      }
      if (url.includes('musicbrainz.org/ws/2/artist')) {
        return jsonResponse({
          artists: [
            {
              id: 'mb-esc',
              name: 'Artista Teste BR',
              score: 99,
              genres: [{ count: 3, name: 'mpb' }],
            },
          ],
        });
      }
      return jsonResponse({}, 404);
    };

    const { Settings } = await import('../src/db.js');
    const settings = new Settings(db);
    const spotify = new SpotifyService(config.spotify, settings, fetchFn);
    expect(await spotify.searchArtistGenres('Artista Desconhecido')).toEqual([]);

    const classifier = new ClassifierService(db, tracks, spotify, fetchFn, () => {}, true, {
      musicBrainzMinIntervalMs: 0,
    });
    const tEscaped = tracks.insertLocal('/music/escaped.mp3', {
      title: 'Safe Track',
      artist: 'Artista "Teste" \\ BR',
    });
    const res = await classifier.classifyTrack(tEscaped);
    expect(res).toMatchObject({ updated: true, genre: 'MPB', source: 'musicbrainz' });
    expect(requestedUrls.some((u) => u.includes('api.deezer.com/album/'))).toBe(false);
    const mbUrl = requestedUrls.find((u) => u.includes('musicbrainz.org/ws/2/artist')) ?? '';
    const mbQuery = new URL(mbUrl).searchParams.get('query') ?? '';
    expect(mbQuery).toBe('artist:"Artista \\"Teste\\" \\\\ BR"');
    db.close();

    // 4. Coalescing concurrent force:true calls while a non-forced run is in flight must execute force:true only once.
    const { jukebox } = setup({ HOST_PIN: '1234' });
    let releaseNonForced!: () => void;
    const nonForcedGate = new Promise<void>((resolve) => {
      releaseNonForced = resolve;
    });
    let forceCalls = 0;
    const fakeClassifier = jukebox.classifier!;
    fakeClassifier.autocategorizeAll = async ({ force } = {}) => {
      if (!force) {
        await nonForcedGate;
        return { processed: 0, updated: 0, skippedManual: 0, failed: 0, updatedTrackIds: [] };
      }
      forceCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { processed: 1, updated: 1, skippedManual: 0, failed: 0, updatedTrackIds: [] };
    };

    const pNormal = jukebox.autocategorizeLibrary({ force: false });
    const pForce1 = jukebox.autocategorizeLibrary({ force: true });
    const pForce2 = jukebox.autocategorizeLibrary({ force: true });
    releaseNonForced();
    const [, rForce1, rForce2] = await Promise.all([pNormal, pForce1, pForce2]);
    expect(forceCalls).toBe(1);
    expect(rForce1).toEqual(rForce2);
  });
});
