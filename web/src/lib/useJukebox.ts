import { useCallback, useEffect, useRef, useState } from 'react';
import {
  KIOSK_COMMANDS,
  type JukeboxState,
  type KioskCommand,
  type KioskInputEvent,
  type KioskInputPhase,
  type PlaybackOutput,
  type ReactionEmoji,
  type ServerMessage,
  type TrackStatus,
} from './types';

const ALLOWED_COMMANDS = new Set<string>(KIOSK_COMMANDS);
const ALLOWED_PHASES = new Set<string>(['press', 'down', 'up']);

export interface DownloadInfo {
  status: TrackStatus;
  progress: number;
  error: string | null;
}

export interface LyricsOffsetEvent {
  trackId: string;
  offsetMs: number;
  seq: number;
}

export interface LiveReaction {
  id: number;
  emoji: ReactionEmoji;
  senderName?: string;
}

export interface JukeboxNotice {
  seq: number;
  message: string;
  error: boolean;
}

const REACTION_TTL_MS = 3000;
const MAX_ACTIVE_REACTIONS = 24;

/** Live jukebox state over WebSocket with automatic reconnection. */
export function useJukebox() {
  const [state, setState] = useState<JukeboxState>({ nowPlaying: null, queue: [] });
  const [playbackOutput, setPlaybackOutput] = useState<PlaybackOutput>({ type: 'local' });
  const [position, setPosition] = useState({ positionSec: 0, paused: false });
  const [downloads, setDownloads] = useState<Record<string, DownloadInfo>>({});
  const [lyricsOffset, setLyricsOffset] = useState<LyricsOffsetEvent | null>(null);
  const [reactions, setReactions] = useState<LiveReaction[]>([]);
  const [notice, setNotice] = useState<JukeboxNotice | null>(null);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const offsetSeqRef = useRef(0);
  const reactionSeqRef = useRef(0);
  const noticeSeqRef = useRef(0);
  const reactionTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const inputSubscribersRef = useRef<Set<(event: KioskInputEvent) => void>>(new Set());

  const subscribeInput = useCallback((handler: (event: KioskInputEvent) => void) => {
    inputSubscribersRef.current.add(handler);
    return () => {
      inputSubscribersRef.current.delete(handler);
    };
  }, []);

  useEffect(() => {
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout>;

    const connect = () => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
      socketRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        setConnected(true);
      };
      ws.onmessage = (event) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(event.data) as ServerMessage;
        } catch {
          return; // ignore malformed frames
        }
        if (msg.type === 'state') {
          setState(msg.state);
          if (msg.playbackOutput) setPlaybackOutput(msg.playbackOutput);
          setPosition({ positionSec: msg.state.nowPlaying?.positionSec ?? 0, paused: msg.state.nowPlaying?.paused ?? false });
        } else if (msg.type === 'progress') {
          setPosition({ positionSec: msg.positionSec, paused: msg.paused });
        } else if (msg.type === 'download') {
          setDownloads((prev) => ({ ...prev, [msg.trackId]: { status: msg.status, progress: msg.progress, error: msg.error } }));
        } else if (msg.type === 'lyrics_offset') {
          offsetSeqRef.current += 1;
          setLyricsOffset({ trackId: msg.trackId, offsetMs: msg.offsetMs, seq: offsetSeqRef.current });
        } else if (msg.type === 'notice') {
          noticeSeqRef.current += 1;
          setNotice({ seq: noticeSeqRef.current, message: msg.message, error: Boolean(msg.error) });
        } else if (msg.type === 'reaction') {
          const id = ++reactionSeqRef.current;
          setReactions((prev) => [...prev.slice(-(MAX_ACTIVE_REACTIONS - 1)), { id, emoji: msg.emoji, senderName: msg.senderName }]);
          const expireTimer = setTimeout(() => {
            reactionTimersRef.current.delete(expireTimer);
            setReactions((prev) => prev.filter((item) => item.id !== id));
          }, REACTION_TTL_MS);
          reactionTimersRef.current.add(expireTimer);
        } else if (msg.type === 'input') {
          const command = typeof msg.command === 'string' ? msg.command.trim().toUpperCase() : '';
          if (!ALLOWED_COMMANDS.has(command)) return;
          const phase = msg.phase === undefined ? 'press' : String(msg.phase).trim().toLowerCase();
          if (!ALLOWED_PHASES.has(phase)) return;
          const inputEvent: KioskInputEvent = {
            command: command as KioskCommand,
            phase: phase as KioskInputPhase,
            ...(typeof msg.source === 'string' ? { source: msg.source } : {}),
          };
          for (const listener of inputSubscribersRef.current) listener(inputEvent);
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        timer = setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
      };
      ws.onerror = () => ws.close();
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      for (const expireTimer of reactionTimersRef.current) clearTimeout(expireTimer);
      reactionTimersRef.current.clear();
      socketRef.current?.close();
    };
  }, []);

  const send = useCallback((message: unknown) => {
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }, []);

  return { state, playbackOutput, position, downloads, lyricsOffset, reactions, notice, connected, send, subscribeInput };
}
