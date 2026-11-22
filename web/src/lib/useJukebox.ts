import { useCallback, useEffect, useRef, useState } from 'react';
import type { JukeboxState, ReactionEmoji, ServerMessage, TrackStatus } from './types';

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

const REACTION_TTL_MS = 3000;
const MAX_ACTIVE_REACTIONS = 24;

/** Live jukebox state over WebSocket with automatic reconnection. */
export function useJukebox() {
  const [state, setState] = useState<JukeboxState>({ nowPlaying: null, queue: [] });
  const [position, setPosition] = useState({ positionSec: 0, paused: false });
  const [downloads, setDownloads] = useState<Record<string, DownloadInfo>>({});
  const [lyricsOffset, setLyricsOffset] = useState<LyricsOffsetEvent | null>(null);
  const [reactions, setReactions] = useState<LiveReaction[]>([]);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const offsetSeqRef = useRef(0);
  const reactionSeqRef = useRef(0);
  const reactionTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

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
          setPosition({ positionSec: msg.state.nowPlaying?.positionSec ?? 0, paused: msg.state.nowPlaying?.paused ?? false });
        } else if (msg.type === 'progress') {
          setPosition({ positionSec: msg.positionSec, paused: msg.paused });
        } else if (msg.type === 'download') {
          setDownloads((prev) => ({ ...prev, [msg.trackId]: { status: msg.status, progress: msg.progress, error: msg.error } }));
        } else if (msg.type === 'lyrics_offset') {
          offsetSeqRef.current += 1;
          setLyricsOffset({ trackId: msg.trackId, offsetMs: msg.offsetMs, seq: offsetSeqRef.current });
        } else if (msg.type === 'reaction') {
          const id = ++reactionSeqRef.current;
          setReactions((prev) => [...prev.slice(-(MAX_ACTIVE_REACTIONS - 1)), { id, emoji: msg.emoji, senderName: msg.senderName }]);
          const expireTimer = setTimeout(() => {
            reactionTimersRef.current.delete(expireTimer);
            setReactions((prev) => prev.filter((item) => item.id !== id));
          }, REACTION_TTL_MS);
          reactionTimersRef.current.add(expireTimer);
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

  return { state, position, downloads, lyricsOffset, reactions, connected, send };
}
