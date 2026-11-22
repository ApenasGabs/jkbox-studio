import { useMemo } from 'react';
import { findActiveLineIndex, parseLrc } from '../lib/lrc';
import type { TrackLyrics } from '../lib/types';

interface VideoLyricsOverlayProps {
  lyrics: TrackLyrics | null;
  loading: boolean;
  currentTimeSec: number;
}

/** Subtitle-style translucent synced lyrics overlay anchored to the bottom of the video player. */
export function VideoLyricsOverlay({ lyrics, loading, currentTimeSec }: VideoLyricsOverlayProps) {
  const parsedLines = useMemo(() => parseLrc(lyrics?.syncedLrc), [lyrics?.syncedLrc]);
  const hasSynced = parsedLines.length > 0;
  const activeIndex = hasSynced ? findActiveLineIndex(parsedLines, currentTimeSec, lyrics?.offsetMs ?? 0) : -1;

  if (loading) {
    return (
      <div className="pointer-events-none absolute inset-x-3 bottom-3 z-10 flex justify-center sm:inset-x-6 sm:bottom-5">
        <div className="rounded-2xl border border-white/15 bg-black/75 px-4 py-1.5 text-center text-xs text-zinc-300 shadow-xl backdrop-blur-md">
          Buscando letra…
        </div>
      </div>
    );
  }

  if (!lyrics) return null;

  if (hasSynced) {
    const activeLine = activeIndex >= 0 ? parsedLines[activeIndex] : null;
    const nextLine = activeIndex + 1 < parsedLines.length ? parsedLines[activeIndex + 1] : null;

    return (
      <div className="pointer-events-none absolute inset-x-3 bottom-3 z-10 flex justify-center sm:inset-x-6 sm:bottom-5">
        <div className="max-w-[92%] rounded-2xl border border-white/15 bg-black/75 px-4 py-2 text-center shadow-xl backdrop-blur-md">
          {activeLine ? (
            <>
              <p className="text-sm font-bold leading-snug text-white drop-shadow [overflow-wrap:anywhere] sm:text-lg lg:text-xl">
                {activeLine.text}
              </p>
              {nextLine && (
                <p className="mt-0.5 text-xs font-medium text-zinc-300/80 [overflow-wrap:anywhere] sm:text-sm">
                  {nextLine.text}
                </p>
              )}
            </>
          ) : (
            <p className="text-sm font-semibold tracking-[0.2em] text-accent-2">♪ •••</p>
          )}
        </div>
      </div>
    );
  }

  const fallbackText = lyrics.instrumental
    ? '🎼 Faixa instrumental'
    : lyrics.plainLyrics
      ? 'Letra sem sincronização (use a aba Letra)'
      : 'Letra indisponível';

  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-3 z-10 flex justify-center sm:inset-x-6 sm:bottom-5">
      <div className="rounded-2xl border border-white/15 bg-black/70 px-3.5 py-1.5 text-center text-xs font-medium text-zinc-300 shadow-xl backdrop-blur-md">
        {fallbackText}
      </div>
    </div>
  );
}
