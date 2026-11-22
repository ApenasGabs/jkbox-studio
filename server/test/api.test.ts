import fs from 'node:fs';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { setup, ytResult } from './helpers.js';

function makeApp(env: Record<string, string> = {}) {
  const ctx = setup(env);
  return { ...ctx, app: createApp({ config: ctx.config, jukebox: ctx.jukebox }) };
}

describe('HTTP API', () => {
  it('reports health and config with Spotify disabled by default', async () => {
    const { app } = makeApp();
    await request(app).get('/api/health').expect(200, { ok: true, version: '0.1.0', downloadsActive: 0 });
    const res = await request(app).get('/api/config').expect(200);
    expect(res.body.spotify).toMatchObject({ configured: false, connected: false });
  });

  it('searches YouTube + local library, without Spotify when not configured', async () => {
    const { app, media } = makeApp();
    const res = await request(app).get('/api/search').query({ q: 'daft punk' }).expect(200);
    expect(res.body.results).toHaveLength(3);
    expect(res.body.results[0]).toMatchObject({ source: 'youtube', title: 'daft punk 0' });
    expect(res.body.errors).toEqual({});
    expect(media.searches).toEqual(['daft punk']);
    await request(app).get('/api/search').query({ q: 'x', source: 'spotify' }).expect(503);
  });

  it('resolves pasted YouTube links', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/search').query({ q: 'https://youtu.be/dQw4w9WgXcQ' }).expect(200);
    expect(res.body.results).toEqual([expect.objectContaining({ source: 'youtube', sourceId: 'dQw4w9WgXcQ' })]);
  });

  it('enqueues, downloads in background, plays, and streams with Range', async () => {
    const { app, jukebox, media } = makeApp();
    const res = await request(app)
      .post('/api/queue')
      .send({ result: ytResult('dQw4w9WgXcQ'), clientId: 'phone-1', name: 'Ana' })
      .expect(201);
    expect(res.body).toMatchObject({ duplicate: false, cached: false });
    await jukebox.downloads.idle();

    expect(media.downloads).toEqual(['dQw4w9WgXcQ']);
    const state = (await request(app).get('/api/state').expect(200)).body;
    expect(state.nowPlaying.item.requesterName).toBe('Ana');
    const track = state.nowPlaying.item.track;
    expect(track).toMatchObject({ status: 'ready', progress: 1 });
    expect(fs.existsSync(track.filePath)).toBe(true);

    const full = await request(app).get(`/api/tracks/${track.id}/stream`).expect(200);
    expect(full.headers['content-type']).toBe('audio/mp4');
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(Number(full.headers['content-length'])).toBe(1000);

    const partial = await request(app).get(`/api/tracks/${track.id}/stream`).set('Range', 'bytes=100-199').expect(206);
    expect(partial.headers['content-range']).toBe('bytes 100-199/1000');
    expect(Number(partial.headers['content-length'])).toBe(100);

    await request(app).get(`/api/tracks/${track.id}/stream`).set('Range', 'bytes=5000-').expect(416);
  });

  it('reuses the local cache instead of downloading again', async () => {
    const { app, jukebox, media } = makeApp();
    await request(app).post('/api/queue').send({ result: ytResult('dQw4w9WgXcQ'), clientId: 'a' }).expect(201);
    await jukebox.downloads.idle();
    const playing = jukebox.queue.state().nowPlaying!;
    await request(app).post('/api/player/ended').send({ queueId: playing.item.id }).expect(200);
    expect(jukebox.queue.state().nowPlaying).toBeNull();

    const again = await request(app).post('/api/queue').send({ result: ytResult('dQw4w9WgXcQ'), clientId: 'b' }).expect(201);
    expect(again.body.cached).toBe(true);
    expect(media.downloads).toEqual(['dQw4w9WgXcQ']);
    expect(jukebox.queue.state().nowPlaying?.item.trackId).toBe(playing.item.trackId);

    const lib = await request(app).get('/api/library').query({ q: 'Song' }).expect(200);
    expect(lib.body.results).toEqual([expect.objectContaining({ sourceId: 'dQw4w9WgXcQ', cached: true })]);
  });

  it('counts a duplicate request as a vote and supports vote toggling', async () => {
    const { app, jukebox, media } = makeApp();
    media.hold();
    await request(app).post('/api/queue').send({ result: ytResult('aaaaaaaaaaa'), clientId: 'a' }).expect(201);
    const second = await request(app).post('/api/queue').send({ result: ytResult('bbbbbbbbbbb'), clientId: 'a' }).expect(201);
    const queueId = second.body.item.id;

    const dup = await request(app).post('/api/queue').send({ result: ytResult('bbbbbbbbbbb'), clientId: 'b' }).expect(200);
    expect(dup.body.duplicate).toBe(true);
    let queue = jukebox.queue.state().queue;
    expect(queue[0].id).toBe(queueId);
    expect(queue[0].votes).toBe(1);

    expect((await request(app).post(`/api/queue/${queueId}/vote`).send({ clientId: 'b' }).expect(200)).body).toEqual({
      voted: false,
    });
    expect((await request(app).post(`/api/queue/${queueId}/vote`).send({ clientId: 'c' }).expect(200)).body).toEqual({
      voted: true,
    });
    queue = jukebox.queue.state().queue;
    expect(queue.find((q) => q.id === queueId)?.voters).toEqual(['c']);
    media.release();
    await jukebox.downloads.idle();
  });

  it('only lets the requester or host remove songs when a host PIN is set', async () => {
    const { app, jukebox, media } = makeApp({ HOST_PIN: '1234' });
    media.hold();
    const res = await request(app).post('/api/queue').send({ result: ytResult('aaaaaaaaaaa'), clientId: 'a' }).expect(201);
    const id = res.body.item.id;
    await request(app).delete(`/api/queue/${id}`).send({ clientId: 'b' }).expect(403);
    await request(app).post('/api/player/skip').expect(403);
    await request(app).delete(`/api/queue/${id}`).send({ clientId: 'a' }).expect(204);

    const other = await request(app).post('/api/queue').send({ result: ytResult('bbbbbbbbbbb'), clientId: 'a' }).expect(201);
    await request(app).delete(`/api/queue/${other.body.item.id}`).set('x-host-pin', '1234').expect(204);
    expect(jukebox.queue.state().queue).toHaveLength(0);
    media.release();
    await jukebox.downloads.idle();
  });

  it('skips to the next ready track and marks failed downloads', async () => {
    const { app, jukebox, media } = makeApp();
    media.failIds.add('bbbbbbbbbbb');
    await request(app).post('/api/queue').send({ result: ytResult('aaaaaaaaaaa'), clientId: 'a' });
    await request(app).post('/api/queue').send({ result: ytResult('bbbbbbbbbbb'), clientId: 'b' });
    await request(app).post('/api/queue').send({ result: ytResult('ccccccccccc'), clientId: 'c' });
    await jukebox.downloads.idle();

    expect(jukebox.queue.state().nowPlaying?.item.track.sourceId).toBe('aaaaaaaaaaa');
    await request(app).post('/api/player/skip').expect(200);
    const state = jukebox.queue.state();
    expect(state.nowPlaying?.item.track.sourceId).toBe('ccccccccccc');
    expect(state.queue[0].track).toMatchObject({ sourceId: 'bbbbbbbbbbb', status: 'error', error: 'boom' });
  });

  it('returns 409 when streaming a track that is not ready', async () => {
    const { app, jukebox, media } = makeApp();
    media.hold();
    const res = await request(app).post('/api/queue').send({ result: ytResult('aaaaaaaaaaa'), clientId: 'a' });
    await request(app).get(`/api/tracks/${res.body.item.trackId}/stream`).expect(409);
    media.release();
    await jukebox.downloads.idle();
  });

  it('rejects invalid enqueue payloads', async () => {
    const { app } = makeApp();
    await request(app).post('/api/queue').send({ clientId: 'a' }).expect(400);
    await request(app).post('/api/queue').send({ result: ytResult('aaaaaaaaaaa') }).expect(400);
  });
});
