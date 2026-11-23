import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import { attachRealtime, type ServerMessage } from '../src/realtime.js';
import { MdnsService } from '../src/services/mdns.js';
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
    expect(initial[0].playbackOutput).toEqual({ type: 'local' });

    const noticePromise = nextMessage(phone, (m) => m.type === 'notice');
    jukebox.emit('notice', 'Faixa indisponível no Spotify', true);
    expect(await noticePromise).toEqual({ type: 'notice', message: 'Faixa indisponível no Spotify', error: true });

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

  it('validates reaction emoji whitelist and enforces rate-limit per connection/clientId', async () => {
    const { config, jukebox } = setup();
    let fakeNow = 10_000;
    server = http.createServer(createApp({ config, jukebox }));
    const wss = attachRealtime(server, jukebox, {
      reactionRateLimit: { maxCount: 2, windowMs: 5000, now: () => fakeNow },
    });
    await new Promise<void>((r) => server!.listen(0, r));
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;

    const kiosk = new WebSocket(url);
    const phone1 = new WebSocket(url);
    const phone2 = new WebSocket(url);
    await Promise.all([
      nextMessage(kiosk, (m) => m.type === 'state'),
      nextMessage(phone1, (m) => m.type === 'state'),
      nextMessage(phone2, (m) => m.type === 'state'),
    ]);

    const received: ServerMessage[] = [];
    kiosk.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as ServerMessage;
      if (msg.type === 'reaction') received.push(msg);
    });

    // Invalid emoji must be rejected; valid reactions up to maxCount (2) must broadcast
    phone1.send(JSON.stringify({ type: 'reaction', emoji: '💩', senderName: 'Troll', clientId: 'guest-1' }));
    phone1.send(JSON.stringify({ type: 'reaction', emoji: '🔥', senderName: '  Ana  ', clientId: 'guest-1' }));
    phone1.send(JSON.stringify({ type: 'reaction', emoji: '👏', senderName: '', clientId: 'guest-1' }));
    // 3rd reaction in window from same socket/clientId must be rate-limited
    phone1.send(JSON.stringify({ type: 'reaction', emoji: '🎉', senderName: 'Ana', clientId: 'guest-1' }));
    // Another connection using the same clientId must also be rate-limited
    phone2.send(JSON.stringify({ type: 'reaction', emoji: '❤️', senderName: 'Ana', clientId: 'guest-1' }));

    await new Promise((r) => setTimeout(r, 80));
    expect(received).toEqual([
      { type: 'reaction', emoji: '🔥', senderName: 'Ana' },
      { type: 'reaction', emoji: '👏' },
    ]);

    // Advancing past the window allows reactions again
    fakeNow += 5001;
    phone2.send(JSON.stringify({ type: 'reaction', emoji: '🎤', senderName: 'Ana', clientId: 'guest-1' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual([
      { type: 'reaction', emoji: '🔥', senderName: 'Ana' },
      { type: 'reaction', emoji: '👏' },
      { type: 'reaction', emoji: '🎤', senderName: 'Ana' },
    ]);

    kiosk.close();
    phone1.close();
    phone2.close();
    wss.close();
  });

  it('broadcasts validated local input commands and rejects invalid or proxied inputs', async () => {
    const { config, jukebox } = setup();
    server = http.createServer(createApp({ config, jukebox }));
    const wss = attachRealtime(server, jukebox);
    await new Promise<void>((r) => server!.listen(0, r));
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;

    const kiosk = new WebSocket(url);
    const localDaemon = new WebSocket(url);
    const proxiedGuest = new WebSocket(url, { headers: { 'x-forwarded-for': '192.168.1.50' } });
    await Promise.all([
      nextMessage(kiosk, (m) => m.type === 'state'),
      nextMessage(localDaemon, (m) => m.type === 'state'),
      nextMessage(proxiedGuest, (m) => m.type === 'state'),
    ]);

    const received: ServerMessage[] = [];
    kiosk.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as ServerMessage;
      if (msg.type === 'input') received.push(msg);
    });

    // Proxied/remote client cannot inject hardware input commands
    proxiedGuest.send(JSON.stringify({ type: 'input', command: 'SKIP', source: 'guest' }));
    // Invalid command / phase from local daemon are ignored
    localDaemon.send(JSON.stringify({ type: 'input', command: 'DROP_ALL' }));
    localDaemon.send(JSON.stringify({ type: 'input', command: 'UP', phase: 'hold' }));
    // Valid local daemon inputs are normalized and broadcast
    localDaemon.send(JSON.stringify({ type: 'input', command: 'up', source: 'evdev' }));
    localDaemon.send(JSON.stringify({ type: 'input', command: 'SELECT', phase: 'down', source: 'evdev' }));
    localDaemon.send(JSON.stringify({ type: 'input', command: 'SELECT', phase: 'up', source: 'evdev' }));

    await new Promise((r) => setTimeout(r, 60));
    expect(received).toEqual([
      { type: 'input', command: 'UP', phase: 'press', source: 'evdev' },
      { type: 'input', command: 'SELECT', phase: 'down', source: 'evdev' },
      { type: 'input', command: 'SELECT', phase: 'up', source: 'evdev' },
    ]);

    kiosk.close();
    localDaemon.close();
    proxiedGuest.close();
    wss.close();
  });

  it('broadcasts mdns hostname and QR preference changes over WebSocket', async () => {
    const { config, jukebox } = setup({ HOST_PIN: '1234' });
    const mdns = new MdnsService({
      port: 3000,
      defaultHostname: 'jkbox',
      enabled: true,
      hostnameHelper: '/usr/local/bin/jkbox-hostname',
      settings: jukebox.settings,
      runHelper: async () => {},
      detectDockerBridge: () => false,
    });
    mdns.start();

    server = http.createServer(createApp({ config, jukebox, mdns }));
    const wss = attachRealtime(server, jukebox, { mdns });
    await new Promise<void>((r) => server!.listen(0, r));
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;

    const kiosk = new WebSocket(url);
    const initialMdns = await nextMessage(kiosk, (m) => m.type === 'mdns');
    expect(initialMdns.mdns).toMatchObject({ hostname: 'jkbox', useForQr: false });

    const updatedPromise = nextMessage(kiosk, (m) => m.type === 'mdns' && m.mdns.hostname === 'gabisa');
    await mdns.update({ hostname: 'gabisa', useForQr: true });
    const updated = await updatedPromise;
    expect(updated.mdns).toMatchObject({
      hostname: 'gabisa',
      fqdn: 'gabisa.local',
      url: 'http://gabisa.local:3000',
      useForQr: true,
    });

    kiosk.close();
    wss.close();
    mdns.stop();
    jukebox.stop();
  });
});
