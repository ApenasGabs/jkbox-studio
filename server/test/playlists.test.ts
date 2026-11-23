import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createJukebox } from '../src/container.js';
import { FakeMedia, setup } from './helpers.js';

function makeApp(env: Record<string, string> = {}) {
  const ctx = setup(env);
  const app = createApp({ config: ctx.config, jukebox: ctx.jukebox });
  const addLocal = (name: string, opts: { genre?: string; thumbnail?: string | null; ready?: boolean } = {}) => {
    const file = path.join(ctx.config.musicDir, `${name}.mp3`);
    fs.writeFileSync(file, Buffer.alloc(128, 1));
    const track = ctx.jukebox.tracks.insertLocal(file, {
      title: name,
      artist: `Artista ${name}`,
      genre: opts.genre ?? null,
    });
    if (opts.thumbnail !== undefined) {
      ctx.jukebox.tracks.update(track.id, { thumbnail: opts.thumbnail });
    }
    if (opts.ready === false) {
      ctx.jukebox.tracks.update(track.id, { status: 'pending' });
    }
    return ctx.jukebox.tracks.get(track.id)!;
  };
  return { ...ctx, app, addLocal };
}

describe('internal playlists API & Auto-DJ', () => {
  it('enforces HOST_PIN on mutations and supports CRUD + validation', async () => {
    const { app, addLocal } = makeApp({ HOST_PIN: '4321' });
    const t1 = addLocal('Pagode 1', { genre: 'Samba & Pagode', thumbnail: 'https://img.test/p1.jpg' });

    await request(app).post('/api/playlists').send({ name: 'Churrasco' }).expect(403);
    await request(app).post('/api/playlists').set('x-host-pin', '4321').send({ name: '   ' }).expect(400);

    const created = await request(app)
      .post('/api/playlists')
      .set('x-host-pin', '4321')
      .send({ name: 'Churrasco', description: 'Domingão com a galera' })
      .expect(201);
    expect(created.body).toMatchObject({
      id: expect.any(String),
      name: 'Churrasco',
      description: 'Domingão com a galera',
      trackCount: 0,
      cover: null,
    });

    // Duplicate case-insensitive name -> 409
    await request(app)
      .post('/api/playlists')
      .set('x-host-pin', '4321')
      .send({ name: 'churrasco' })
      .expect(409);

    // Add track -> cover & trackCount update
    await request(app)
      .post(`/api/playlists/${created.body.id}/tracks`)
      .send({ trackId: t1.id })
      .expect(403);
    const added = await request(app)
      .post(`/api/playlists/${created.body.id}/tracks`)
      .set('x-host-pin', '4321')
      .send({ trackId: t1.id })
      .expect(201);
    expect(added.body).toMatchObject({ added: true, duplicate: false });

    const listWithTrack = await request(app).get('/api/playlists').query({ trackId: t1.id }).expect(200);
    expect(listWithTrack.body.playlists).toEqual([
      expect.objectContaining({
        id: created.body.id,
        name: 'Churrasco',
        trackCount: 1,
        cover: 'https://img.test/p1.jpg',
        containsTrack: true,
      }),
    ]);

    // Rename & update description
    await request(app).patch(`/api/playlists/${created.body.id}`).send({ name: 'Festa' }).expect(403);
    const renamed = await request(app)
      .patch(`/api/playlists/${created.body.id}`)
      .set('x-host-pin', '4321')
      .send({ name: 'Churrasco VIP', description: null })
      .expect(200);
    expect(renamed.body).toMatchObject({ name: 'Churrasco VIP', description: null });

    // Delete
    await request(app).delete(`/api/playlists/${created.body.id}`).expect(403);
    await request(app).delete(`/api/playlists/${created.body.id}`).set('x-host-pin', '4321').expect(204);
    await request(app).get(`/api/playlists/${created.body.id}`).expect(404);
  });

  it('supports N:N tracks across multiple playlists, ordering, removal, and ON DELETE CASCADE', async () => {
    const { app, addLocal, jukebox } = makeApp();
    const t1 = addLocal('Evidências', { genre: 'Sertanejo', thumbnail: 'https://img.test/1.jpg' });
    const t2 = addLocal('Deixa Acontecer', { genre: 'Samba & Pagode', thumbnail: 'https://img.test/2.jpg' });
    const t3 = addLocal('Baile de Favela', { genre: 'Funk' });

    const p1 = (await request(app).post('/api/playlists').send({ name: 'Churrasco' }).expect(201)).body;
    const p2 = (await request(app).post('/api/playlists').send({ name: 'Festa' }).expect(201)).body;

    // t2 belongs to both Churrasco and Festa
    await request(app).post(`/api/playlists/${p1.id}/tracks`).send({ trackId: t1.id }).expect(201);
    await request(app).post(`/api/playlists/${p1.id}/tracks`).send({ trackId: t2.id }).expect(201);
    const dup = await request(app).post(`/api/playlists/${p1.id}/tracks`).send({ trackId: t2.id }).expect(200);
    expect(dup.body).toMatchObject({ added: false, duplicate: true });

    await request(app).post(`/api/playlists/${p2.id}/tracks`).send({ trackId: t2.id }).expect(201);
    await request(app).post(`/api/playlists/${p2.id}/tracks`).send({ trackId: t3.id }).expect(201);

    const d1 = await request(app).get(`/api/playlists/${p1.id}`).expect(200);
    expect(d1.body.tracks.map((t: { title: string }) => t.title)).toEqual(['Evidências', 'Deixa Acontecer']);

    // Remove t1 from p1
    await request(app).delete(`/api/playlists/${p1.id}/tracks/${t1.id}`).expect(204);
    await request(app).delete(`/api/playlists/${p1.id}/tracks/${t1.id}`).expect(404);
    const d1After = await request(app).get(`/api/playlists/${p1.id}`).expect(200);
    expect(d1After.body.tracks.map((t: { title: string }) => t.title)).toEqual(['Deixa Acontecer']);
    expect(d1After.body.cover).toBe('https://img.test/2.jpg');

    // Cascade when playlist is deleted: tracks remain in library
    await request(app).delete(`/api/playlists/${p1.id}`).expect(204);
    expect(jukebox.tracks.get(t2.id)).not.toBeNull();
    const d2 = await request(app).get(`/api/playlists/${p2.id}`).expect(200);
    expect(d2.body.tracks).toHaveLength(2);
  });

  it('enqueues full playlist in order or shuffled subset via POST /api/playlists/:id/enqueue', async () => {
    const { app, addLocal, jukebox } = makeApp();
    const t1 = addLocal('Faixa A', { genre: 'Pop' });
    const t2 = addLocal('Faixa B', { genre: 'Rock' });
    const t3 = addLocal('Faixa C', { genre: 'Funk' });

    const pl = (await request(app).post('/api/playlists').send({ name: 'Esquenta' }).expect(201)).body;
    await request(app).post(`/api/playlists/${pl.id}/tracks`).send({ trackId: t1.id }).expect(201);
    await request(app).post(`/api/playlists/${pl.id}/tracks`).send({ trackId: t2.id }).expect(201);
    await request(app).post(`/api/playlists/${pl.id}/tracks`).send({ trackId: t3.id }).expect(201);

    await request(app).post(`/api/playlists/${pl.id}/enqueue`).send({ count: 0 }).expect(400);
    await request(app).post(`/api/playlists/${pl.id}/enqueue`).send({ shuffle: 'yes' }).expect(400);

    const subset = await request(app)
      .post(`/api/playlists/${pl.id}/enqueue`)
      .send({ clientId: 'guest-1', name: 'Lucas', shuffle: true, count: 2 })
      .expect(200);
    expect(subset.body).toMatchObject({
      playlistId: pl.id,
      playlistName: 'Esquenta',
      total: 2,
      enqueued: 2,
      duplicates: 0,
    });
    const state1 = jukebox.queue.state();
    expect(state1.nowPlaying).not.toBeNull();
    expect(state1.queue).toHaveLength(1);

    // Enqueue all -> 2 duplicates + 1 new
    const full = await request(app)
      .post(`/api/playlists/${pl.id}/enqueue`)
      .send({ clientId: 'guest-1', name: 'Lucas', shuffle: false })
      .expect(200);
    expect(full.body).toMatchObject({ total: 3, enqueued: 1, duplicates: 2 });
    expect(jukebox.queue.state().queue).toHaveLength(2);
  });

  it('locks Auto-DJ exclusively to ready tracks of the selected internal playlist and resets on delete', async () => {
    const { config, app, addLocal, jukebox } = makeApp({ HOST_PIN: '9999' });
    const inPl1 = addLocal('Churrasco 1', { genre: 'Sertanejo' });
    const inPl2 = addLocal('Churrasco 2', { genre: 'Samba & Pagode' });
    const notReady = addLocal('Churrasco Pendente', { genre: 'Funk', ready: false });
    const outside1 = addLocal('Outside Rock', { genre: 'Rock' });
    addLocal('Outside Pop', { genre: 'Pop' });

    const pl = (
      await request(app).post('/api/playlists').set('x-host-pin', '9999').send({ name: 'Churrasco' }).expect(201)
    ).body;
    await request(app).post(`/api/playlists/${pl.id}/tracks`).set('x-host-pin', '9999').send({ trackId: inPl1.id }).expect(201);
    await request(app).post(`/api/playlists/${pl.id}/tracks`).set('x-host-pin', '9999').send({ trackId: inPl2.id }).expect(201);
    await request(app).post(`/api/playlists/${pl.id}/tracks`).set('x-host-pin', '9999').send({ trackId: notReady.id }).expect(201);

    await request(app)
      .post('/api/config/autodj')
      .set('x-host-pin', '9999')
      .send({ enabled: true, mode: 'playlist' })
      .expect(400);
    await request(app)
      .post('/api/config/autodj')
      .set('x-host-pin', '9999')
      .send({ enabled: true, mode: 'playlist', playlistId: 'missing' })
      .expect(404);

    const updated = await request(app)
      .post('/api/config/autodj')
      .set('x-host-pin', '9999')
      .send({ enabled: true, mode: 'playlist', playlistId: pl.id })
      .expect(200);
    expect(updated.body).toMatchObject({
      autoDjEnabled: true,
      autoDjMode: 'playlist',
      autoDjPlaylistId: pl.id,
    });

    // Play an outside track first, then drain -> Auto-DJ must pick only from Churrasco ready tracks
    jukebox.queue.enqueue(outside1.id, 'guest-1', 'Ana');
    jukebox.queue.ended(jukebox.queue.state().nowPlaying!.item.id);
    const auto1 = jukebox.queue.state().nowPlaying!;
    expect([inPl1.id, inPl2.id]).toContain(auto1.item.trackId);

    // Drain again -> anti-repetition picks the other ready track in Churrasco
    jukebox.queue.ended(auto1.item.id);
    const auto2 = jukebox.queue.state().nowPlaying!;
    expect(auto2.item.trackId).toBe(auto1.item.trackId === inPl1.id ? inPl2.id : inPl1.id);

    // Persists across restart
    const reopened = createJukebox(loadConfig({ DATA_DIR: config.dataDir, WEB_DIR: config.webDir }), {
      media: new FakeMedia(),
      log: () => {},
    });
    expect(reopened.autoDjMode).toBe('playlist');
    expect(reopened.autoDjPlaylistId).toBe(pl.id);

    // Deleting locked playlist resets Auto-DJ mode to 'vibe' and clears autoDjPlaylistId
    await request(app).delete(`/api/playlists/${pl.id}`).set('x-host-pin', '9999').expect(204);
    const cfg = await request(app).get('/api/config').expect(200);
    expect(cfg.body).toMatchObject({ autoDjEnabled: true, autoDjMode: 'vibe', autoDjPlaylistId: null });
  });
});
