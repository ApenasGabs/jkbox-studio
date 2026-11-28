import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { KioskControl } from './lib/kioskControl.js';
import { type EffectivePublicUrlResult, resolveEffectivePublicUrl } from './lib/networkUrl.js';
import type { Jukebox } from './services/jukebox.js';
import type { MdnsService, MdnsStatus } from './services/mdns.js';
import { type PlaybackOutput, REACTION_EMOJIS, type ReactionEmoji } from './types.js';

export const KIOSK_COMMANDS = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'SELECT', 'PLAY', 'BACK', 'MENU', 'SKIP'] as const;
export type KioskCommand = (typeof KIOSK_COMMANDS)[number];
export type KioskInputPhase = 'press' | 'down' | 'up';

const ALLOWED_REACTION_EMOJIS = new Set<string>(REACTION_EMOJIS);
const ALLOWED_KIOSK_COMMANDS = new Set<string>(KIOSK_COMMANDS);
const ALLOWED_INPUT_PHASES = new Set<string>(['press', 'down', 'up']);
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
  mdns?: MdnsService;
  port?: number;
  publicUrl?: string;
  getLanIps?: () => string[];
  networkPollIntervalMs?: number;
}

export type ServerMessage =
  | { type: 'state'; state: ReturnType<Jukebox['queue']['state']>; playbackOutput: PlaybackOutput }
  | { type: 'progress'; positionSec: number; paused: boolean }
  | { type: 'download'; trackId: string; status: string; progress: number; error: string | null }
  | { type: 'lyrics_offset'; trackId: string; offsetMs: number }
  | { type: 'reaction'; emoji: ReactionEmoji; senderName?: string }
  | { type: 'notice'; message: string; error?: boolean }
  | { type: 'input'; command: KioskCommand; phase: KioskInputPhase; source?: string }
  | { type: 'mdns'; mdns: MdnsStatus }
  | { type: 'network'; network: EffectivePublicUrlResult }
  | { type: 'kiosk_control'; control: KioskControl };

export type ClientMessage =
  | { type: 'progress'; queueId: number; positionSec: number; paused: boolean }
  | { type: 'reaction'; emoji: ReactionEmoji; senderName?: string; clientId?: string }
  | { type: 'input'; command: KioskCommand; phase?: KioskInputPhase; source?: string };

function isLoopbackRemote(address: string | undefined): boolean {
  if (!address) return false;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isLocalInputConnection(req: IncomingMessage | undefined): boolean {
  if (!req) return false;
  if (req.headers['x-forwarded-for']) return false;
  return isLoopbackRemote(req.socket.remoteAddress);
}

function sanitizeInputSource(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 32);
  return clean || undefined;
}

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
      broadcast({ type: 'state', state: queue.state(), playbackOutput: jukebox.playbackOutput });
    });
  };

  queue.on('change', pushState);
  jukebox.on('output', pushState);
  jukebox.on('notice', (message, error) => broadcast({ type: 'notice', message, error }));
  const onKioskControl = (control: KioskControl) => broadcast({ type: 'kiosk_control', control });
  jukebox.on('kiosk_control', onKioskControl);
  queue.on('progress', (positionSec, paused) => broadcast({ type: 'progress', positionSec, paused }));
  const onDownload = (track: { id: string; status: string; progress: number; error: string | null }) =>
    broadcast({ type: 'download', trackId: track.id, status: track.status, progress: track.progress, error: track.error });
  const onTrackUpdated = (track: { id: string; status: string; progress: number; error: string | null }) => {
    onDownload(track);
    pushState();
  };
  downloads.on('progress', onDownload);
  downloads.on('ready', onTrackUpdated);
  downloads.on('video', onTrackUpdated);
  downloads.on('failed', onTrackUpdated);
  lyrics.on('offset', (trackId, offsetMs) => broadcast({ type: 'lyrics_offset', trackId, offsetMs }));
  const onMdnsChange = (mdns: MdnsStatus) => broadcast({ type: 'mdns', mdns });
  const onNetworkChange = (network: EffectivePublicUrlResult) => broadcast({ type: 'network', network });
  options.mdns?.on('change', onMdnsChange);
  options.mdns?.on('network', onNetworkChange);

  const hasCustomNetworkProbe =
    !options.mdns && (options.getLanIps !== undefined || options.port !== undefined || options.publicUrl !== undefined);
  const readCurrentNetwork = (): EffectivePublicUrlResult | null => {
    if (options.mdns) return options.mdns.networkStatus();
    if (!hasCustomNetworkProbe) return null;
    return resolveEffectivePublicUrl({
      publicUrl: options.publicUrl ?? '',
      port: options.port ?? 3000,
      lanIps: options.getLanIps ? options.getLanIps() : undefined,
    });
  };

  let lastCustomNetworkKey: string | null = null;
  let customNetworkTimer: ReturnType<typeof setInterval> | null = null;
  if (hasCustomNetworkProbe) {
    const initialNet = readCurrentNetwork();
    lastCustomNetworkKey = initialNet ? JSON.stringify(initialNet) : null;
    const pollMs = options.networkPollIntervalMs ?? 0;
    if (pollMs > 0) {
      customNetworkTimer = setInterval(() => {
        const nextNet = readCurrentNetwork();
        if (!nextNet) return;
        const nextKey = JSON.stringify(nextNet);
        if (nextKey !== lastCustomNetworkKey) {
          lastCustomNetworkKey = nextKey;
          broadcast({ type: 'network', network: nextNet });
        }
      }, pollMs);
      customNetworkTimer.unref();
    }
  }

  wss.on('connection', (socket, req) => {
    const localInputAllowed = isLocalInputConnection(req);
    socket.send(
      JSON.stringify({ type: 'state', state: queue.state(), playbackOutput: jukebox.playbackOutput } satisfies ServerMessage),
    );
    if (options.mdns) {
      socket.send(JSON.stringify({ type: 'mdns', mdns: options.mdns.status() } satisfies ServerMessage));
    }
    const currentNet = readCurrentNetwork();
    if (currentNet) {
      socket.send(JSON.stringify({ type: 'network', network: currentNet } satisfies ServerMessage));
    }
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
      } else if (msg.type === 'input') {
        if (!localInputAllowed) return;
        const command = typeof msg.command === 'string' ? msg.command.trim().toUpperCase() : '';
        if (!ALLOWED_KIOSK_COMMANDS.has(command)) return;
        const phase = msg.phase === undefined ? 'press' : String(msg.phase).trim().toLowerCase();
        if (!ALLOWED_INPUT_PHASES.has(phase)) return;
        const source = sanitizeInputSource(msg.source);
        broadcast({
          type: 'input',
          command: command as KioskCommand,
          phase: phase as KioskInputPhase,
          ...(source ? { source } : {}),
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
  wss.on('close', () => {
    clearInterval(interval);
    if (customNetworkTimer) clearInterval(customNetworkTimer);
    options.mdns?.off('change', onMdnsChange);
    options.mdns?.off('network', onNetworkChange);
    jukebox.off('kiosk_control', onKioskControl);
  });

  return wss;
}
