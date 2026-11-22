import { QRCodeSVG } from 'qrcode.react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Cover } from '../components/Cover';
import { LyricsView } from '../components/LyricsView';
import { QueueList } from '../components/QueueList';
import { SourceBadge } from '../components/SourceBadge';
import { useToast } from '../components/Toast';
import { VideoLyricsOverlay } from '../components/VideoLyricsOverlay';
import { api, getHostPin, setHostPin } from '../lib/api';
import { cssImageUrl, formatTime, isLoopback, remoteUrl } from '../lib/format';
import type { AppConfig, QueueEntry } from '../lib/types';
import { useJukebox } from '../lib/useJukebox';
import { useTrackLyrics } from '../lib/useTrackLyrics';

type StageMode = 'cover' | 'lyrics' | 'video';
type DefaultStageView = 'cover' | 'video' | 'video-lyrics' | 'lyrics';

const STAGE_MODE_KEY = 'jkbox.stageMode';
const VIDEO_OVERLAY_KEY = 'jkbox.videoLyricsOverlay';
const DEFAULT_VIEW_KEY = 'jkbox.defaultStageView';

const STAGE_MODES: { id: StageMode; label: string }[] = [
  { id: 'cover', label: 'Capa' },
  { id: 'lyrics', label: 'Letra' },
  { id: 'video', label: 'Clipe' },
];

const DEFAULT_VIEW_OPTIONS: { id: DefaultStageView; label: string }[] = [
  { id: 'cover', label: 'Capa' },
  { id: 'video', label: 'Clipe' },
  { id: 'video-lyrics', label: 'Clipe + Letra' },
  { id: 'lyrics', label: 'Letra' },
];

const MAX_OFFSET_MS = 300_000;
const CINEMA_IDLE_MS = 5000;
const UP_NEXT_WINDOW_SEC = 15;

function readInitialDefaultView(): DefaultStageView {
  const saved = localStorage.getItem(DEFAULT_VIEW_KEY);
  if (saved === 'cover' || saved === 'video' || saved === 'video-lyrics' || saved === 'lyrics') return saved;
  return localStorage.getItem(STAGE_MODE_KEY) === 'lyrics' ? 'lyrics' : 'cover';
}

function readInitialStageMode(defaultView: DefaultStageView): StageMode {
  const saved = localStorage.getItem(STAGE_MODE_KEY);
  if (saved === 'cover' || saved === 'lyrics' || saved === 'video') return saved;
  return defaultView === 'video-lyrics' ? 'video' : defaultView;
}

function readInitialOverlay(defaultView: DefaultStageView): boolean {
  const saved = localStorage.getItem(VIDEO_OVERLAY_KEY);
  if (saved === 'true' || saved === 'false') return saved === 'true';
  return defaultView === 'video-lyrics';
}

