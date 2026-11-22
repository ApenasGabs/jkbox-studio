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

  it('exposes videoMode in config and streams cached MP4 video with HTTP Range support', async () => {
    const { app, jukebox, media } = makeApp({ VIDEO_MAX_HEIGHT: '480' });
    const cfg = await request(app).get('/api/config').expect(200);
    expect(cfg.body.videoMode).toBe('cache');

    const queued = await request(app)
      .post('/api/queue')
      .send({ result: ytResult('dQw4w9WgXcQ'), clientId: 'phone-1', name: 'Ana' })
      .expect(201);
    const trackId = queued.body.item.trackId as string;

    await jukebox.downloads.idle();
    expect(media.videoDownloads).toEqual(['dQw4w9WgXcQ']);
    expect(media.lastMaxHeight).toBe(480);

    const track = jukebox.tracks.get(trackId)!;
    expect(track.videoPath).toBeTruthy();
    expect(fs.existsSync(track.videoPath!)).toBe(true);

    const head = await request(app).head(`/api/tracks/${trackId}/video`).expect(200);
    expect(head.headers['content-type']).toBe('video/mp4');
    expect(head.headers['accept-ranges']).toBe('bytes');
    expect(Number(head.headers['content-length'])).toBe(2000);

    const full = await request(app).get(`/api/tracks/${trackId}/video`).expect(200);
    expect(full.headers['content-type']).toBe('video/mp4');
    expect(Number(full.headers['content-length'])).toBe(2000);

    const partial = await request(app).get(`/api/tracks/${trackId}/video`).set('Range', 'bytes=200-399').expect(206);
    expect(partial.headers['content-range']).toBe('bytes 200-399/2000');
    expect(Number(partial.headers['content-length'])).toBe(200);

    await request(app).get(`/api/tracks/${trackId}/video`).set('Range', 'bytes=9000-').expect(416);
  });

  it('falls back safely to audio-only when video download fails or VIDEO_MODE=off', async () => {
    const offCtx = makeApp({ VIDEO_MODE: 'off' });
    const offCfg = await request(offCtx.app).get('/api/config').expect(200);
    expect(offCfg.body.videoMode).toBe('off');

    const offQueued = await request(offCtx.app)
      .post('/api/queue')
      .send({ result: ytResult('dQw4w9WgXcQ'), clientId: 'a' })
      .expect(201);
    await offCtx.jukebox.downloads.idle();
    expect(offCtx.media.downloads).toEqual(['dQw4w9WgXcQ']);
    expect(offCtx.media.videoDownloads).toEqual([]);
    const offTrack = offCtx.jukebox.tracks.get(offQueued.body.item.trackId)!;
    expect(offTrack.status).toBe('ready');
    expect(offTrack.videoPath).toBeNull();
    await request(offCtx.app).get(`/api/tracks/${offTrack.id}/video`).expect(404);
    await request(offCtx.app).get(`/api/tracks/${offTrack.id}/stream`).expect(200);

    const failCtx = makeApp({ VIDEO_MODE: 'cache' });
    failCtx.media.failVideoIds.add('eeeeeeeeeee');
    const failQueued = await request(failCtx.app)
      .post('/api/queue')
      .send({ result: ytResult('eeeeeeeeeee'), clientId: 'b' })
      .expect(201);
    await failCtx.jukebox.downloads.idle();
    const failTrack = failCtx.jukebox.tracks.get(failQueued.body.item.trackId)!;
    expect(failTrack.status).toBe('ready');
    expect(fs.existsSync(failTrack.filePath!)).toBe(true);
    expect(failTrack.videoPath).toBeNull();
    await request(failCtx.app).get(`/api/tracks/${failTrack.id}/video`).expect(404);
    await request(failCtx.app).get(`/api/tracks/${failTrack.id}/stream`).expect(200);
  });

  it('returns 409 for pending track video and 404 for local audio-only tracks', async () => {
    const { app, jukebox, media } = makeApp();
    media.hold();
    const pending = await request(app)
      .post('/api/queue')
      .send({ result: ytResult('aaaaaaaaaaa'), clientId: 'a' })
      .expect(201);
    await request(app).get(`/api/tracks/${pending.body.item.trackId}/video`).expect(409);
    media.release();
    await jukebox.downloads.idle();

    const localTrack = jukebox.tracks.insertLocal('/tmp/local.mp3', 'Local Song', 'Local Artist');
    await request(app).get(`/api/tracks/${localTrack.id}/video`).expect(404);
  });

  it('persists autoDjEnabled via host settings and auto-enqueues cached tracks on queue end', async () => {
    const { app, jukebox } = makeApp({ HOST_PIN: '1234' });
    const initialCfg = await request(app).get('/api/config').expect(200);
    expect(initialCfg.body.autoDjEnabled).toBe(false);

    await request(app).patch('/api/host/settings').send({ autoDjEnabled: true }).expect(403);
    await request(app)
      .patch('/api/host/settings')
      .set('x-host-pin', '1234')
      .send({ autoDjEnabled: 'yes' })
      .expect(400);

    const updated = await request(app)
      .patch('/api/host/settings')
      .set('x-host-pin', '1234')
      .send({ autoDjEnabled: true })
      .expect(200);
    expect(updated.body).toEqual({ autoDjEnabled: true });

    const cfgAfter = await request(app).get('/api/config').expect(200);
    expect(cfgAfter.body.autoDjEnabled).toBe(true);

    await request(app).post('/api/queue').send({ result: ytResult('aaaaaaaaaaa'), clientId: 'a', name: 'Ana' }).expect(201);
    await request(app).post('/api/queue').send({ result: ytResult('bbbbbbbbbbb'), clientId: 'b', name: 'Bia' }).expect(201);
    await jukebox.downloads.idle();

    const first = jukebox.queue.state().nowPlaying!;
    expect(first.item.track.sourceId).toBe('aaaaaaaaaaa');

    // End first -> advances to user-queued second track
    const afterFirst = await request(app).post('/api/player/ended').send({ queueId: first.item.id }).expect(200);
    expect(afterFirst.body.nowPlaying.item.track.sourceId).toBe('bbbbbbbbbbb');

    // End second (queue is now empty) -> Auto-DJ picks cached track 'aaaaaaaaaaa' without immediately repeating 'bbbbbbbbbbb'
    const afterSecond = await request(app)
      .post('/api/player/ended')
      .send({ queueId: afterFirst.body.nowPlaying.item.id })
      .expect(200);
    expect(afterSecond.body.nowPlaying.item.requesterId).toBe('auto-dj');
    expect(afterSecond.body.nowPlaying.item.requesterName).toBe('Auto-DJ');
    expect(afterSecond.body.nowPlaying.item.track.sourceId).toBe('aaaaaaaaaaa');
  });

  it('returns played history ordered by finished_at DESC with clamped ?limit', async () => {
    const { app, jukebox } = makeApp();
    await request(app).post('/api/queue').send({ result: ytResult('aaaaaaaaaaa'), clientId: 'a', name: 'Ana' }).expect(201);
    await request(app).post('/api/queue').send({ result: ytResult('bbbbbbbbbbb'), clientId: 'b', name: 'Bia' }).expect(201);
    await request(app).post('/api/queue').send({ result: ytResult('ccccccccccc'), clientId: 'c', name: 'Caio' }).expect(201);
    await jukebox.downloads.idle();

    // Play & finish aaaaaaaaaaa, then bbbbbbbbbbb; remove ccccccccccc (must not appear in history)
    await request(app).post('/api/player/skip').expect(200);
    await request(app).post('/api/player/skip').expect(200);
    const remaining = jukebox.queue.state().nowPlaying!;
    expect(remaining.item.track.sourceId).toBe('ccccccccccc');
    await request(app).delete(`/api/queue/${remaining.item.id}`).send({ clientId: 'c' }).expect(204);

    const all = await request(app).get('/api/history').query({ limit: 30 }).expect(200);
    expect(all.body.history).toHaveLength(2);
    expect(all.body.history.map((item: { track: { sourceId: string } }) => item.track.sourceId)).toEqual([
      'bbbbbbbbbbb',
      'aaaaaaaaaaa',
    ]);
    expect(all.body.history[0].finishedAt).toEqual(expect.any(Number));

    const limited = await request(app).get('/api/history').query({ limit: 1 }).expect(200);
    expect(limited.body.history).toHaveLength(1);
    expect(limited.body.history[0].track.sourceId).toBe('bbbbbbbbbbb');

    const minClamped = await request(app).get('/api/history').query({ limit: 0 }).expect(200);
    expect(minClamped.body.history).toHaveLength(1);

    const maxClamped = await request(app).get('/api/history').query({ limit: 999 }).expect(200);
    expect(maxClamped.body.history).toHaveLength(2);
  });
});
