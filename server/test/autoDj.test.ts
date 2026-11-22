import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
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
});
