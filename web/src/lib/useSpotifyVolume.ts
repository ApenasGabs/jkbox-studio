import { useCallback, useEffect, useRef } from 'react';
import { api } from './api';
import { describeSpotifyConnectError } from './spotifyConnect';

/** Debounced Spotify Connect volume controller shared across Kiosk and Remote selectors. */
export function useSpotifyVolumeControl(
  onVolumeChange: (volume: number) => void,
  onError?: (info: { message: string; code?: string }) => void,
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onVolumeChangeRef = useRef(onVolumeChange);
  const onErrorRef = useRef(onError);
  onVolumeChangeRef.current = onVolumeChange;
  onErrorRef.current = onError;

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return useCallback((nextVolume: number, immediate: boolean) => {
    const clamped = Math.max(0, Math.min(100, Math.round(nextVolume)));
    onVolumeChangeRef.current(clamped);
    if (timerRef.current) clearTimeout(timerRef.current);
    const send = () => {
      api.spotifySetVolume(clamped).catch((err) => {
        onErrorRef.current?.(describeSpotifyConnectError(err));
      });
    };
    if (immediate) send();
    else timerRef.current = setTimeout(send, 150);
  }, []);
}
