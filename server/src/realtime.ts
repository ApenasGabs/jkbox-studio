import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { Jukebox } from './services/jukebox.js';
import { REACTION_EMOJIS, type ReactionEmoji } from './types.js';

const ALLOWED_REACTION_EMOJIS = new Set<string>(REACTION_EMOJIS);
const DEFAULT_REACTION_MAX_COUNT = 5;
const DEFAULT_REACTION_WINDOW_MS = 5_000;
const MAX_CLIENT_BUCKETS = 1000;

export interface ReactionRateLimitOptions {
  maxCount?: number;
  windowMs?: number;
  now?: () => number;
}

export interface RealtimeOptions {
  reactionRateLimit?: ReactionRateLimitOptions;
}

export type ServerMessage =
  | { type: 'state'; state: ReturnType<Jukebox['queue']['state']> }
  | { type: 'progress'; positionSec: number; paused: boolean }
  | { type: 'download'; trackId: string; status: string; progress: number; error: string | null }
  | { type: 'lyrics_offset'; trackId: string; offsetMs: number }
  | { type: 'reaction'; emoji: ReactionEmoji; senderName?: string };

export type ClientMessage =
  | { type: 'progress'; queueId: number; positionSec: number; paused: boolean }
  | { type: 'reaction'; emoji: ReactionEmoji; senderName?: string; clientId?: string };

function sanitizeSenderName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 40);
  return clean || undefined;
}

function createReactionLimiter(options: ReactionRateLimitOptions = {}) {
  const maxCount = Math.max(1, options.maxCount ?? DEFAULT_REACTION_MAX_COUNT);
  const windowMs = Math.max(1, options.windowMs ?? DEFAULT_REACTION_WINDOW_MS);
  const nowFn = options.now ?? Date.now;
  const socketBuckets = new WeakMap<WebSocket, number[]>();
  const clientBuckets = new Map<string, number[]>();

  const prune = (timestamps: number[] | undefined, cutoff: number): number[] =>
    timestamps ? timestamps.filter((ts) => ts > cutoff) : [];

  const cleanupClientBuckets = (cutoff: number) => {
    if (clientBuckets.size <= MAX_CLIENT_BUCKETS) return;
    for (const [id, timestamps] of clientBuckets) {
      const fresh = prune(timestamps, cutoff);
      if (fresh.length === 0) clientBuckets.delete(id);
      else clientBuckets.set(id, fresh);
    }
  };

  return (socket: WebSocket, clientId: string): boolean => {
    const now = nowFn();
    const cutoff = now - windowMs;
    const sockHits = prune(socketBuckets.get(socket), cutoff);
    if (sockHits.length >= maxCount) {
      socketBuckets.set(socket, sockHits);
      return false;
    }

    let clientHits: number[] | null = null;
    if (clientId) {
      clientHits = prune(clientBuckets.get(clientId), cutoff);
      if (clientHits.length >= maxCount) {
        clientBuckets.set(clientId, clientHits);
        return false;
      }
    }

    sockHits.push(now);
    socketBuckets.set(socket, sockHits);
    if (clientId && clientHits) {
      clientHits.push(now);
      clientBuckets.set(clientId, clientHits);
      cleanupClientBuckets(cutoff);
    }
    return true;
  };
}

/** Pushes queue/player/download/reaction updates to every connected screen and phone. */
export function attachRealtime(server: Server, jukebox: Jukebox, options: RealtimeOptions = {}): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const { queue, downloads, lyrics } = jukebox;
  const allowReaction = createReactionLimiter(options.reactionRateLimit);

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
  lyrics.on('offset', (trackId, offsetMs) => broadcast({ type: 'lyrics_offset', trackId, offsetMs }));

  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'state', state: queue.state() } satisfies ServerMessage));
    socket.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'progress' && queue.state().nowPlaying?.item.id === msg.queueId) {
        queue.reportProgress(Number(msg.positionSec) || 0, !!msg.paused);
      } else if (msg.type === 'reaction') {
        if (typeof msg.emoji !== 'string' || !ALLOWED_REACTION_EMOJIS.has(msg.emoji)) return;
        const clientId = typeof msg.clientId === 'string' ? msg.clientId.trim().slice(0, 128) : '';
        if (!allowReaction(socket, clientId)) return;
        const senderName = sanitizeSenderName(msg.senderName);
        broadcast({
          type: 'reaction',
          emoji: msg.emoji as ReactionEmoji,
          ...(senderName ? { senderName } : {}),
        });
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
