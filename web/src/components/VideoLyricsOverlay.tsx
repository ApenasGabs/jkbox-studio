import { useMemo } from 'react';
import { findActiveLineIndex, parseLrc } from '../lib/lrc';
import type { TrackLyrics } from '../lib/types';

interface VideoLyricsOverlayProps {
  lyrics: TrackLyrics | null;
  loading: boolean;
  currentTimeSec: number;
  immersive?: boolean;
  controlsVisible?: boolean;
}

/** Subtitle-style translucent synced lyrics overlay anchored to the bottom of the video player. */
export function VideoLyricsOverlay({
  lyrics,
  loading,
  currentTimeSec,
  immersive = false,
  controlsVisible = false,
}: VideoLyricsOverlayProps) {
  const parsedLines = useMemo(() => parseLrc(lyrics?.syncedLrc), [lyrics?.syncedLrc]);
  const hasSynced = parsedLines.length > 0;
  const activeIndex = hasSynced ? findActiveLineIndex(parsedLines, currentTimeSec, lyrics?.offsetMs ?? 0) : -1;
  const anchorClass = immersive
    ? controlsVisible
      ? 'inset-x-4 bottom-32 sm:inset-x-8 sm:bottom-32'
      : 'inset-x-4 bottom-5 sm:inset-x-8 sm:bottom-6'
    : 'inset-x-3 bottom-3 sm:inset-x-6 sm:bottom-5';
  const boxWidthClass = immersive ? 'max-w-[min(86%,920px)]' : 'max-w-[92%]';

  if (loading) {
    return (
      <div className={`pointer-events-none absolute z-10 flex justify-center transition-all duration-300 ${anchorClass}`}>
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
      <div className={`pointer-events-none absolute z-10 flex justify-center transition-all duration-300 ${anchorClass}`}>
        <div
          className={`${boxWidthClass} rounded-2xl border border-white/15 bg-black/75 px-4 py-2 text-center shadow-xl backdrop-blur-md ${
            immersive ? 'sm:px-6 sm:py-3' : ''
          }`}
        >
          {activeLine ? (
            <>
              <p
                className={`font-bold leading-snug text-white drop-shadow [overflow-wrap:anywhere] ${
                  immersive ? 'text-base sm:text-xl lg:text-2xl xl:text-3xl' : 'text-sm sm:text-lg lg:text-xl'
                }`}
              >
                {activeLine.text}
              </p>
              {nextLine && (
                <p
                  className={`mt-0.5 font-medium text-zinc-300/85 [overflow-wrap:anywhere] ${
                    immersive ? 'text-xs sm:text-base lg:text-lg' : 'text-xs sm:text-sm'
                  }`}
                >
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
    <div className={`pointer-events-none absolute z-10 flex justify-center transition-all duration-300 ${anchorClass}`}>
      <div className="rounded-2xl border border-white/15 bg-black/70 px-3.5 py-1.5 text-center text-xs font-medium text-zinc-300 shadow-xl backdrop-blur-md">
        {fallbackText}
      </div>
    </div>
  );
}