function youtubeEmbedUrl(youtubeId: string, startSec: number, autoplay: boolean): string {
  const params = new URLSearchParams({
    autoplay: autoplay ? '1' : '0',
    mute: '1',
    controls: '0',
    rel: '0',
    modestbranding: '1',
    playsinline: '1',
    enablejsapi: '1',
    start: String(Math.max(0, Math.floor(startSec))),
  });
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(youtubeId)}?${params}`;
}

export function Kiosk() {
  const { state, downloads, lyricsOffset, connected, send } = useJukebox();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState({ current: 0, duration: 0 });
  const [volume, setVolume] = useState(() => Number(localStorage.getItem('jkbox.volume') ?? 1));
  const [defaultView, setDefaultView] = useState<DefaultStageView>(readInitialDefaultView);
  const [stageMode, setStageMode] = useState<StageMode>(() => readInitialStageMode(readInitialDefaultView()));
  const [videoLyricsOverlay, setVideoLyricsOverlay] = useState<boolean>(() =>
    readInitialOverlay(readInitialDefaultView()),
  );
  const [videoFailedQueueId, setVideoFailedQueueId] = useState<number | null>(null);
  const [embedSrc, setEmbedSrc] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [offsetBusy, setOffsetBusy] = useState(false);
  const [cinemaMode, setCinemaMode] = useState(false);
  const [cinemaIdle, setCinemaIdle] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(() =>
    typeof document !== 'undefined' ? Boolean(document.fullscreenElement) : false,
  );
  const [dismissedUpNextId, setDismissedUpNextId] = useState<number | null>(null);
  const kioskRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const embedIframeRef = useRef<HTMLIFrameElement>(null);
  const lastSent = useRef(0);
  const loadedTarget = useRef<{ queueId: number; kind: 'audio' | 'video' } | null>(null);
  const firstLoad = useRef(true);
  /** Position to restore after a reload or video->audio fallback; applied on `loadedmetadata`. */
  const pendingSeek = useRef<number | null>(null);
  const resumePlayRef = useRef(false);
  const pendingOffsetRef = useRef<number | null>(null);
  const toast = useToast();

  const nowPlaying = state.nowPlaying;
  const current = nowPlaying?.item;
  const videoAvailableInCache =
    config?.videoMode === 'cache' && Boolean(current?.track.videoPath) && videoFailedQueueId !== current?.id;
  const videoAvailableInEmbed = config?.videoMode === 'embed' && Boolean(current?.track.youtubeId);
  const hasVideoAvailable = Boolean(current) && (videoAvailableInCache || videoAvailableInEmbed);
  const effectiveStageMode: StageMode =
    stageMode === 'video' && !hasVideoAvailable ? (videoLyricsOverlay ? 'lyrics' : 'cover') : stageMode;
  const activeMediaKind: 'audio' | 'video' = videoAvailableInCache ? 'video' : 'audio';

  const getActiveMedia = useCallback(
    (): HTMLMediaElement | null => (activeMediaKind === 'video' ? videoRef.current : audioRef.current),
    [activeMediaKind],
  );

  const { lyrics, setLyrics, loading: lyricsLoading, error: lyricsError, reload: reloadLyrics } = useTrackLyrics(
    current?.trackId,
    lyricsOffset,
  );

  const refreshConfig = useCallback(() => api.config().then(setConfig).catch(() => {}), []);

  useEffect(() => {
    refreshConfig();
    const params = new URLSearchParams(window.location.search);
    const pin = params.get('pin');
    if (pin) setHostPin(pin);
    const spotify = params.get('spotify');
    if (spotify) {
      toast.show(
        spotify === 'connected' ? 'Spotify conectado! Playlist compartilhada pronta.' : `Spotify: ${params.get('message') ?? 'erro'}`,
        spotify !== 'connected',
      );
      window.history.replaceState(null, '', '/');
    }
  }, [refreshConfig, toast.show]);

  useEffect(() => {
    setVideoFailedQueueId(null);
  }, [current?.id]);

  // Load the current queue item into <video> (when cached MP4 is available & VIDEO_MODE=cache)
  // or <audio>. Switching between Capa / Letra / Clipe keeps the active element untouched so
  // currentTime and play/pause state never reset.
  useEffect(() => {
    const audio = audioRef.current;
    const video = videoRef.current;
    if (!audio) return;

    const clearEl = (el: HTMLMediaElement | null) => {
      if (!el || !el.getAttribute('src')) return;
      el.pause();
      el.removeAttribute('src');
      el.load();
    };

    if (!current) {
      if (loadedTarget.current !== null) {
        clearEl(audio);
        clearEl(video);
        setTime({ current: 0, duration: 0 });
      }
      loadedTarget.current = null;
      return;
    }

    if (!config) return;
    if (activeMediaKind === 'video' && !video) return;

    const prev = loadedTarget.current;
    if (prev && prev.queueId === current.id && prev.kind === activeMediaKind) return;

    // Seamless handoff if switching media element on the same queue item (e.g. video error fallback).
    if (prev && prev.queueId === current.id && prev.kind !== activeMediaKind) {
      const prevEl = prev.kind === 'video' ? video : audio;
      if (prevEl) {
        if (prevEl.currentTime > 0) pendingSeek.current = prevEl.currentTime;
        resumePlayRef.current = !prevEl.paused || unlocked;
      }
    } else {
      pendingSeek.current = firstLoad.current && nowPlaying && nowPlaying.positionSec > 0 ? nowPlaying.positionSec : null;
      resumePlayRef.current = unlocked;
    }

    firstLoad.current = false;
    loadedTarget.current = { queueId: current.id, kind: activeMediaKind };

    const targetEl = activeMediaKind === 'video' ? video! : audio;
    const inactiveEl = activeMediaKind === 'video' ? audio : video;
    clearEl(inactiveEl);

    targetEl.volume = volume;
    targetEl.src = activeMediaKind === 'video' ? api.videoUrl(current.trackId) : api.streamUrl(current.trackId);
    if (unlocked || resumePlayRef.current) {
      resumePlayRef.current = false;
      targetEl.play().catch(() => setPlaying(false));
    }
  }, [current, nowPlaying, config, activeMediaKind, unlocked]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
    if (videoRef.current) videoRef.current.volume = volume;
    localStorage.setItem('jkbox.volume', String(volume));
  }, [volume]);

  useEffect(() => {
    localStorage.setItem(STAGE_MODE_KEY, stageMode);
  }, [stageMode]);

  useEffect(() => {
    localStorage.setItem(VIDEO_OVERLAY_KEY, String(videoLyricsOverlay));
  }, [videoLyricsOverlay]);

  useEffect(() => {
    localStorage.setItem(DEFAULT_VIEW_KEY, defaultView);
  }, [defaultView]);

  useEffect(() => {
    pendingOffsetRef.current = null;
  }, [current?.trackId]);

  // Manage YouTube embed URL only when entering/leaving Clipe mode in embed mode (never on time ticks).
  useEffect(() => {
    if (effectiveStageMode === 'video' && !videoAvailableInCache && videoAvailableInEmbed && current?.track.youtubeId) {
      const startSec = audioRef.current?.currentTime ?? 0;
      const isPlaying = audioRef.current ? !audioRef.current.paused : playing;
      setEmbedSrc(youtubeEmbedUrl(current.track.youtubeId, startSec, isPlaying));
    } else {
      setEmbedSrc(null);
    }
  }, [effectiveStageMode, videoAvailableInCache, videoAvailableInEmbed, current?.id, current?.track.youtubeId]);

  // Keep muted embed iframe play/pause synced with authoritative <audio> playback.
  useEffect(() => {
    if (!embedSrc || !embedIframeRef.current?.contentWindow) return;
    const func = playing ? 'playVideo' : 'pauseVideo';
    embedIframeRef.current.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args: [] }), '*');
  }, [playing, embedSrc]);

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      const media = getActiveMedia();
      if (media && !media.paused) {
        setTime((prev) => ({
          current: media.currentTime,
          duration: Number.isFinite(media.duration) && media.duration > 0 ? media.duration : prev.duration,
        }));
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [playing, getActiveMedia]);

  const reportProgress = (force = false, mediaOverride?: HTMLMediaElement | null) => {
    const media = mediaOverride ?? getActiveMedia();
    if (!media || !current) return;
    const now = Date.now();
    if (!force && now - lastSent.current < 1000) return;
    lastSent.current = now;
    send({ type: 'progress', queueId: current.id, positionSec: media.currentTime, paused: media.paused });
  };

  const unlock = () => {
    setUnlocked(true);
    getActiveMedia()?.play().catch(() => {});
  };

  const togglePlay = () => {
    const media = getActiveMedia();
    if (!media || !current) return;
    if (media.paused) media.play().catch(() => {});
    else media.pause();
  };

  const handleDefaultViewChange = (next: DefaultStageView) => {
    setDefaultView(next);
    setStageMode(next === 'video-lyrics' ? 'video' : next);
    setVideoLyricsOverlay(next === 'video-lyrics');
  };

  const run: RunFn = async (action, ok) => {
    try {
      const result = await action();
      const text = typeof ok === 'function' ? ok(result) : ok;
      if (text) toast.show(text);
    } catch (err) {
      toast.show((err as Error).message, true);
    }
  };

  const remove = (entry: QueueEntry) => run(() => api.remove(entry.id));

  const persistLyricsOffset = async (nextOffset: number) => {
    if (!current || !lyrics) return;
    const clamped = Math.max(-MAX_OFFSET_MS, Math.min(MAX_OFFSET_MS, Math.round(nextOffset)));
    const previous = lyrics.offsetMs;
    pendingOffsetRef.current = clamped;
    setLyrics((prev) => (prev && prev.trackId === current.trackId ? { ...prev, offsetMs: clamped } : prev));
    setOffsetBusy(true);
    try {
      const updated = await api.updateLyricsOffset(current.trackId, clamped);
      if (pendingOffsetRef.current === clamped) pendingOffsetRef.current = null;
      setLyrics((prev) => (prev && prev.trackId === updated.trackId ? updated : prev));
    } catch (err) {
      pendingOffsetRef.current = null;
      setLyrics((prev) => (prev && prev.trackId === current.trackId ? { ...prev, offsetMs: previous } : prev));
      toast.show((err as Error).message, true);
    } finally {
      setOffsetBusy(false);
    }
  };

  const adjustLyricsOffset = (deltaMs: number) => {
    if (!lyrics) return;
    const base = pendingOffsetRef.current ?? lyrics.offsetMs;
    void persistLyricsOffset(base + deltaMs);
  };

  const resetLyricsOffset = () => {
    if (!lyrics || lyrics.offsetMs === 0) return;
    void persistLyricsOffset(0);
  };

  const url = remoteUrl(config?.publicUrl ?? null);
  const effectiveDuration = time.duration || current?.track.durationSec || 0;
  const progressPct = effectiveDuration > 0 ? Math.min(100, (time.current / effectiveDuration) * 100) : 0;
  const remainingSec = effectiveDuration > 0 ? Math.max(0, effectiveDuration - time.current) : Number.POSITIVE_INFINITY;
  const nextUp = state.queue.find((entry) => entry.track.status === 'ready') ?? state.queue[0] ?? null;
  const showUpNextBanner = Boolean(
    current && nextUp && effectiveDuration > 0 && remainingSec <= UP_NEXT_WINDOW_SEC && dismissedUpNextId !== current.id,
  );
  const controlsHidden = cinemaMode && cinemaIdle && !settingsOpen && unlocked;
  const backdrop = cssImageUrl(current?.track.thumbnail);

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => {
    if (!cinemaMode || settingsOpen || !unlocked) {
      setCinemaIdle(false);
      return;
    }
    let timer = window.setTimeout(() => setCinemaIdle(true), CINEMA_IDLE_MS);
    const resetIdle = () => {
      setCinemaIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setCinemaIdle(true), CINEMA_IDLE_MS);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.fullscreenElement) {
        setCinemaMode(false);
        return;
      }
      resetIdle();
    };
    window.addEventListener('mousemove', resetIdle);
    window.addEventListener('mousedown', resetIdle);
    window.addEventListener('touchstart', resetIdle, { passive: true });
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('mousemove', resetIdle);
      window.removeEventListener('mousedown', resetIdle);
      window.removeEventListener('touchstart', resetIdle);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [cinemaMode, settingsOpen, unlocked]);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        const target = kioskRef.current ?? document.documentElement;
        if (!target.requestFullscreen) {
          toast.show('Tela cheia não suportada neste navegador', true);
          return;
        }
        await target.requestFullscreen();
      }
    } catch {
      toast.show('Não foi possível alternar a tela cheia', true);
    }
  }, [toast.show]);

  const handleMediaPlay = (kind: 'audio' | 'video', el: HTMLMediaElement) => {
    if (activeMediaKind !== kind) return;
    setPlaying(true);
    reportProgress(true, el);
  };

  const handleMediaPause = (kind: 'audio' | 'video', el: HTMLMediaElement) => {
    if (activeMediaKind !== kind) return;
    setPlaying(false);
    reportProgress(true, el);
  };

  const handleLoadedMetadata = (kind: 'audio' | 'video', el: HTMLMediaElement) => {
    if (activeMediaKind !== kind) return;
    const seek = pendingSeek.current;
    pendingSeek.current = null;
    if (seek !== null && Number.isFinite(el.duration) && seek < el.duration) {
      el.currentTime = seek;
    }
  };

  const handleTimeUpdate = (kind: 'audio' | 'video', el: HTMLMediaElement) => {
    if (activeMediaKind !== kind) return;
    setTime({ current: el.currentTime, duration: el.duration || current?.track.durationSec || 0 });
    reportProgress(false, el);
  };

  const handleMediaEnded = (kind: 'audio' | 'video') => {
    if (activeMediaKind !== kind || !current) return;
    api.ended(current.id).catch(() => {});
  };

  return (
    // Mobile/tablet: natural page scroll so the QR code and queue stay reachable.
    // Desktop (lg+): fixed full-height split layout.
    <div
      ref={kioskRef}
      className={`relative flex min-h-full flex-col overflow-x-hidden bg-ink lg:h-full lg:flex-row lg:overflow-hidden ${
        controlsHidden ? 'cursor-none' : ''
      }`}
    >
      {/* Blurred backdrop from the album art */}
      {backdrop && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute inset-0 scale-110 bg-cover bg-center opacity-25 blur-3xl" style={{ backgroundImage: backdrop }} />
        </div>
      )}

      <audio
        ref={audioRef}
        preload="auto"
        onPlay={(e) => handleMediaPlay('audio', e.currentTarget)}
        onPause={(e) => handleMediaPause('audio', e.currentTarget)}
        onLoadedMetadata={(e) => handleLoadedMetadata('audio', e.currentTarget)}
        onTimeUpdate={(e) => handleTimeUpdate('audio', e.currentTarget)}
        onEnded={() => handleMediaEnded('audio')}
        onError={() => {
          if (activeMediaKind !== 'audio' || !current || !audioRef.current?.src) return;
          toast.show(`Não foi possível tocar "${current.track.title}". Pulando…`, true);
          const id = current.id;
          window.setTimeout(() => api.ended(id).catch(() => {}), 2000);
        }}
      />

      {/* Now playing */}
      <main
        className={`relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-5 pt-4 sm:px-8 lg:gap-5 lg:p-8 lg:pt-20 ${
          cinemaMode ? 'pb-24 sm:pb-8' : 'pb-8'
        }`}
      >
        {/* In the flow on mobile/tablet (never overlaps the cover); pinned to the corners on desktop. */}
        <div
          className={`flex w-full flex-wrap items-center justify-between gap-2 transition-opacity duration-300 lg:absolute lg:inset-x-8 lg:top-6 lg:w-auto ${
            controlsHidden ? 'pointer-events-none opacity-0' : 'opacity-100'
          }`}
        >
          <header className="flex items-center gap-3">
            <span className="text-2xl font-black tracking-tight">
              jkbox<span className="text-accent">studio</span>
            </span>
            <span className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-500'}`} title={connected ? 'online' : 'reconectando'} />
          </header>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-pressed={cinemaMode}
              onClick={() => setCinemaMode((v) => !v)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition sm:text-sm ${
                cinemaMode ? 'bg-accent text-white shadow' : 'bg-white/10 hover:bg-white/20'
              }`}
              title={cinemaMode ? 'Sair do Modo Cinema (Esc)' : 'Ocultar fila e controles após inatividade'}
            >
              {cinemaMode ? '🎬 Cinema ON' : '🎬 Cinema'}
            </button>
            <button
              type="button"
              aria-pressed={isFullscreen}
              onClick={() => void toggleFullscreen()}
              className="rounded-full bg-white/10 px-3 py-1 text-xs font-medium transition hover:bg-white/20 sm:text-sm"
              title={isFullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
            >
              {isFullscreen ? '🗗 Sair' : '⛶ Tela cheia'}
            </button>
            <button
              type="button"
              onClick={() => setSettingsOpen((v) => !v)}
              className="rounded-full bg-white/10 px-3 py-1 text-xs font-medium transition hover:bg-white/20 sm:text-sm"
            >
              ⚙︎ Host
            </button>
          </div>
        </div>

        {showUpNextBanner && nextUp && current && (
          <div
            role="status"
            aria-live="polite"
            className="glass absolute inset-x-3 top-16 z-20 flex items-center gap-3 border-accent/40 bg-panel/90 p-3 shadow-2xl shadow-black/60 backdrop-blur-md sm:inset-x-auto sm:right-6 sm:top-20 sm:w-80"
          >
            <Cover src={nextUp.track.thumbnail} alt={nextUp.track.title} className="h-12 w-12 shrink-0 rounded-xl" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-bold uppercase tracking-wider text-accent-2">
                  A seguir · {Math.max(1, Math.ceil(remainingSec))}s
                </span>
                <button
                  type="button"
                  onClick={() => setDismissedUpNextId(current.id)}
                  aria-label="Dispensar aviso A seguir"
                  className="rounded px-1 text-xs text-zinc-400 hover:bg-white/10 hover:text-white"
                >
                  ✕
                </button>
              </div>
              <p className="truncate text-sm font-semibold text-white">{nextUp.track.title}</p>
              <p className="truncate text-xs text-zinc-300">
                {nextUp.track.artist || '—'} · pedido por {nextUp.requesterName}
              </p>
            </div>
          </div>
        )}

        {current ? (
          <>
            <div
              className={`flex shrink-0 flex-wrap items-center justify-center gap-2 transition-opacity duration-300 ${
                controlsHidden ? 'pointer-events-none opacity-0' : 'opacity-100'
              }`}
            >
              <div
                role="tablist"
                aria-label="Modo de visualização do palco"
                className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 p-1 backdrop-blur"
              >
                {STAGE_MODES.map((mode) => {
                  const disabled = mode.id === 'video' && !hasVideoAvailable;
                  return (
                    <button
                      key={mode.id}
                      type="button"
                      role="tab"
                      disabled={disabled}
                      aria-selected={effectiveStageMode === mode.id}
                      title={
                        disabled
                          ? config?.videoMode === 'off'
                            ? 'Modo videoclipe desativado (VIDEO_MODE=off)'
                            : 'Videoclipe indisponível para esta faixa'
                          : undefined
                      }
                      onClick={() => !disabled && setStageMode(mode.id)}
                      className={`rounded-full px-4 py-1 text-xs font-semibold transition sm:text-sm ${
                        effectiveStageMode === mode.id
                          ? 'bg-white text-zinc-900 shadow'
                          : disabled
                            ? 'cursor-not-allowed text-zinc-500'
                            : 'text-zinc-300 hover:text-white'
                      }`}
                    >
                      {mode.label}
                    </button>
                  );
                })}
              </div>

              {effectiveStageMode === 'video' && (
                <button
                  type="button"
                  aria-pressed={videoLyricsOverlay}
                  onClick={() => setVideoLyricsOverlay((v) => !v)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition sm:text-sm ${
                    videoLyricsOverlay
                      ? 'border-accent/60 bg-accent/25 text-white shadow'
                      : 'border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  🎤 Legenda {videoLyricsOverlay ? 'ON' : 'OFF'}
                </button>
              )}
            </div>

            {effectiveStageMode === 'cover' ? (
              <>
                <Cover
                  src={current.track.thumbnail}
                  alt={current.track.title}
                  className={`aspect-square rounded-3xl shadow-2xl shadow-black/60 ${
                    cinemaMode ? 'w-[min(56vh,84vw)] lg:w-[min(62vh,84vw)]' : 'w-[min(48vh,78vw)] lg:w-[min(52vh,80vw)]'
                  }`}
                />
                <div className="max-w-3xl text-center">
                  <h1 className="text-3xl font-bold leading-tight [overflow-wrap:anywhere] sm:text-4xl lg:text-5xl">{current.track.title}</h1>
                  <p className="mt-2 text-xl text-zinc-300">{current.track.artist}</p>
                  <div className="mt-3 flex items-center justify-center gap-2 text-sm text-zinc-400">
                    <SourceBadge source={current.track.source} />
                    <span>pedido por {current.requesterName}</span>
                  </div>
                </div>
              </>
            ) : effectiveStageMode === 'lyrics' ? (
              <>
                <div className="flex w-full max-w-3xl shrink-0 items-center gap-3 px-1">
                  <Cover src={current.track.thumbnail} alt={current.track.title} className="h-12 w-12 shrink-0 rounded-xl sm:h-14 sm:w-14" />
                  <div className="min-w-0 flex-1">
                    <h1 className="truncate text-lg font-bold leading-tight sm:text-2xl">{current.track.title}</h1>
                    <p className="truncate text-sm text-zinc-300">{current.track.artist}</p>
                  </div>
                  <div className="hidden shrink-0 items-center gap-2 text-xs text-zinc-400 sm:flex">
                    <SourceBadge source={current.track.source} />
                    <span>pedido por {current.requesterName}</span>
                  </div>
                </div>
                <LyricsView
                  variant="kiosk"
                  lyrics={lyrics}
                  loading={lyricsLoading}
                  error={lyricsError}
                  currentTimeSec={time.current}
                  onRetry={reloadLyrics}
                  onAdjustOffset={adjustLyricsOffset}
                  onResetOffset={resetLyricsOffset}
                  offsetBusy={offsetBusy}
                  className="h-[52vh] min-h-[280px] max-h-[500px] w-full max-w-3xl lg:h-auto lg:max-h-none lg:min-h-0 lg:flex-1"
                />
              </>
            ) : (
              <div className="flex w-full max-w-4xl shrink-0 items-center gap-3 px-1">
                <Cover src={current.track.thumbnail} alt={current.track.title} className="h-12 w-12 shrink-0 rounded-xl sm:h-14 sm:w-14" />
                <div className="min-w-0 flex-1">
                  <h1 className="truncate text-lg font-bold leading-tight sm:text-2xl">{current.track.title}</h1>
                  <p className="truncate text-sm text-zinc-300">{current.track.artist}</p>
                </div>
                <div className="hidden shrink-0 items-center gap-2 text-xs text-zinc-400 sm:flex">
                  <SourceBadge source={current.track.source} />
                  <span>pedido por {current.requesterName}</span>
                </div>
              </div>
            )}

            {/* Persistent <video> stage wrapper: stays mounted across Capa/Letra/Clipe toggles so playback never resets */}
            <div
              className={
                effectiveStageMode === 'video'
                  ? `relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-3xl border border-white/10 bg-black shadow-2xl shadow-black/60 ${
                      cinemaMode ? 'max-h-[62vh] max-w-6xl lg:max-h-[68vh]' : 'max-h-[48vh] max-w-4xl lg:max-h-[52vh]'
                    }`
                  : 'pointer-events-none fixed left-0 top-0 h-px w-px overflow-hidden opacity-0'
              }
              aria-hidden={effectiveStageMode !== 'video'}
            >
              <video
                ref={videoRef}
                playsInline
                preload="auto"
                className={videoAvailableInCache ? 'h-full w-full object-contain' : 'hidden'}
                onPlay={(e) => handleMediaPlay('video', e.currentTarget)}
                onPause={(e) => handleMediaPause('video', e.currentTarget)}
                onLoadedMetadata={(e) => handleLoadedMetadata('video', e.currentTarget)}
                onTimeUpdate={(e) => handleTimeUpdate('video', e.currentTarget)}
                onEnded={() => handleMediaEnded('video')}
                onError={() => {
                  if (activeMediaKind !== 'video' || !current || !videoRef.current?.src) return;
                  setVideoFailedQueueId(current.id);
                  toast.show('Videoclipe indisponível — reproduzindo áudio.', true);
                }}
              />
              {effectiveStageMode === 'video' && !videoAvailableInCache && embedSrc && (
                <iframe
                  ref={embedIframeRef}
                  title={`Videoclipe de ${current.track.title}`}
                  src={embedSrc}
                  allow="autoplay; encrypted-media; picture-in-picture"
                  className="h-full w-full border-0"
                />
              )}
              {effectiveStageMode === 'video' && videoLyricsOverlay && (
                <VideoLyricsOverlay lyrics={lyrics} loading={lyricsLoading} currentTimeSec={time.current} />
              )}
            </div>

            <div
              className={`w-full max-w-2xl shrink-0 transition-opacity duration-300 ${
                controlsHidden ? 'pointer-events-none opacity-0' : 'opacity-100'
              }`}
            >
              <div className="h-2 overflow-hidden rounded-full bg-white/10">
                <div className="h-full bg-gradient-to-r from-accent to-accent-2 transition-[width] duration-300" style={{ width: `${progressPct}%` }} />
              </div>
              <div className="mt-1 flex justify-between text-xs text-zinc-400">
                <span>{formatTime(time.current)}</span>
                <span>{formatTime(time.duration || current.track.durationSec)}</span>
              </div>
            </div>
            <div
              className={`flex shrink-0 items-center gap-4 transition-opacity duration-300 ${
                controlsHidden ? 'pointer-events-none opacity-0' : 'opacity-100'
              }`}
            >
              <button onClick={togglePlay} className="h-14 w-14 rounded-full bg-white text-2xl text-zinc-900 hover:scale-105" aria-label={playing ? 'Pausar' : 'Tocar'}>
                {playing ? '❚❚' : '▶'}
              </button>
              <button onClick={() => run(api.skip)} className="h-12 w-12 rounded-full bg-white/10 text-xl hover:bg-white/20" aria-label="Pular">
                ⏭
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={volume}
                onChange={(e) => setVolume(Number(e.target.value))}
                className="w-32 accent-accent"
                aria-label="Volume"
              />
            </div>
          </>
        ) : (
          <div className="text-center">
            <p className="text-6xl">🎶</p>
            <h1 className="mt-4 text-4xl font-bold">Nada tocando ainda</h1>
            <p className="mt-2 text-lg text-zinc-400">
              {state.queue.length > 0 ? 'Baixando a próxima música…' : 'Escaneie o QR Code e peça a primeira música!'}
            </p>
          </div>
        )}
      </main>

      {/* Sidebar: QR + queue (hidden in Modo Cinema, replaced by discrete corner mini QR) */}
      {!cinemaMode ? (
        <aside className="relative z-10 flex w-full flex-col gap-4 border-t border-white/10 bg-black/30 p-5 sm:p-6 lg:w-[420px] lg:border-l lg:border-t-0">
          <div className="glass flex items-center gap-4 p-4">
            <div className="rounded-xl bg-white p-2">
              <QRCodeSVG value={url} size={112} />
            </div>
            <div className="min-w-0">
              <p className="font-semibold">Peça sua música 📱</p>
              <p className="text-sm text-accent-2 [overflow-wrap:anywhere]">{url}</p>
              {isLoopback(url) && (
                <p className="mt-1 text-xs text-amber-300">Defina PUBLIC_URL com o IP da rede para os celulares acessarem.</p>
              )}
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-zinc-400">Próximas ({state.queue.length})</h2>
            <div className="pr-1 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
              <QueueList
                queue={state.queue}
                downloads={downloads}
                onRemove={remove}
                onRetry={(entry) => run(() => api.retry(entry.trackId), 'Tentando baixar novamente')}
                compact
              />
            </div>
          </div>
        </aside>
      ) : (
        <div
          aria-label="QR Code para pedir música"
          className="glass fixed bottom-3 right-3 z-20 flex items-center gap-2.5 border-white/15 bg-black/60 p-2 opacity-80 shadow-xl backdrop-blur-md transition-opacity hover:opacity-100 sm:bottom-5 sm:right-5 sm:p-2.5"
        >
          <div className="rounded-lg bg-white p-1">
            <QRCodeSVG value={url} size={56} />
          </div>
          <div className="hidden max-w-[140px] pr-1 sm:block">
            <p className="text-xs font-semibold text-white">Peça sua música</p>
            <p className="truncate text-[11px] text-accent-2">{url}</p>
          </div>
        </div>
      )}

      {settingsOpen && (
        <HostPanel
          config={config}
          defaultView={defaultView}
          onDefaultViewChange={handleDefaultViewChange}
          onClose={() => setSettingsOpen(false)}
          onChanged={refreshConfig}
          run={run}
        />
      )}

      {!unlocked && (
        <button
          onClick={unlock}
          className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-ink/90 text-center backdrop-blur"
        >
          <span className="text-7xl">🔊</span>
          <span className="text-3xl font-bold">Toque para iniciar a Jukebox</span>
          <span className="text-zinc-400">Os navegadores exigem uma interação antes de reproduzir áudio.</span>
        </button>
      )}
      {toast.node}
    </div>
  );
}

type RunFn = <T>(action: () => Promise<T>, ok?: string | ((result: T) => string)) => Promise<void>;

interface HostPanelProps {
  config: AppConfig | null;
  defaultView: DefaultStageView;
  onDefaultViewChange: (view: DefaultStageView) => void;
  onClose: () => void;
  onChanged: () => void;
  run: RunFn;
}

function HostPanel({ config, defaultView, onDefaultViewChange, onClose, onChanged, run }: HostPanelProps) {
  const [pin, setPin] = useState(getHostPin());
  const [playlist, setPlaylist] = useState('');
  const spotify = config?.spotify;

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/50" onClick={onClose}>
      <div className="flex h-full w-full max-w-md flex-col gap-5 overflow-y-auto bg-panel p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold">Controles do host</h2>
          <button onClick={onClose} className="rounded-lg px-2 py-1 hover:bg-white/10">✕</button>
        </div>

        {config?.hostPinRequired && (
          <section className="glass flex flex-col gap-2 p-4">
            <h3 className="font-semibold">PIN do host</h3>
            <div className="flex gap-2">
              <input
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                type="password"
                inputMode="numeric"
                className="flex-1 rounded-lg bg-white/10 px-3 py-2 outline-none focus:ring-2 focus:ring-accent"
                placeholder="PIN"
              />
              <button
                onClick={() =>
                  run(async () => {
                    setHostPin(pin);
                    const { ok } = await api.verifyPin();
                    if (!ok) throw new Error('PIN incorreto');
                  }, 'PIN salvo')
                }
                className="rounded-lg bg-accent px-3 py-2 font-semibold"
              >
                Salvar
              </button>
            </div>
          </section>
        )}

        <section className="glass flex flex-col gap-3 p-4">
          <h3 className="font-semibold">Visualização padrão do palco</h3>
          <div className="grid grid-cols-2 gap-2">
            {DEFAULT_VIEW_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={defaultView === option.id}
                onClick={() => onDefaultViewChange(option.id)}
                className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${
                  defaultView === option.id ? 'bg-accent text-white' : 'bg-white/10 text-zinc-200 hover:bg-white/20'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          {config?.videoMode === 'off' && (
            <p className="text-xs text-zinc-400">
              <code>VIDEO_MODE=off</code> no servidor — opções de Clipe usam fallback automático para Capa/Letra.
            </p>
          )}
        </section>

        <section className="glass flex items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <h3 className="font-semibold">Auto-DJ</h3>
            <p className="text-xs text-zinc-400">
              Quando a fila esvaziar, toca automaticamente uma faixa aleatória do acervo em cache sem repetir as últimas tocadas.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-label="Ativar Auto-DJ"
            aria-checked={Boolean(config?.autoDjEnabled)}
            disabled={!config}
            onClick={() => {
              if (!config) return;
              const next = !config.autoDjEnabled;
              void run(
                () => api.updateHostSettings({ autoDjEnabled: next }),
                next ? 'Auto-DJ ativado' : 'Auto-DJ desativado',
              ).then(onChanged);
            }}
            className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition ${
              config?.autoDjEnabled ? 'bg-accent' : 'bg-white/20'
            } disabled:opacity-50`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${
                config?.autoDjEnabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </section>

        <section className="glass flex flex-col gap-3 p-4">
          <h3 className="font-semibold">Spotify</h3>
          {!spotify?.configured && (
            <p className="text-sm text-zinc-400">
              Desativado. Preencha <code>SPOTIFY_CLIENT_ID</code> e <code>SPOTIFY_CLIENT_SECRET</code> no <code>.env</code> para habilitar busca e
              playlist compartilhada. YouTube e Acervo Local continuam funcionando normalmente.
            </p>
          )}
          {spotify?.configured && !spotify.connected && (
            <>
              <p className="text-sm text-zinc-400">Busca no catálogo ativa. Conecte uma conta para criar a playlist compartilhada.</p>
              <a href={api.spotifyAuthUrl()} className="rounded-lg bg-green-500 px-3 py-2 text-center font-semibold text-black">
                Conectar Spotify
              </a>
              <p className="break-all text-xs text-zinc-500">Redirect URI: {spotify.redirectUri}</p>
            </>
          )}
          {spotify?.connected && (
            <>
              {spotify.playlistUrl && (
                <a href={spotify.playlistUrl} target="_blank" rel="noreferrer" className="text-sm text-green-300 underline">
                  Abrir playlist compartilhada ↗
                </a>
              )}
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!playlist.trim()) return;
                  run(() => api.spotifyLinkPlaylist(playlist.trim()), 'Playlist vinculada').then(() => {
                    setPlaylist('');
                    onChanged();
                  });
                }}
              >
                <input
                  value={playlist}
                  onChange={(e) => setPlaylist(e.target.value)}
                  className="min-w-0 flex-1 rounded-lg bg-white/10 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-accent"
                  placeholder="Link de uma playlist existente"
                  aria-label="Link ou ID de uma playlist existente do Spotify"
                />
                <button type="submit" className="rounded-lg bg-white/10 px-3 py-2 text-sm font-semibold hover:bg-white/20">
                  Vincular
                </button>
              </form>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => run(api.spotifySync, 'Fila sincronizada com o Spotify')} className="rounded-lg bg-white/10 px-3 py-2 text-sm hover:bg-white/20">
                  Sincronizar fila
                </button>
                <button
                  onClick={() =>
                    run(api.spotifyImport, ({ imported }) =>
                      imported ? `${imported} faixa(s) importada(s) para a fila` : 'Nenhuma faixa nova na playlist',
                    )
                  }
                  className="rounded-lg bg-white/10 px-3 py-2 text-sm hover:bg-white/20"
                >
                  Importar da playlist
                </button>
              </div>
              <button
                onClick={() => run(api.spotifyDisconnect, 'Spotify desconectado').then(onChanged)}
                className="text-left text-xs text-zinc-400 underline"
              >
                Desconectar
              </button>
            </>
          )}
        </section>

        <section className="glass flex flex-col gap-2 p-4">
          <h3 className="font-semibold">Acervo local</h3>
          <p className="text-sm text-zinc-400">
            Coloque arquivos de áudio em <code>./data/music</code> (formato sugerido: <code>Artista - Título.mp3</code>) e reescaneie.
          </p>
          <button
            onClick={() =>
              run(api.rescanLibrary, ({ added }) => (added ? `${added} arquivo(s) adicionados ao acervo` : 'Nenhum arquivo novo encontrado'))
            }
            className="rounded-lg bg-white/10 px-3 py-2 text-sm hover:bg-white/20"
          >
            Reescanear acervo
          </button>
        </section>

        <a href="/remote" target="_blank" rel="noreferrer" className="text-sm text-accent-2 underline">
          Abrir modo convidado nesta tela ↗
        </a>
      </div>
    </div>
  );
}
