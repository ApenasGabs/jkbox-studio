import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { TrackLyrics } from './types';
import type { LyricsOffsetEvent } from './useJukebox';

export function useTrackLyrics(trackId: string | undefined, lyricsOffset: LyricsOffsetEvent | null) {
  const [lyrics, setLyrics] = useState<TrackLyrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadSeq, setReloadSeq] = useState(0);

  const reload = useCallback(() => setReloadSeq((n) => n + 1), []);

  useEffect(() => {
    if (!trackId) {
      setLyrics(null);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setLyrics(null);

    api
      .lyrics(trackId, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setLyrics(data);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || (err as Error).name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Erro ao carregar letra');
        setLoading(false);
      });

    return () => controller.abort();
  }, [trackId, reloadSeq]);

  useEffect(() => {
    if (!lyricsOffset || !trackId || lyricsOffset.trackId !== trackId) return;
    setLyrics((prev) => (prev && prev.trackId === trackId ? { ...prev, offsetMs: lyricsOffset.offsetMs } : prev));
  }, [lyricsOffset, trackId]);

  return { lyrics, setLyrics, loading, error, reload };
}
