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

    jukebox.queue.enqueue(t1.id, 'guest-1', 'Ana');
    jukebox.setAutoDjEnabled(true);

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

  it('triggers Auto-DJ when a requested track is still downloading in queue without removing it, then plays it next', async () => {
    const { config, jukebox, media } = setup();
    fs.writeFileSync(path.join(config.musicDir, 'Local - Cached.mp3'), Buffer.alloc(128, 1));
    const local = jukebox.tracks.insertLocal(path.join(config.musicDir, 'Local - Cached.mp3'), { title: 'Cached', artist: 'Local' });

    jukebox.queue.enqueue(local.id, 'guest-1', 'Ana');
    jukebox.setAutoDjEnabled(true);

    media.hold();
    jukebox.enqueue({ result: ytResult('aaaaaaaaaaa'), requesterId: 'guest-2', requesterName: 'Bia' });

    const playing = jukebox.queue.state().nowPlaying!;
    jukebox.queue.ended(playing.item.id);

    // Auto-DJ fills the silence while Bia's request keeps downloading in queue
    const autoPlaying = jukebox.queue.state().nowPlaying!;
    expect(autoPlaying).not.toBeNull();
    expect(autoPlaying.item.requesterId).toBe('auto-dj');
    expect(autoPlaying.item.trackId).toBe(local.id);
    expect(jukebox.queue.state().queue).toHaveLength(1);
    expect(jukebox.queue.state().queue[0].requesterName).toBe('Bia');
    expect(jukebox.queue.state().queue[0].track.sourceId).toBe('aaaaaaaaaaa');

    // Calling maybeEnqueueAutoDj again while playing must not enqueue a duplicate
    expect(jukebox.maybeEnqueueAutoDj()).toBeNull();
    expect(jukebox.queue.state().queue).toHaveLength(1);

    // Once download finishes and the Auto-DJ track ends, Bia's request plays next
    media.release();
    await jukebox.downloads.idle();
    expect(jukebox.queue.state().nowPlaying?.item.id).toBe(autoPlaying.item.id);
    jukebox.queue.ended(autoPlaying.item.id);
    expect(jukebox.queue.state().nowPlaying?.item.track.sourceId).toBe('aaaaaaaaaaa');
    expect(jukebox.queue.state().nowPlaying?.item.requesterName).toBe('Bia');
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
      autoDjPlaylistId: null,
    });

    const cfg = await request(app).get('/api/config').expect(200);
    expect(cfg.body).toMatchObject({
      autoDjEnabled: true,
      autoDjMode: 'category',
      autoDjCategory: 'Funk',
      autoDjSubgenre: 'Funk Mandelão',
    });

    // Locks exclusively to Funk Mandelão (f1), starting immediately since player was idle
    expect(jukebox.queue.state().nowPlaying?.item.trackId).toBe(f1.id);
    // Calling maybeEnqueueAutoDj while already playing must not enqueue a duplicate
    expect(jukebox.maybeEnqueueAutoDj(() => 0)).toBeNull();

    // Clear subgenre -> locks to Funk (picks f2 since f1 was playing before skip)
    await request(app)
      .post('/api/config/autodj')
      .set('x-host-pin', '1234')
      .send({ mode: 'category', category: 'Funk', subgenre: null })
      .expect(200);
    jukebox.queue.skip();
    const playingAfterDrain = jukebox.queue.state().nowPlaying!;
    expect(playingAfterDrain.item.trackId).toBe(f2.id);
  });

  it('locks selection to playlistTrackIds in playlist mode while respecting recent window', () => {
    const library = [
      { id: 'pl-1', genre: 'Sertanejo', subgenre: 'Sertanejo Raiz' },
      { id: 'pl-2', genre: 'Funk', subgenre: 'Funk Mandelão' },
      { id: 'other', genre: 'Rock', subgenre: 'Rock Nacional' },
    ];

    const first = pickAutoDjTrack(library, ['pl-1'], {
      mode: 'playlist',
      playlistTrackIds: ['pl-1', 'pl-2'],
      recentWindow: 5,
      random: () => 0,
    });
    expect(first?.id).toBe('pl-2');

    // Empty playlist or no cached tracks matching playlist -> null
    expect(
      pickAutoDjTrack(library, [], {
        mode: 'playlist',
        playlistTrackIds: [],
      }),
    ).toBeNull();
    expect(
      pickAutoDjTrack(library, [], {
        mode: 'playlist',
        playlistTrackIds: ['not-cached'],
      }),
    ).toBeNull();
  });

  it('triggers Auto-DJ immediately when a playing track ends with error tracks left in queue', async () => {
    const { config, jukebox, media } = setup();
    fs.writeFileSync(path.join(config.musicDir, 'Song A.mp3'), Buffer.alloc(128, 1));
    fs.writeFileSync(path.join(config.musicDir, 'Song B.mp3'), Buffer.alloc(128, 2));
    const tA = jukebox.tracks.insertLocal(path.join(config.musicDir, 'Song A.mp3'), { title: 'Song A', artist: 'Art A' });
    const tB = jukebox.tracks.insertLocal(path.join(config.musicDir, 'Song B.mp3'), { title: 'Song B', artist: 'Art B' });

    jukebox.queue.enqueue(tA.id, 'guest-1', 'Ana');
    media.failIds.add('fail0000001');
    jukebox.enqueue({ result: ytResult('fail0000001', 'Broken Track'), requesterId: 'guest-2', requesterName: 'Bia' });
    await jukebox.downloads.idle();

    expect(jukebox.queue.state().queue).toHaveLength(1);
    expect(jukebox.queue.state().queue[0].track.status).toBe('error');

    jukebox.setAutoDjEnabled(true);
    const playingA = jukebox.queue.state().nowPlaying!;
    jukebox.queue.ended(playingA.item.id);

    const afterEnd = jukebox.queue.state();
    expect(afterEnd.nowPlaying).not.toBeNull();
    expect(afterEnd.nowPlaying!.item.requesterId).toBe('auto-dj');
    expect(afterEnd.nowPlaying!.item.trackId).toBe(tB.id);
    // The failed guest item stays visible in the queue without blocking playback
    expect(afterEnd.queue).toHaveLength(1);
    expect(afterEnd.queue[0].track.status).toBe('error');
  });

  it('starts Auto-DJ immediately when enabled or reconfigured while idle, and on startup', async () => {
    const { config, jukebox } = setup({ HOST_PIN: '1234' });
    const app = createApp({ config, jukebox });
    fs.writeFileSync(path.join(config.musicDir, 'Funk 1.mp3'), Buffer.alloc(128, 1));
    fs.writeFileSync(path.join(config.musicDir, 'Rock 1.mp3'), Buffer.alloc(128, 2));
    const funk = jukebox.tracks.insertLocal(path.join(config.musicDir, 'Funk 1.mp3'), {
      title: 'Funk 1',
      artist: 'MC',
      genre: 'Funk',
    });
    const rock = jukebox.tracks.insertLocal(path.join(config.musicDir, 'Rock 1.mp3'), {
      title: 'Rock 1',
      artist: 'Band',
      genre: 'Rock',
    });

    // Activating Auto-DJ while player is idle starts playback immediately
    await request(app)
      .patch('/api/host/settings')
      .set('x-host-pin', '1234')
      .send({ autoDjEnabled: true })
      .expect(200);
    const first = jukebox.queue.state().nowPlaying;
    expect(first).not.toBeNull();
    expect(first!.item.requesterId).toBe('auto-dj');

    // Disable, remove current -> player goes idle
    await request(app)
      .post('/api/config/autodj')
      .set('x-host-pin', '1234')
      .send({ enabled: false })
      .expect(200);
    jukebox.queue.remove(first!.item.id, 'host', true);
    expect(jukebox.queue.state().nowPlaying).toBeNull();

    // Switching config with enabled: true while idle starts matching category immediately
    await request(app)
      .post('/api/config/autodj')
      .set('x-host-pin', '1234')
      .send({ enabled: true, mode: 'category', category: 'Rock' })
      .expect(200);
    expect(jukebox.queue.state().nowPlaying?.item.trackId).toBe(rock.id);

    // Simulate server restart with autoDjEnabled=true and idle queue -> syncStartupPlayback starts Auto-DJ
    const activeBeforeRestart = jukebox.queue.state().nowPlaying!;
    jukebox.setAutoDjEnabled(false);
    jukebox.queue.remove(activeBeforeRestart.item.id, 'host', true);
    jukebox.settings?.set('autoDjEnabled', true);
    const reopened = createJukebox(loadConfig({ DATA_DIR: config.dataDir, WEB_DIR: config.webDir }), {
      media: new FakeMedia(),
      log: () => {},
    });
    expect(reopened.autoDjEnabled).toBe(true);
    expect(reopened.queue.state().nowPlaying).toBeNull();
    reopened.syncStartupPlayback();
    expect(reopened.queue.state().nowPlaying?.item.trackId).toBe(rock.id);
    expect(reopened.queue.state().nowPlaying?.item.requesterId).toBe('auto-dj');
    expect(funk.id).toBeTruthy();
  });

  it('triggers Auto-DJ when a queued download fails while idle and when the last queued item is removed', async () => {
    const { config, jukebox, media } = setup();
    jukebox.setAutoDjEnabled(true);
    expect(jukebox.queue.state().nowPlaying).toBeNull();

    // 1. Queued download fails while player is idle -> Auto-DJ takes over once cached track exists
    media.hold();
    media.failIds.add('fail0000002');
    jukebox.enqueue({ result: ytResult('fail0000002', 'Will Fail'), requesterId: 'guest-1', requesterName: 'Ana' });

    fs.writeFileSync(path.join(config.musicDir, 'Cached.mp3'), Buffer.alloc(128, 1));
    const cached = jukebox.tracks.insertLocal(path.join(config.musicDir, 'Cached.mp3'), {
      title: 'Cached',
      artist: 'Artist',
    });

    media.release();
    await jukebox.downloads.idle();

    const afterFail = jukebox.queue.state();
    expect(afterFail.nowPlaying?.item.trackId).toBe(cached.id);
    expect(afterFail.nowPlaying?.item.requesterId).toBe('auto-dj');
    expect(afterFail.queue).toHaveLength(1);
    expect(afterFail.queue[0].track.status).toBe('error');

    // 2. Removing the last queued downloading item while idle -> Auto-DJ takes over
    jukebox.setAutoDjConfig({ enabled: true, mode: 'category', category: 'Jazz' });
    jukebox.queue.remove(afterFail.nowPlaying!.item.id, 'host', true);
    jukebox.queue.remove(afterFail.queue[0].id, 'host', true);
    expect(jukebox.queue.state().nowPlaying).toBeNull();

    media.hold();
    media.failIds.clear();
    const { item: queuedPending } = jukebox.enqueue({
      result: ytResult('pending0001', 'Pending'),
      requesterId: 'guest-2',
      requesterName: 'Bia',
    });
    // Switch back to random via settings/next state without triggering yet, or switch category after adding Jazz track
    const jazzPath = path.join(config.musicDir, 'Jazz.mp3');
    fs.writeFileSync(jazzPath, Buffer.alloc(128, 2));
    const jazz = jukebox.tracks.insertLocal(jazzPath, {
      title: 'Jazz Track',
      artist: 'Jazz Artist',
      genre: 'Jazz',
    });
    jukebox.queue.remove(queuedPending.id, 'guest-2', false);

    expect(jukebox.queue.state().nowPlaying?.item.trackId).toBe(jazz.id);
    expect(jukebox.queue.state().nowPlaying?.item.requesterId).toBe('auto-dj');
    media.release();
    await jukebox.downloads.idle();
  });

  it('emits a clear notice when restricted Auto-DJ mode has no ready candidates', () => {
    const { config, jukebox } = setup();
    fs.writeFileSync(path.join(config.musicDir, 'Pop.mp3'), Buffer.alloc(128, 1));
    jukebox.tracks.insertLocal(path.join(config.musicDir, 'Pop.mp3'), {
      title: 'Pop Song',
      artist: 'Artist',
      genre: 'Pop',
    });

    const notices: { message: string; error: boolean }[] = [];
    jukebox.on('notice', (message, error) => notices.push({ message, error }));

    jukebox.setAutoDjConfig({ enabled: true, mode: 'category', category: 'Jazz' });

    expect(jukebox.queue.state().nowPlaying).toBeNull();
    expect(notices.some((n) => n.error && n.message.includes('Jazz'))).toBe(true);
  });
});
