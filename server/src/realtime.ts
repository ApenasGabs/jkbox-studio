import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { Jukebox } from './services/jukebox.js';

export type ServerMessage =
  | { type: 'state'; state: ReturnType<Jukebox['queue']['state']> }
  | { type: 'progress'; positionSec: number; paused: boolean }
  | { type: 'download'; trackId: string; status: string; progress: number; error: string | null };

export type ClientMessage = { type: 'progress'; queueId: number; positionSec: number; paused: boolean };

/** Pushes queue/player/download updates to every connected screen and phone. */
export function attachRealtime(server: Server, jukebox: Jukebox): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const { queue, downloads } = jukebox;

  const broadcast = (message: ServerMessage) => {
    const data = JSON.stringify(message);
    for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(data);
  };

  // Coalesce bursts of changes (enqueue + advance + vote...) into one state push.
  let pending: NodeJS.Immediate | null = null;
  const pushState = () => {
    if (pending) return;
    pending = setImmediate(() => {
      pending = null;
      broadcast({ type: 'state', state: queue.state() });
    });
  };

  queue.on('change', pushState);
  queue.on('progress', (positionSec, paused) => broadcast({ type: 'progress', positionSec, paused }));
  const onDownload = (track: { id: string; status: string; progress: number; error: string | null }) =>
    broadcast({ type: 'download', trackId: track.id, status: track.status, progress: track.progress, error: track.error });
  downloads.on('progress', onDownload);
  downloads.on('ready', (track) => {
    onDownload(track);
    pushState();
  });
  downloads.on('failed', (track) => {
    onDownload(track);
    pushState();
  });

  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'state', state: queue.state() } satisfies ServerMessage));
    socket.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      if (msg.type === 'progress' && queue.state().nowPlaying?.item.id === msg.queueId) {
        queue.reportProgress(Number(msg.positionSec) || 0, !!msg.paused);
      }
    });
  });

  // Keep-alive so idle proxies don't drop connections.
  const alive = new WeakMap<WebSocket, boolean>();
  wss.on('connection', (socket) => {
    alive.set(socket, true);
    socket.on('pong', () => alive.set(socket, true));
  });
  const interval = setInterval(() => {
    for (const socket of wss.clients) {
      if (!alive.get(socket)) {
        socket.terminate();
        continue;
      }
      alive.set(socket, false);
      socket.ping();
    }
  }, 30_000);
  interval.unref();
  wss.on('close', () => clearInterval(interval));

  return wss;
}
