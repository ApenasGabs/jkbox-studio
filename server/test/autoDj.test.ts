import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createJukebox } from '../src/container.js';
import { pickAutoDjTrack } from '../src/lib/autoDj.js';
import { FakeMedia, setup, ytResult } from './helpers.js';

describe('pickAutoDjTrack', () => {
  const tracks = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));

  it('returns null when no cached tracks exist', () => {
    expect(pickAutoDjTrack([], [])).toBeNull();
  });

  it('returns the only cached track when library has a single track', () => {
    expect(pickAutoDjTrack([{ id: 'only' }], ['only'])).toEqual({ id: 'only' });
  });

  it('avoids repeating the last N played tracks', () => {
    const picked = pickAutoDjTrack(tracks, ['e', 'd', 'c'], { recentWindow: 3, random: () => 0 });
    expect(picked).toEqual({ id: 'a' });

    const pickedLast = pickAutoDjTrack(tracks, ['e', 'd', 'c'], { recentWindow: 3, random: () => 0.99 });
    expect(pickedLast).toEqual({ id: 'b' });
  });

  it('shrinks exclusion window gracefully when cached library is smaller than N + 1', () => {
    // Only 3 cached tracks exist, but recentWindow is 10: excludes up to 2 most-recent ('c', 'b'), leaving 'a'.
    const three = tracks.slice(0, 3);
    expect(pickAutoDjTrack(three, ['c', 'b', 'a'], { recentWindow: 10 })).toEqual({ id: 'a' });
  });

  it('ignores unknown or duplicate IDs in recent history', () => {
    const three = tracks.slice(0, 3);
    expect(pickAutoDjTrack(three, ['missing-1', 'c', 'c', 'missing-2', 'b'], { recentWindow: 2 })).toEqual({ id: 'a' });
  });
});

