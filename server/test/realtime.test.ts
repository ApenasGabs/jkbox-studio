import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import { attachRealtime } from '../src/realtime.js';
import { setup, ytResult } from './helpers.js';

let server: http.Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function nextMessage(ws: WebSocket, predicate: (msg: any) => boolean): Promise<any> {
  return new Promise((resolve) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(String(raw));
      if (predicate(msg)) {
        ws.off('message', onMessage);
        resolve(msg);
      }
    };
    ws.on('message', onMessage);
  });
}

describe('WebSocket realtime sync', () => {
  it('pushes queue state and player progress to all connected clients', async () => {
    const { config, jukebox } = setup();
    server = http.createServer(createApp({ config, jukebox }));
    const wss = attachRealtime(server, jukebox);
    await new Promise<void>((r) => server!.listen(0, r));
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;

    const kiosk = new WebSocket(url);
    const phone = new WebSocket(url);
    const initial = await Promise.all([
      nextMessage(kiosk, (m) => m.type === 'state'),
      nextMessage(phone, (m) => m.type === 'state'),
    ]);
    expect(initial[0].state).toEqual({ nowPlaying: null, queue: [] });

    const phoneSeesPlaying = nextMessage(phone, (m) => m.type === 'state' && m.state.nowPlaying);
    jukebox.enqueue({ result: ytResult('dQw4w9WgXcQ'), requesterId: 'p', requesterName: 'Phone' });
    const playing = await phoneSeesPlaying;
    expect(playing.state.nowPlaying.item.track.sourceId).toBe('dQw4w9WgXcQ');

    const progress = nextMessage(phone, (m) => m.type === 'progress');
    kiosk.send(JSON.stringify({ type: 'progress', queueId: playing.state.nowPlaying.item.id, positionSec: 42, paused: false }));
    expect(await progress).toEqual({ type: 'progress', positionSec: 42, paused: false });

    kiosk.close();
    phone.close();
    wss.close();
  });
});
