import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { parseMetadataPatch } from '../src/lib/metadata.js';
import type { LocalTrackMeta } from '../src/services/tracks.js';
import { setup } from './helpers.js';

function makeApp(env: Record<string, string> = {}) {
  const ctx = setup(env);
  const app = createApp({ config: ctx.config, jukebox: ctx.jukebox });
  const add = (meta: LocalTrackMeta) => ctx.jukebox.tracks.insertLocal(`/music/${meta.artist}/${meta.album}/${meta.title}.mp3`, meta);
  return { ...ctx, app, add };
}

function seed(add: (meta: LocalTrackMeta) => unknown) {
  add({ title: 'Headlong', artist: 'Queen', album: 'Innuendo', genre: 'Rock', year: 1991, trackNumber: 2, durationSec: 280 });
  add({ title: 'Innuendo', artist: 'Queen', album: 'Innuendo', genre: 'rock', year: 1991, trackNumber: 1, durationSec: 390 });
  add({ title: 'Bonus', artist: 'Queen', album: 'Innuendo', genre: 'Rock', durationSec: 100 });
  add({ title: 'Love of My Life', artist: 'Queen', album: 'A Night at the Opera', genre: 'Rock', trackNumber: 9, durationSec: 220 });
  add({ title: 'Sina', artist: 'Djavan', album: 'Luz', genre: 'MPB', year: 1982, trackNumber: 3, durationSec: 250 });
  add({ title: 'Loose', artist: '', album: null, genre: null });
}

