import { useCallback, useEffect, useRef, useState } from 'react';
import type { JukeboxState, ServerMessage, TrackStatus } from './types';

export interface DownloadInfo {
  status: TrackStatus;
  progress: number;
  error: string | null;
}

/** Live jukebox state over WebSocket with automatic reconnection. */
export function useJukebox() {
  const [state, setState] = useState<JukeboxState>({ nowPlaying: null, queue: [] });
  const [position, setPosition] = useState({ positionSec: 0, paused: false });
  const [downloads, setDownloads] = useState<Record<string, DownloadInfo>>({});
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);

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
        const msg = JSON.parse(event.data) as ServerMessage;
        if (msg.type === 'state') {
          setState(msg.state);
          setPosition({ positionSec: msg.state.nowPlaying?.positionSec ?? 0, paused: msg.state.nowPlaying?.paused ?? false });
        } else if (msg.type === 'progress') {
          setPosition({ positionSec: msg.positionSec, paused: msg.paused });
        } else if (msg.type === 'download') {
          setDownloads((prev) => ({ ...prev, [msg.trackId]: { status: msg.status, progress: msg.progress, error: msg.error } }));
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
      socketRef.current?.close();
    };
  }, []);

  const send = useCallback((message: unknown) => {
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }, []);

  return { state, position, downloads, connected, send };
}
