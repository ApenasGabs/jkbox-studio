import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { DownloadManager } from '../src/services/downloads.js';
import { TrackRepository } from '../src/services/tracks.js';
import type { MediaProvider } from '../src/services/ytdlp.js';
import type { SearchResult } from '../src/types.js';
import { ytResult } from './helpers.js';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class ControllableMedia implements MediaProvider {
  audioCalls: string[] = [];
  videoCalls: string[] = [];
  callLog: string[] = [];
  audioGates = new Map<string, Deferred>();
  videoGates = new Map<string, Deferred>();
  failVideos = new Set<string>();

  async search(): Promise<SearchResult[]> {
    return [];
  }
  async getVideo(videoId: string): Promise<SearchResult> {
    return ytResult(videoId);
  }
  async getPlaylist(): Promise<SearchResult[]> {
    return [];
  }
  async version(): Promise<string> {
    return 'test';
  }

  async download(videoId: string, outputBase: string, onProgress: (f: number) => void) {
    this.audioCalls.push(videoId);
    this.callLog.push(`audio:${videoId}`);
    const gate = this.audioGates.get(videoId);
    if (gate) await gate.promise;
    onProgress(0.5);
    onProgress(1);
    const filePath = `${outputBase}.m4a`;
    fs.writeFileSync(filePath, Buffer.alloc(64, 1));
    return { filePath };
  }

  async downloadVideo(videoId: string, outputBase: string, _maxHeight: number, onProgress: (f: number) => void) {
    this.videoCalls.push(videoId);
    this.callLog.push(`video:${videoId}`);
    const gate = this.videoGates.get(videoId);
    if (gate) await gate.promise;
    if (this.failVideos.has(videoId)) throw new Error('video failed');
    onProgress(1);
    const filePath = `${outputBase}.mp4`;
    fs.writeFileSync(filePath, Buffer.alloc(128, 2));
    return { filePath };
  }
}

function createHarness(concurrency = 2) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jkbox-dl-test-'));
  const db = openDb(path.join(dir, 'test.db'));
  const tracks = new TrackRepository(db);
  const media = new ControllableMedia();
  const manager = new DownloadManager(tracks, media, path.join(dir, 'music'), concurrency, async () => null, {
    videoMode: 'cache',
    videoMaxHeight: 720,
    log: () => {},
  });
  return { tracks, media, manager };
}

