import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { findActiveLineIndex, formatOffsetMs, parseLrc } from '../lib/lrc';
import type { TrackLyrics } from '../lib/types';

interface LyricsViewProps {
  lyrics: TrackLyrics | null;
  loading: boolean;
  error: string | null;
  currentTimeSec: number;
  variant?: 'kiosk' | 'remote';
  onRetry?: () => void;
  onAdjustOffset?: (deltaMs: number) => void;
  onResetOffset?: () => void;
  offsetBusy?: boolean;
  className?: string;
}

const FADE_MASK_STYLE = {
  maskImage: 'linear-gradient(to bottom, transparent 0%, black 12%, black 88%, transparent 100%)',
  WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 12%, black 88%, transparent 100%)',
} as const;

export function LyricsView({
  lyrics,
  loading,
  error,
  currentTimeSec,
  variant = 'kiosk',
  onRetry,
  onAdjustOffset,
  onResetOffset,
  offsetBusy = false,
  className = '',
}: LyricsViewProps) {
  const isKiosk = variant === 'kiosk';
  const containerRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLParagraphElement | null)[]>([]);
  const pauseTimerRef = useRef<number | null>(null);
  const [autoScrollPaused, setAutoScrollPaused] = useState(false);

  const parsedLines = useMemo(() => parseLrc(lyrics?.syncedLrc), [lyrics?.syncedLrc]);
  const hasSynced = parsedLines.length > 0;
  const activeIndex = hasSynced ? findActiveLineIndex(parsedLines, currentTimeSec, lyrics?.offsetMs ?? 0) : -1;
  lineRefs.current.length = parsedLines.length;

  const scrollToActive = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      const container = containerRef.current;
      if (!container) return;
      if (activeIndex < 0) {
        container.scrollTo({ top: 0, behavior });
        return;
      }
      const el = lineRefs.current[activeIndex];
      if (!el) return;
      const targetTop = el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2;
      container.scrollTo({ top: Math.max(0, targetTop), behavior });
    },
    [activeIndex],
  );

  // Reset scroll state when switching tracks.
  useEffect(() => {
    setAutoScrollPaused(false);
    if (pauseTimerRef.current) {
      window.clearTimeout(pauseTimerRef.current);
      pauseTimerRef.current = null;
    }
    containerRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [lyrics?.trackId]);

  useEffect(() => {
    if (!hasSynced || autoScrollPaused) return;
    scrollToActive('smooth');
  }, [hasSynced, autoScrollPaused, activeIndex, scrollToActive]);

  useEffect(() => {
    return () => {
      if (pauseTimerRef.current) window.clearTimeout(pauseTimerRef.current);
    };
  }, []);

  const handleUserScrollIntent = () => {
    setAutoScrollPaused(true);
    if (pauseTimerRef.current) window.clearTimeout(pauseTimerRef.current);
    pauseTimerRef.current = window.setTimeout(() => setAutoScrollPaused(false), 5000);
  };

  const resumeAutoScroll = () => {
    if (pauseTimerRef.current) {
      window.clearTimeout(pauseTimerRef.current);
      pauseTimerRef.current = null;
    }
    setAutoScrollPaused(false);
    scrollToActive('smooth');
  };

  if (loading) {
    return (
      <div className={`glass flex flex-col items-center justify-center gap-3 p-6 text-center ${className}`}>
        <div className="h-7 w-7 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        <p className="text-sm text-zinc-300">Buscando letra…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`glass flex flex-col items-center justify-center gap-3 p-6 text-center ${className}`}>
        <span className="text-3xl">⚠️</span>
        <p className="font-semibold text-red-300">Não foi possível carregar a letra</p>
        <p className="text-xs text-zinc-400">{error}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-xl bg-white/10 px-4 py-2 text-sm font-semibold hover:bg-white/20"
          >
            Tentar novamente
          </button>
        )}
      </div>
    );
  }

  if (!lyrics) return null;

  const plainParagraphs = lyrics.plainLyrics
    ? lyrics.plainLyrics.replace(/\r\n/g, '\n').split('\n')
    : [];

  return (
    <div className={`glass relative flex flex-col overflow-hidden ${className}`}>
      {hasSynced ? (
        <div className="relative min-h-0 flex-1">
          <div
            ref={containerRef}
            onWheel={handleUserScrollIntent}
            onTouchStart={handleUserScrollIntent}
            style={FADE_MASK_STYLE}
            className={`relative h-full overflow-y-auto scroll-smooth ${
              isKiosk ? 'px-5 py-24 sm:px-8 sm:py-32' : 'px-4 py-20'
            }`}
          >
            {activeIndex === -1 && (
              <p
                className={`mb-5 font-semibold tracking-[0.25em] text-accent-2/80 ${
                  isKiosk ? 'text-base sm:text-lg' : 'text-sm'
                }`}
              >
                ♪ •••
              </p>
            )}
            <div className={isKiosk ? 'flex flex-col gap-5 sm:gap-6' : 'flex flex-col gap-3.5'}>
              {parsedLines.map((line, index) => {
                const isActive = index === activeIndex;
                const isPast = activeIndex >= 0 && index < activeIndex;
                return (
                  <p
                    key={`${line.timeSec}-${index}`}
                    ref={(el) => {
                      lineRefs.current[index] = el;
                    }}
                    aria-current={isActive ? 'true' : undefined}
                    className={`transition-all duration-300 ease-out [overflow-wrap:anywhere] ${
                      isKiosk
                        ? isActive
                          ? 'origin-left scale-[1.02] text-2xl font-extrabold leading-snug text-white drop-shadow-[0_0_24px_rgba(168,85,247,0.45)] sm:text-3xl lg:text-4xl'
                          : isPast
                            ? 'text-xl font-semibold leading-snug text-white/30 sm:text-2xl lg:text-3xl'
                            : 'text-xl font-semibold leading-snug text-white/55 sm:text-2xl lg:text-3xl'
                        : isActive
                          ? 'text-lg font-bold leading-snug text-white drop-shadow-[0_0_14px_rgba(168,85,247,0.4)] sm:text-xl'
                          : isPast
                            ? 'text-base font-medium leading-snug text-white/35'
                            : 'text-base font-medium leading-snug text-white/60'
                    }`}
                  >
                    {line.text}
                  </p>
                );
              })}
            </div>
          </div>

          {autoScrollPaused && (
            <button
              type="button"
              onClick={resumeAutoScroll}
              className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-white/15 bg-panel/90 px-3.5 py-1.5 text-xs font-semibold text-white shadow-lg backdrop-blur hover:bg-panel"
            >
              ↻ Acompanhar letra
            </button>
          )}
        </div>
      ) : plainParagraphs.length > 0 ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-2 text-xs text-zinc-400">
            <span>Letra sem sincronização</span>
            <span>Role manualmente</span>
          </div>
          <div className={`min-h-0 flex-1 overflow-y-auto ${isKiosk ? 'space-y-3 px-6 py-5 sm:px-8' : 'space-y-2.5 px-4 py-4'}`}>
            {plainParagraphs.map((line, index) =>
              line.trim() ? (
                <p
                  key={index}
                  className={`[overflow-wrap:anywhere] ${
                    isKiosk ? 'text-lg leading-relaxed text-zinc-200 sm:text-xl lg:text-2xl' : 'text-base leading-relaxed text-zinc-200'
                  }`}
                >
                  {line}
                </p>
              ) : (
                <div key={index} className="h-3" aria-hidden="true" />
              ),
            )}
          </div>
        </div>
      ) : lyrics.instrumental ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <span className={isKiosk ? 'text-5xl' : 'text-4xl'}>🎼</span>
          <p className={isKiosk ? 'text-2xl font-bold' : 'text-lg font-bold'}>Faixa instrumental</p>
          <p className="max-w-sm text-sm text-zinc-400">Aproveite o som — esta música não possui letra.</p>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <span className={isKiosk ? 'text-5xl' : 'text-4xl'}>🎵</span>
          <p className={isKiosk ? 'text-2xl font-bold' : 'text-lg font-bold'}>Letra não disponível</p>
          <p className="max-w-sm text-sm text-zinc-400">
            Não encontramos letra para esta faixa.
            {isKiosk && ' Você pode adicionar um arquivo .lrc com o mesmo nome da faixa em ./data/music.'}
          </p>
        </div>
      )}

      {hasSynced && (isKiosk || lyrics.source !== 'none') && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 bg-black/25 px-3 py-2 text-xs text-zinc-400 sm:px-4">
          <span className="uppercase tracking-wider">
            {lyrics.source === 'local' ? 'Arquivo .lrc' : lyrics.source === 'lrclib' ? 'LRCLIB' : ''}
          </span>
          {onAdjustOffset && (
            <div className="flex items-center gap-1.5">
              <span className="hidden text-zinc-400 sm:inline">Sincronia:</span>
              <button
                type="button"
                disabled={offsetBusy}
                onClick={() => onAdjustOffset(-500)}
                aria-label="Atrasar letra 500ms"
                title="Atrasar letra 500ms"
                className="rounded-lg bg-white/10 px-2 py-1 font-mono text-zinc-200 transition hover:bg-white/20 disabled:opacity-50"
              >
                -500ms
              </button>
              <button
                type="button"
                disabled={offsetBusy || lyrics.offsetMs === 0 || !onResetOffset}
                onClick={onResetOffset}
                title={lyrics.offsetMs !== 0 ? 'Clique para zerar sincronia' : 'Sincronia atual'}
                className={`min-w-14 rounded-lg px-2 py-1 text-center font-mono ${
                  lyrics.offsetMs === 0
                    ? 'text-zinc-400'
                    : 'bg-accent/20 text-accent-2 hover:bg-accent/30'
                }`}
              >
                {formatOffsetMs(lyrics.offsetMs)}
              </button>
              <button
                type="button"
                disabled={offsetBusy}
                onClick={() => onAdjustOffset(500)}
                aria-label="Adiantar letra 500ms"
                title="Adiantar letra 500ms"
                className="rounded-lg bg-white/10 px-2 py-1 font-mono text-zinc-200 transition hover:bg-white/20 disabled:opacity-50"
              >
                +500ms
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
