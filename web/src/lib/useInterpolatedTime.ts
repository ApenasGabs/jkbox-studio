import { useEffect, useRef, useState } from 'react';
import { interpolatePlaybackSec } from './lrc';

/**
 * Smoothly interpolates WebSocket `positionSec` ticks at 100ms intervals while playing.
 */
export function useInterpolatedTime(
  position: { positionSec: number; paused: boolean },
  active: boolean,
  connected: boolean,
  durationSec?: number | null,
): number {
  const anchorRef = useRef({ baseSec: position.positionSec, anchorMs: performance.now() });
  const [currentSec, setCurrentSec] = useState(position.positionSec);

  useEffect(() => {
    anchorRef.current = { baseSec: position.positionSec, anchorMs: performance.now() };
    setCurrentSec(position.positionSec);
  }, [position]);

  useEffect(() => {
    if (!active || position.paused || !connected) return;
    const id = window.setInterval(() => {
      const elapsedMs = Math.min(3000, performance.now() - anchorRef.current.anchorMs);
      setCurrentSec(interpolatePlaybackSec(anchorRef.current.baseSec, elapsedMs, false, durationSec));
    }, 100);
    return () => window.clearInterval(id);
  }, [active, position.paused, connected, durationSec]);

  return currentSec;
}