describe('DownloadManager audio-first & prioritized backfill', () => {
  it('marks track ready and emits ready immediately after audio finishes, before background video completes', async () => {
    const { tracks, media, manager } = createHarness(2);
    const videoGate = deferred();
    media.videoGates.set('vidReady001', videoGate);

    const track = tracks.upsertFromResult(ytResult('vidReady001', 'Audio First'));
    const readyEvents: string[] = [];
    const videoEvents: string[] = [];
    manager.on('ready', (t) => readyEvents.push(t.id));
    manager.on('video', (t) => videoEvents.push(t.id));

    manager.ensure(track.id);

    // Wait until audio is done and video download has started (still blocked by videoGate).
    await new Promise<void>((resolve) => {
      if (readyEvents.length > 0 && media.videoCalls.includes('vidReady001')) return resolve();
      const timer = setInterval(() => {
        if (readyEvents.length > 0 && media.videoCalls.includes('vidReady001')) {
          clearInterval(timer);
          resolve();
        }
      }, 5);
    });

    const afterAudio = tracks.get(track.id)!;
    expect(afterAudio.status).toBe('ready');
    expect(afterAudio.progress).toBe(1);
    expect(afterAudio.filePath).toBeTruthy();
    expect(afterAudio.videoPath).toBeNull();
    expect(readyEvents).toEqual([track.id]);
    expect(videoEvents).toEqual([]);

    // Now let the background video finish.
    videoGate.resolve();
    await manager.idle();

    const afterVideo = tracks.get(track.id)!;
    expect(afterVideo.status).toBe('ready');
    expect(afterVideo.videoPath).toBeTruthy();
    expect(fs.existsSync(afterVideo.videoPath!)).toBe(true);
    expect(videoEvents).toEqual([track.id]);
  });

  it('prioritizes pending audio downloads over queued background video backfills', async () => {
    const { tracks, media, manager } = createHarness(1);
    const audio1 = deferred();
    const audio2 = deferred();
    const audio3 = deferred();
    media.audioGates.set('trackOne001', audio1);
    media.audioGates.set('trackTwo002', audio2);
    media.audioGates.set('trackThr003', audio3);

    const t1 = tracks.upsertFromResult(ytResult('trackOne001', 'Track 1'));
    const t2 = tracks.upsertFromResult(ytResult('trackTwo002', 'Track 2'));
    const t3 = tracks.upsertFromResult(ytResult('trackThr003', 'Track 3'));

    manager.ensure(t1.id);
    manager.ensure(t2.id);
    manager.ensure(t3.id);

    // Track 1 finishes audio while Track 2 and Track 3 are still pending audio.
    audio1.resolve();
    await new Promise((r) => setTimeout(r, 20));
    expect(tracks.get(t1.id)!.status).toBe('ready');
    // Video backfill for Track 1 must NOT start while audio downloads remain queued.
    expect(media.videoCalls).toEqual([]);

    audio2.resolve();
    await new Promise((r) => setTimeout(r, 20));
    expect(media.videoCalls).toEqual([]);

    audio3.resolve();
    await manager.idle();

    expect(media.callLog).toEqual([
      'audio:trackOne001',
      'audio:trackTwo002',
      'audio:trackThr003',
      'video:trackOne001',
      'video:trackTwo002',
      'video:trackThr003',
    ]);
  });

  it('reserves an audio slot so background video backfills never occupy all DOWNLOAD_CONCURRENCY slots', async () => {
    const { tracks, media, manager } = createHarness(2);
    const v1Gate = deferred();
    const v2Gate = deferred();
    const a3Gate = deferred();
    media.videoGates.set('slotVid0001', v1Gate);
    media.videoGates.set('slotVid0002', v2Gate);
    media.audioGates.set('slotAud0003', a3Gate);

    const t1 = tracks.upsertFromResult(ytResult('slotVid0001', 'T1'));
    const t2 = tracks.upsertFromResult(ytResult('slotVid0002', 'T2'));
    manager.ensure(t1.id);
    manager.ensure(t2.id);

    // Wait until T1 & T2 audio finish and T1 background video starts.
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (media.videoCalls.includes('slotVid0001')) {
          clearInterval(timer);
          resolve();
        }
      }, 5);
    });
    await new Promise((r) => setTimeout(r, 20));

    // With concurrency=2, max 1 background video runs so the 2nd slot stays free for audio.
    expect(media.videoCalls).toEqual(['slotVid0001']);

    // Enqueue a new audio download while T1 video is still blocked -> it must start immediately!
    const t3 = tracks.upsertFromResult(ytResult('slotAud0003', 'T3'));
    manager.ensure(t3.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(media.audioCalls).toContain('slotAud0003');

    a3Gate.resolve();
    v1Gate.resolve();
    v2Gate.resolve();
    await manager.idle();
    expect(tracks.get(t3.id)!.status).toBe('ready');
  });

  it('keeps track ready when background video backfill fails', async () => {
    const { tracks, media, manager } = createHarness(2);
    media.failVideos.add('vidFail0001');
    const t1 = tracks.upsertFromResult(ytResult('vidFail0001', 'Fail Video'));

    manager.ensure(t1.id);
    await manager.idle();

    const finalTrack = tracks.get(t1.id)!;
    expect(finalTrack.status).toBe('ready');
    expect(finalTrack.filePath).toBeTruthy();
    expect(finalTrack.videoPath).toBeNull();
  });
});