describe('catalog API', () => {
  it('groups categories case-insensitively with counts, only for ready tracks', async () => {
    const { app, add, jukebox } = makeApp();
    seed(add);
    const pending = add({ title: 'Pending', artist: 'X', album: 'Y', genre: 'Jazz' });
    jukebox.tracks.update(pending.id, { status: 'pending' });

    const res = await request(app).get('/api/catalog/categories').expect(200);
    expect(res.body.categories).toEqual([
      { name: 'MPB', trackCount: 1, albumCount: 1, artistCount: 1, cover: null, subcategories: [] },
      expect.objectContaining({ name: expect.stringMatching(/^rock$/i), trackCount: 4, albumCount: 2, artistCount: 1 }),
    ]);

    const tracks = await request(app).get(`/api/catalog/categories/${encodeURIComponent('ROCK')}/tracks`).expect(200);
    expect(tracks.body.tracks.map((t: { title: string }) => t.title)).toEqual(['Love of My Life', 'Innuendo', 'Headlong', 'Bonus']);
    expect(tracks.body.tracks[0]).toMatchObject({ source: 'local', genre: 'Rock', trackNumber: 9, trackId: expect.any(String) });
    expect((await request(app).get('/api/catalog/categories/Jazz/tracks').expect(200)).body.tracks).toEqual([]);
  });

  it('lists albums with totals and filters, and album tracks in track order', async () => {
    const { app, add } = makeApp();
    seed(add);
    const all = (await request(app).get('/api/catalog/albums').expect(200)).body.albums;
    expect(all.map((a: { name: string }) => a.name)).toEqual(['A Night at the Opera', 'Innuendo', 'Luz']);
    expect(all[1]).toEqual({
      name: 'Innuendo',
      artist: 'Queen',
      genre: expect.stringMatching(/^rock$/i),
      year: 1991,
      trackCount: 3,
      totalDurationSec: 770,
      cover: null,
    });

    const byCategory = (await request(app).get('/api/catalog/albums').query({ category: 'mpb' }).expect(200)).body.albums;
    expect(byCategory.map((a: { name: string }) => a.name)).toEqual(['Luz']);
    const byQuery = (await request(app).get('/api/catalog/albums').query({ q: 'opera' }).expect(200)).body.albums;
    expect(byQuery.map((a: { name: string }) => a.name)).toEqual(['A Night at the Opera']);
    expect((await request(app).get('/api/catalog/albums').query({ q: '%' }).expect(200)).body.albums).toEqual([]);

    const tracks = (await request(app).get('/api/catalog/albums/innuendo/tracks').query({ artist: 'queen' }).expect(200)).body;
    expect(tracks.tracks.map((t: { title: string }) => t.title)).toEqual(['Innuendo', 'Headlong', 'Bonus']);
    const wrongArtist = (await request(app).get('/api/catalog/albums/Innuendo/tracks').query({ artist: 'Djavan' }).expect(200)).body;
    expect(wrongArtist.tracks).toEqual([]);
  });

  it('lists artists and artist details', async () => {
    const { app, add } = makeApp();
    seed(add);
    const artists = (await request(app).get('/api/catalog/artists').expect(200)).body.artists;
    expect(artists).toEqual([
      { name: 'Djavan', albumCount: 1, trackCount: 1, cover: null },
      { name: 'Queen', albumCount: 2, trackCount: 4, cover: null },
    ]);

    const queen = (await request(app).get('/api/catalog/artists/queen').expect(200)).body;
    expect(queen).toMatchObject({ name: 'Queen', albumCount: 2, trackCount: 4 });
    expect(queen.albums.map((a: { name: string }) => a.name)).toEqual(['A Night at the Opera', 'Innuendo']);
    expect(queen.tracks.map((t: { title: string }) => t.title)).toEqual(['Love of My Life', 'Innuendo', 'Headlong', 'Bonus']);
    await request(app).get('/api/catalog/artists/Nobody').expect(404);
  });

  it('lets the host edit track metadata (403 without the PIN, 400 on invalid payload)', async () => {
    const { app, add, jukebox } = makeApp({ HOST_PIN: '1234' });
    const track = add({ title: 'Untitled', artist: '', album: null, genre: null }) as { id: string };
    const url = `/api/tracks/${track.id}/metadata`;
    const body = { title: 'Sina', artist: 'Djavan', album: 'Luz', genre: 'MPB', year: 1982, trackNumber: 3 };

    await request(app).patch(url).send(body).expect(403);
    await request(app).patch(url).set('x-host-pin', 'nope').send(body).expect(403);
    await request(app).patch(url).set('x-host-pin', '1234').send({ year: 'abc' }).expect(400);
    await request(app).patch(url).set('x-host-pin', '1234').send({ title: '  ' }).expect(400);
    await request(app).patch(url).set('x-host-pin', '1234').send({ filePath: '/etc/passwd' }).expect(400);
    await request(app).patch('/api/tracks/missing/metadata').set('x-host-pin', '1234').send(body).expect(404);
    expect(jukebox.tracks.get(track.id)).toMatchObject({ title: 'Untitled', genre: null });

    const res = await request(app).patch(url).set('x-host-pin', '1234').send({ ...body, subgenre: 'MPB Clássica' }).expect(200);
    expect(res.body).toMatchObject({ id: track.id, ...body, subgenre: 'MPB Clássica', genreManual: true });
    expect((await request(app).get('/api/catalog/categories').expect(200)).body.categories).toEqual([
      expect.objectContaining({
        name: 'MPB',
        trackCount: 1,
        subcategories: [{ name: 'MPB Clássica', trackCount: 1, cover: null }],
      }),
    ]);
    const subFiltered = await request(app).get('/api/catalog/categories/MPB/tracks').query({ subgenre: 'MPB Clássica' }).expect(200);
    expect(subFiltered.body.tracks).toHaveLength(1);
    expect(subFiltered.body.subcategories).toEqual([{ name: 'MPB Clássica', trackCount: 1, cover: null }]);

    const cleared = await request(app).patch(url).set('x-host-pin', '1234').send({ genre: null, subgenre: '', album: '' }).expect(200);
    expect(cleared.body).toMatchObject({ genre: null, subgenre: null, album: null, title: 'Sina', genreManual: true });
  });
});

describe('parseMetadataPatch', () => {
  it('validates and normalizes fields', () => {
    expect(parseMetadataPatch({ title: ' A ', genre: '', subgenre: ' Pagode 90 ', year: null })).toEqual({
      ok: true,
      patch: { title: 'A', genre: null, subgenre: 'Pagode 90', year: null },
    });
    expect(parseMetadataPatch(null)).toMatchObject({ ok: false });
    expect(parseMetadataPatch([])).toMatchObject({ ok: false });
    expect(parseMetadataPatch({})).toMatchObject({ ok: false });
    expect(parseMetadataPatch({ artist: null })).toMatchObject({ ok: false });
    expect(parseMetadataPatch({ year: 1991.5 })).toMatchObject({ ok: false });
    expect(parseMetadataPatch({ trackNumber: 0 })).toMatchObject({ ok: false });
    expect(parseMetadataPatch({ genre: 'x'.repeat(101) })).toMatchObject({ ok: false });
  });
});