describe('Jukebox Auto-DJ integration', () => {
  it('enqueues a cached track when the last track finishes and the queue is empty', async () => {
    const { config, jukebox } = setup();
    fs.writeFileSync(path.join(config.musicDir, 'Artist 1 - Song 1.mp3'), Buffer.alloc(128, 1));
    fs.writeFileSync(path.join(config.musicDir, 'Artist 2 - Song 2.mp3'), Buffer.alloc(128, 2));
    fs.writeFileSync(path.join(config.musicDir, 'Artist 3 - Song 3.mp3'), Buffer.alloc(128, 3));

    const t1 = jukebox.tracks.insertLocal(path.join(config.musicDir, 'Artist 1 - Song 1.mp3'), { title: 'Song 1', artist: 'Artist 1' });
    const t2 = jukebox.tracks.insertLocal(path.join(config.musicDir, 'Artist 2 - Song 2.mp3'), { title: 'Song 2', artist: 'Artist 2' });
    const t3 = jukebox.tracks.insertLocal(path.join(config.musicDir, 'Artist 3 - Song 3.mp3'), { title: 'Song 3', artist: 'Artist 3' });

    jukebox.setAutoDjEnabled(true);
    jukebox.queue.enqueue(t1.id, 'guest-1', 'Ana');

    const playing1 = jukebox.queue.state().nowPlaying!;
    expect(playing1.item.trackId).toBe(t1.id);

    // End t1 -> Auto-DJ should pick t2 or t3 (not t1)
    jukebox.queue.ended(playing1.item.id);
    const playing2 = jukebox.queue.state().nowPlaying!;
    expect(playing2).not.toBeNull();
    expect(playing2.item.requesterId).toBe('auto-dj');
    expect(playing2.item.requesterName).toBe('Auto-DJ');
    expect([t2.id, t3.id]).toContain(playing2.item.trackId);

    // End playing2 -> Auto-DJ should pick the remaining unplayed track
    jukebox.queue.ended(playing2.item.id);
    const playing3 = jukebox.queue.state().nowPlaying!;
    expect(playing3).not.toBeNull();
    expect(playing3.item.trackId).toBe(playing2.item.trackId === t2.id ? t3.id : t2.id);

    // End playing3 -> Auto-DJ cycles back to t1 (the oldest of the 3) instead of repeating playing3 or playing2
    jukebox.queue.ended(playing3.item.id);
    const playing4 = jukebox.queue.state().nowPlaying!;
    expect(playing4.item.trackId).toBe(t1.id);
  });

  it('does not trigger Auto-DJ while a requested track is still downloading in queue', async () => {
    const { config, jukebox, media } = setup();
    fs.writeFileSync(path.join(config.musicDir, 'Local - Cached.mp3'), Buffer.alloc(128, 1));
    const local = jukebox.tracks.insertLocal(path.join(config.musicDir, 'Local - Cached.mp3'), { title: 'Cached', artist: 'Local' });

    jukebox.setAutoDjEnabled(true);
    jukebox.queue.enqueue(local.id, 'guest-1', 'Ana');

    media.hold();
    jukebox.enqueue({ result: ytResult('aaaaaaaaaaa'), requesterId: 'guest-2', requesterName: 'Bia' });

    const playing = jukebox.queue.state().nowPlaying!;
    jukebox.queue.ended(playing.item.id);

    // Queue still has the downloading YouTube track, so Auto-DJ must NOT jump ahead
    expect(jukebox.queue.state().nowPlaying).toBeNull();
    expect(jukebox.queue.state().queue).toHaveLength(1);
    expect(jukebox.queue.state().queue[0].requesterName).toBe('Bia');

    media.release();
    await jukebox.downloads.idle();
    expect(jukebox.queue.state().nowPlaying?.item.track.sourceId).toBe('aaaaaaaaaaa');
  });

  it('persists autoDjEnabled setting in SQLite across restarts', () => {
    const { config, jukebox } = setup();
    expect(jukebox.autoDjEnabled).toBe(false);
    jukebox.setAutoDjEnabled(true);
    expect(jukebox.autoDjEnabled).toBe(true);

    const reopened = createJukebox(loadConfig({ DATA_DIR: config.dataDir, WEB_DIR: config.webDir }), {
      media: new FakeMedia(),
      log: () => {},
    });
    expect(reopened.autoDjEnabled).toBe(true);
  });

  it('cascades subgenre -> genre -> affinity in vibe mode and strictly isolates Gospel', () => {
    const library = [
      { id: 'f-2000', genre: 'Funk', subgenre: 'Funk Anos 2000' },
      { id: 'f-mand', genre: 'Funk', subgenre: 'Funk Mandelão' },
      { id: 'rap-1', genre: 'Rap & Trap', subgenre: 'Trap BR' },
      { id: 'samba-1', genre: 'Samba & Pagode', subgenre: 'Pagode 90' },
      { id: 'gospel-1', genre: 'Gospel', subgenre: 'Louvor & Adoração' },
      { id: 'gospel-2', genre: 'Gospel', subgenre: 'Gospel Pentecostal' },
    ];

    // Level 1: same subgenre
    const level1 = pickAutoDjTrack(library, ['last'], {
      mode: 'vibe',
      lastTrack: { id: 'last', genre: 'Funk', subgenre: 'Funk Anos 2000' },
      random: () => 0,
    });
    expect(level1?.id).toBe('f-2000');

    // Level 2: same genre when no other track shares subgenre
    const level2 = pickAutoDjTrack(library, ['f-2000'], {
      mode: 'vibe',
      lastTrack: { id: 'f-2000', genre: 'Funk', subgenre: 'Funk Anos 2000' },
      random: () => 0,
    });
    expect(level2?.id).toBe('f-mand');

    // Level 3: safe affinity map (Funk -> Rap & Trap, never Gospel or Samba)
    const level3 = pickAutoDjTrack(library, ['f-2000', 'f-mand'], {
      mode: 'vibe',
      lastTrack: { id: 'f-mand', genre: 'Funk', subgenre: 'Funk Mandelão' },
      random: () => 0,
    });
    expect(level3?.id).toBe('rap-1');

    // Gospel isolation: from Gospel -> ONLY Gospel (never Funk/Rap/Samba)
    const afterGospel = pickAutoDjTrack(library, ['gospel-1'], {
      mode: 'vibe',
      lastTrack: { id: 'gospel-1', genre: 'Gospel', subgenre: 'Louvor & Adoração' },
      random: () => 0,
    });
    expect(afterGospel?.id).toBe('gospel-2');

    // Gospel isolation when no Gospel tracks exist in library -> returns null rather than mixing
    expect(
      pickAutoDjTrack(
        library.filter((t) => t.genre !== 'Gospel'),
        [],
        { mode: 'vibe', lastTrack: { id: 'gospel-1', genre: 'Gospel', subgenre: 'Louvor & Adoração' } },
      ),
    ).toBeNull();

    // Non-Gospel never transitions into Gospel even if only Gospel remains outside recent
    const onlyGospelLeft = pickAutoDjTrack(
      [
        { id: 'rock-1', genre: 'Rock', subgenre: 'Rock Nacional' },
        { id: 'gospel-only', genre: 'Gospel', subgenre: 'Louvor & Adoração' },
      ],
      ['rock-1'],
      { mode: 'vibe', lastTrack: { id: 'rock-1', genre: 'Rock', subgenre: 'Rock Nacional' } },
    );
    expect(onlyGospelLeft?.id).toBe('rock-1');
  });

  it('supports category lock and random modes via POST /api/config/autodj', async () => {
    const { config, jukebox } = setup({ HOST_PIN: '1234' });
    const app = createApp({ config, jukebox });

    fs.writeFileSync(path.join(config.musicDir, 'f1.mp3'), Buffer.alloc(64));
    fs.writeFileSync(path.join(config.musicDir, 'f2.mp3'), Buffer.alloc(64));
    fs.writeFileSync(path.join(config.musicDir, 'r1.mp3'), Buffer.alloc(64));

    const f1 = jukebox.tracks.insertLocal(path.join(config.musicDir, 'f1.mp3'), {
      title: 'F1',
      artist: 'A',
      genre: 'Funk',
      subgenre: 'Funk Mandelão',
    });
    const f2 = jukebox.tracks.insertLocal(path.join(config.musicDir, 'f2.mp3'), {
      title: 'F2',
      artist: 'B',
      genre: 'Funk',
      subgenre: 'Funk Anos 2000',
    });
    jukebox.tracks.insertLocal(path.join(config.musicDir, 'r1.mp3'), {
      title: 'R1',
      artist: 'C',
      genre: 'Rock',
      subgenre: 'Rock Nacional',
    });

    await request(app).post('/api/config/autodj').send({ enabled: true, mode: 'category', category: 'Funk' }).expect(403);
    await request(app)
      .post('/api/config/autodj')
      .set('x-host-pin', '1234')
      .send({ enabled: true, mode: 'category' })
      .expect(400);

    const updated = await request(app)
      .post('/api/config/autodj')
      .set('x-host-pin', '1234')
      .send({ enabled: true, mode: 'category', category: 'Funk', subgenre: 'Funk Mandelão' })
      .expect(200);
    expect(updated.body).toEqual({
      autoDjEnabled: true,
      autoDjMode: 'category',
      autoDjCategory: 'Funk',
      autoDjSubgenre: 'Funk Mandelão',
    });

    const cfg = await request(app).get('/api/config').expect(200);
    expect(cfg.body).toMatchObject({
      autoDjEnabled: true,
      autoDjMode: 'category',
      autoDjCategory: 'Funk',
      autoDjSubgenre: 'Funk Mandelão',
    });

    // Locks exclusively to Funk Mandelão (f1), never picking Rock (r1) or Funk Anos 2000 (f2)
    const pickedSub = jukebox.maybeEnqueueAutoDj(() => 0);
    expect(pickedSub?.id).toBe(f1.id);

    // Clear subgenre -> locks to Funk (picks f2 since f1 is now playing / in queue after skip)
    jukebox.queue.skip();
    await request(app)
      .post('/api/config/autodj')
      .set('x-host-pin', '1234')
      .send({ mode: 'category', category: 'Funk', subgenre: null })
      .expect(200);
    const playingAfterDrain = jukebox.queue.state().nowPlaying!;
    expect([f1.id, f2.id]).toContain(playingAfterDrain.item.trackId);
  });
});
