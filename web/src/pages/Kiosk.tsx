import { QRCodeSVG } from 'qrcode.react';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { CatalogBrowser } from '../components/CatalogBrowser';
import { Cover } from '../components/Cover';
import { LyricsView } from '../components/LyricsView';
import { QueueList } from '../components/QueueList';
import { SourceBadge } from '../components/SourceBadge';
import { SpotifyConnectSelector } from '../components/SpotifyConnectSelector';
import { useToast } from '../components/Toast';
import { TrackMetadataModal } from '../components/TrackMetadataModal';
import { VideoLyricsOverlay } from '../components/VideoLyricsOverlay';
import { api, getHostPin, setHostPin } from '../lib/api';
import {
  type CatalogRoute,
  type CatalogTab,
  DEFAULT_CATEGORY_SUGGESTIONS,
  type EditableTrack,
  editableFromTrack,
  mergeCategorySuggestions,
} from '../lib/catalog';
import { cssImageUrl, formatTime, isLoopback, remoteUrl } from '../lib/format';
import { activateFocusedElement, findNextSpatialCandidate, getFocusableElements } from '../lib/spatialNav';
import { formatSpotifyOutputBadge } from '../lib/spotifyConnect';
import type {
  AppConfig,
  AutoDjMode,
  CatalogCategory,
  KioskCommand,
  PlaybackOutput,
  QueueEntry,
  SearchResult,
  Track,
} from '../lib/types';
import { useInterpolatedTime } from '../lib/useInterpolatedTime';
import { useJukebox } from '../lib/useJukebox';
import { useKioskInput } from '../lib/useKioskInput';
import { useSpotifyVolumeControl } from '../lib/useSpotifyVolume';
import { useTrackLyrics } from '../lib/useTrackLyrics';

type StageMode = 'cover' | 'lyrics' | 'video';
type DefaultStageView = 'cover' | 'video' | 'video-lyrics' | 'lyrics';

const STAGE_MODE_KEY = 'jkbox.stageMode';
const VIDEO_OVERLAY_KEY = 'jkbox.videoLyricsOverlay';
const DEFAULT_VIEW_KEY = 'jkbox.defaultStageView';
const REACTIONS_ENABLED_KEY = 'jkbox.reactionsEnabled';

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

function readInitialReactionsEnabled(): boolean {
  return localStorage.getItem(REACTIONS_ENABLED_KEY) !== 'false';
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
  const { state, playbackOutput, position, downloads, lyricsOffset, reactions, notice, connected, send, subscribeInput } = useJukebox();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState({ current: 0, duration: 0 });
  const [volume, setVolume] = useState(() => Number(localStorage.getItem('jkbox.volume') ?? 1));
  const [spotifyVolume, setSpotifyVolume] = useState(80);
  const [defaultView, setDefaultView] = useState<DefaultStageView>(readInitialDefaultView);
  const [stageMode, setStageMode] = useState<StageMode>(() => readInitialStageMode(readInitialDefaultView()));
  const [videoLyricsOverlay, setVideoLyricsOverlay] = useState<boolean>(() =>
    readInitialOverlay(readInitialDefaultView()),
  );
  const [videoFailedQueueId, setVideoFailedQueueId] = useState<number | null>(null);
  const [embedSrc, setEmbedSrc] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogTab, setCatalogTab] = useState<CatalogTab>('categories');
  const [catalogHistory, setCatalogHistory] = useState<CatalogRoute[]>([{ kind: 'root' }]);
  const [catalogFilter, setCatalogFilter] = useState('');
  const [catalogReloadKey, setCatalogReloadKey] = useState(0);
  const [categorySuggestions, setCategorySuggestions] = useState<string[]>([...DEFAULT_CATEGORY_SUGGESTIONS]);
  const [editingTrack, setEditingTrack] = useState<EditableTrack | null>(null);
  const [addingKey, setAddingKey] = useState<string | null>(null);
  const [offsetBusy, setOffsetBusy] = useState(false);
  const [cinemaMode, setCinemaMode] = useState(false);
  const [cinemaIdle, setCinemaIdle] = useState(false);
  const [reactionsEnabled, setReactionsEnabled] = useState<boolean>(readInitialReactionsEnabled);
  const [isFullscreen, setIsFullscreen] = useState(() =>
    typeof document !== 'undefined' ? Boolean(document.fullscreenElement) : false,
  );
  const [dismissedUpNextId, setDismissedUpNextId] = useState<number | null>(null);
  const kioskRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const hostDialogRef = useRef<HTMLDivElement>(null);
  const catalogDialogRef = useRef<HTMLDivElement>(null);
  const unlockBtnRef = useRef<HTMLButtonElement>(null);
  const focusedElRef = useRef<HTMLElement | null>(null);
  const dpadActiveRef = useRef(false);
  const wakeCinemaRef = useRef<(() => void) | null>(null);
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
  const latestEmbedStartSecRef = useRef(0);
  const latestEmbedPlayingRef = useRef(false);
  const toast = useToast();

  const isSpotifyOutput = playbackOutput.type === 'spotify';
  const spotifyBadge = formatSpotifyOutputBadge(playbackOutput);
  const nowPlaying = state.nowPlaying;
  const current = nowPlaying?.item;
  const spotifyTimeSec = useInterpolatedTime(
    position,
    Boolean(current) && isSpotifyOutput,
    connected,
    current?.track.durationSec,
  );
  const effectivePlaying = isSpotifyOutput ? !position.paused : playing;
  const effectiveCurrentSec = isSpotifyOutput ? spotifyTimeSec : time.current;
  latestEmbedStartSecRef.current = isSpotifyOutput ? spotifyTimeSec : (audioRef.current?.currentTime ?? 0);
  latestEmbedPlayingRef.current = isSpotifyOutput ? !position.paused : (audioRef.current ? !audioRef.current.paused : playing);
  const videoAvailableInCache =
    !isSpotifyOutput && config?.videoMode === 'cache' && Boolean(current?.track.videoPath) && videoFailedQueueId !== current?.id;
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
    if (notice) toast.show(notice.message, notice.error);
  }, [notice, toast.show]);

  useEffect(() => {
    setVideoFailedQueueId(null);
  }, [current?.id]);

  // Load the current queue item into <video> (when cached MP4 is available & VIDEO_MODE=cache)
  // or <audio>. Switching between Capa / Letra / Clipe keeps the active element untouched so
  // currentTime and play/pause state never reset. When Spotify Connect is active, keep local
  // media paused and muted.
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

    if (isSpotifyOutput) {
      audio.muted = true;
      if (video) video.muted = true;
      clearEl(audio);
      clearEl(video);
      loadedTarget.current = null;
      setPlaying(false);
      return;
    }

    audio.muted = false;
    if (video) video.muted = false;

    if (!current) {
      if (loadedTarget.current !== null) {
        clearEl(audio);
        clearEl(video);
        setTime({ current: 0, duration: 0 });
      }
      loadedTarget.current = null;
      return;
    }

    // Do not point <audio>/<video> to /stream before local download finishes (avoids 409 Conflict skip).
    if (current.track.status !== 'ready') {
      clearEl(audio);
      clearEl(video);
      loadedTarget.current = null;
      setPlaying(false);
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
      pendingSeek.current =
        (firstLoad.current || prev === null) && nowPlaying && nowPlaying.positionSec > 0 ? nowPlaying.positionSec : null;
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
  }, [current, nowPlaying, config, activeMediaKind, unlocked, isSpotifyOutput]);

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
    localStorage.setItem(REACTIONS_ENABLED_KEY, String(reactionsEnabled));
  }, [reactionsEnabled]);

  useEffect(() => {
    pendingOffsetRef.current = null;
  }, [current?.trackId]);

  // Manage YouTube embed URL only when entering/leaving Clipe mode in embed mode (never on time ticks).
  useEffect(() => {
    if (effectiveStageMode === 'video' && !videoAvailableInCache && videoAvailableInEmbed && current?.track.youtubeId) {
      setEmbedSrc(
        youtubeEmbedUrl(current.track.youtubeId, latestEmbedStartSecRef.current, latestEmbedPlayingRef.current),
      );
    } else {
      setEmbedSrc(null);
    }
  }, [effectiveStageMode, videoAvailableInCache, videoAvailableInEmbed, current?.id, current?.track.youtubeId, isSpotifyOutput]);

  // Keep muted embed iframe play/pause synced with authoritative playback.
  useEffect(() => {
    if (!embedSrc || !embedIframeRef.current?.contentWindow) return;
    const func = effectivePlaying ? 'playVideo' : 'pauseVideo';
    embedIframeRef.current.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args: [] }), '*');
  }, [effectivePlaying, embedSrc]);

  useEffect(() => {
    if (isSpotifyOutput || !playing) return;
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
  }, [isSpotifyOutput, playing, getActiveMedia]);

  const reportProgress = (force = false, mediaOverride?: HTMLMediaElement | null) => {
    if (isSpotifyOutput) return;
    const media = mediaOverride ?? getActiveMedia();
    if (!media || !current) return;
    const now = Date.now();
    if (!force && now - lastSent.current < 1000) return;
    lastSent.current = now;
    send({ type: 'progress', queueId: current.id, positionSec: media.currentTime, paused: media.paused });
  };

  const unlock = () => {
    setUnlocked(true);
    if (!isSpotifyOutput) getActiveMedia()?.play().catch(() => {});
  };

  const togglePlay = () => {
    if (!current) return;
    if (isSpotifyOutput) {
      void run(effectivePlaying ? api.spotifyPause : api.spotifyResume);
      return;
    }
    const media = getActiveMedia();
    if (!media) return;
    if (media.paused) media.play().catch(() => {});
    else media.pause();
  };

  const handleStageVolumeError = useCallback(
    (info: { message: string }) => toast.show(info.message, true),
    [toast.show],
  );
  const applyStageSpotifyVolume = useSpotifyVolumeControl(setSpotifyVolume, handleStageVolumeError);

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
  const effectiveDuration = isSpotifyOutput ? current?.track.durationSec || 0 : time.duration || current?.track.durationSec || 0;
  const progressPct = effectiveDuration > 0 ? Math.min(100, (effectiveCurrentSec / effectiveDuration) * 100) : 0;
  const remainingSec = effectiveDuration > 0 ? Math.max(0, effectiveDuration - effectiveCurrentSec) : Number.POSITIVE_INFINITY;
  const queueRemainingSec = current ? (effectiveDuration > 0 ? Math.max(0, effectiveDuration - effectiveCurrentSec) : null) : 0;
  const nextUp =
    (isSpotifyOutput
      ? state.queue[0]
      : state.queue.find((entry) => entry.track.status === 'ready') ?? state.queue[0]) ?? null;
  const showUpNextBanner = Boolean(
    current && nextUp && effectiveDuration > 0 && remainingSec <= UP_NEXT_WINDOW_SEC && dismissedUpNextId !== current.id,
  );
  const controlsHidden = cinemaMode && cinemaIdle && !settingsOpen && !catalogOpen && !editingTrack && unlocked;
  const backdrop = cssImageUrl(current?.track.thumbnail);

  const enqueueFromCatalog = async (result: SearchResult) => {
    const key = `${result.source}:${result.sourceId}`;
    setAddingKey(key);
    try {
      const outcome = await api.enqueue(result);
      toast.show(
        outcome.duplicate
          ? 'Essa já está na fila — voto registrado 👍'
          : outcome.cached
            ? 'Adicionada à fila ⚡'
            : 'Adicionada! Baixando em segundo plano…',
      );
    } catch (err) {
      toast.show((err as Error).message, true);
    } finally {
      setAddingKey(null);
    }
  };

  const enqueueAlbumFromCatalog = async (items: SearchResult[], albumName: string) => {
    try {
      let addedCount = 0;
      for (const item of items) {
        const outcome = await api.enqueue(item);
        if (!outcome.duplicate) addedCount += 1;
      }
      toast.show(
        addedCount > 0
          ? `${addedCount} música${addedCount === 1 ? '' : 's'} de "${albumName}" adicionada${addedCount === 1 ? '' : 's'} à fila ⚡`
          : `As faixas de "${albumName}" já estavam na fila`,
      );
    } catch (err) {
      toast.show((err as Error).message, true);
    }
  };

  const activeScope = !unlocked
    ? 'unlock'
    : editingTrack
      ? 'metadata'
      : catalogOpen
        ? 'catalog'
        : settingsOpen
          ? 'host'
          : 'main';

  const getActiveScopeElements = useCallback((): HTMLElement[] => {
    if (activeScope === 'unlock') {
      return unlockBtnRef.current ? [unlockBtnRef.current] : [];
    }
    if (activeScope === 'metadata') {
      return getFocusableElements(document.querySelector('[data-kiosk-scope="metadata"]'));
    }
    if (activeScope === 'catalog') {
      return getFocusableElements(catalogDialogRef.current);
    }
    if (activeScope === 'host') {
      return getFocusableElements(hostDialogRef.current);
    }
    return [...getFocusableElements(mainRef.current), ...getFocusableElements(asideRef.current)];
  }, [activeScope]);

  const setKioskFocus = useCallback((el: HTMLElement | null) => {
    const prev = focusedElRef.current;
    if (prev && prev !== el) {
      prev.removeAttribute('data-kiosk-focused');
    }
    focusedElRef.current = el;
    if (el && dpadActiveRef.current) {
      el.setAttribute('data-kiosk-focused', 'true');
      el.focus({ preventScroll: true });
      el.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
  }, []);

  const focusDefaultInScope = useCallback(() => {
    const candidates = getActiveScopeElements();
    if (candidates.length === 0) {
      setKioskFocus(null);
      return null;
    }
    const preferred = candidates.find((c) => c.dataset.kioskDefault === 'true') ?? candidates[0];
    setKioskFocus(preferred);
    return preferred;
  }, [getActiveScopeElements, setKioskFocus]);

  useEffect(() => {
    const clearDpadOnPointer = () => {
      dpadActiveRef.current = false;
      if (focusedElRef.current) {
        focusedElRef.current.removeAttribute('data-kiosk-focused');
      }
    };
    window.addEventListener('pointerdown', clearDpadOnPointer, { passive: true });
    return () => window.removeEventListener('pointerdown', clearDpadOnPointer);
  }, []);

  useEffect(() => {
    if (!dpadActiveRef.current) return;
    const raf = window.requestAnimationFrame(() => {
      const candidates = getActiveScopeElements();
      if (!focusedElRef.current || !candidates.includes(focusedElRef.current)) {
        focusDefaultInScope();
      }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [activeScope, catalogHistory, catalogTab, current?.id, cinemaMode, getActiveScopeElements, focusDefaultInScope]);

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => {
    if (!cinemaMode || settingsOpen || !unlocked) {
      setCinemaIdle(false);
      wakeCinemaRef.current = null;
      return;
    }
    let timer = window.setTimeout(() => setCinemaIdle(true), CINEMA_IDLE_MS);
    const resetIdle = () => {
      setCinemaIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setCinemaIdle(true), CINEMA_IDLE_MS);
    };
    wakeCinemaRef.current = resetIdle;
    window.addEventListener('mousemove', resetIdle);
    window.addEventListener('mousedown', resetIdle);
    window.addEventListener('touchstart', resetIdle, { passive: true });
    return () => {
      wakeCinemaRef.current = null;
      window.clearTimeout(timer);
      window.removeEventListener('mousemove', resetIdle);
      window.removeEventListener('mousedown', resetIdle);
      window.removeEventListener('touchstart', resetIdle);
    };
  }, [cinemaMode, settingsOpen, unlocked]);

  const handleKioskCommand = useCallback(
    (command: KioskCommand) => {
      wakeCinemaRef.current?.();

      if (!unlocked) {
        if (command === 'SELECT' || command === 'PLAY') {
          dpadActiveRef.current = true;
          unlock();
        }
        return;
      }

      dpadActiveRef.current = true;

      if (command === 'BACK') {
        if (editingTrack) {
          setEditingTrack(null);
          return;
        }
        if (catalogOpen) {
          if (catalogHistory.length > 1) {
            setCatalogHistory((prev) => prev.slice(0, -1));
          } else {
            setCatalogOpen(false);
          }
          return;
        }
        if (settingsOpen) {
          setSettingsOpen(false);
          return;
        }
        if (cinemaMode && !document.fullscreenElement) {
          setCinemaMode(false);
        }
        return;
      }

      if (command === 'MENU') {
        if (editingTrack) setEditingTrack(null);
        if (catalogOpen) setCatalogOpen(false);
        setSettingsOpen((v) => !v);
        return;
      }

      if (command === 'SKIP') {
        if (current) void run(api.skip);
        return;
      }

      if (command === 'PLAY') {
        if (current) {
          togglePlay();
        } else if (focusedElRef.current && getActiveScopeElements().includes(focusedElRef.current)) {
          activateFocusedElement(focusedElRef.current);
        }
        return;
      }

      if (command === 'SELECT') {
        const candidates = getActiveScopeElements();
        const target =
          focusedElRef.current && candidates.includes(focusedElRef.current)
            ? focusedElRef.current
            : focusDefaultInScope();
        activateFocusedElement(target);
        return;
      }

      // Spatial D-Pad directions: UP, DOWN, LEFT, RIGHT
      const candidates = getActiveScopeElements();
      if (candidates.length === 0) return;
      const currentEl = focusedElRef.current;
      if (!currentEl || !candidates.includes(currentEl)) {
        focusDefaultInScope();
        return;
      }

      const next = findNextSpatialCandidate(
        currentEl.getBoundingClientRect(),
        candidates.map((el) => ({ el, rect: el.getBoundingClientRect() })),
        command,
      );
      if (next) setKioskFocus(next.el);
    },
    [
      unlocked,
      editingTrack,
      catalogOpen,
      catalogHistory.length,
      settingsOpen,
      cinemaMode,
      current,
      getActiveScopeElements,
      focusDefaultInScope,
      setKioskFocus,
    ],
  );

  const { holdState } = useKioskInput({
    onCommand: handleKioskCommand,
    subscribeInput,
  });

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
          if (isSpotifyOutput || activeMediaKind !== 'audio' || !current || current.track.status !== 'ready' || !audioRef.current?.src) {
            return;
          }
          toast.show(`Não foi possível tocar "${current.track.title}". Pulando…`, true);
          const id = current.id;
          window.setTimeout(() => api.ended(id).catch(() => {}), 2000);
        }}
      />

      {/* Now playing */}
      <main
        ref={mainRef}
        className={`relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-5 pt-4 sm:px-8 lg:justify-between lg:gap-3 lg:px-8 lg:pb-3 lg:pt-6 ${
          cinemaMode ? 'pb-24 sm:pb-14' : 'pb-12 sm:pb-14'
        }`}
      >
        {/* Always in normal flex flow so central stage controls can never collide with the header. */}
        <div
          className={`flex w-full shrink-0 flex-wrap items-center justify-between gap-2 transition-opacity duration-300 ${
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
              onClick={() => setCatalogOpen(true)}
              className="rounded-full bg-white/10 px-3 py-1 text-xs font-medium transition hover:bg-white/20 sm:text-sm"
              title="Explorar acervo local"
            >
              📚 Acervo
            </button>
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

        <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-4 lg:gap-3 xl:gap-4">
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
              {spotifyBadge && (
                <SpotifyOutputBadge
                  label={spotifyBadge}
                  onClick={() => setSettingsOpen(true)}
                  className="px-3 py-1.5"
                  title="Alterar saída de áudio ou volume no painel do Host"
                />
              )}
            </div>

            {effectiveStageMode === 'cover' ? (
              <>
                <div
                  className={`flex items-center justify-center lg:min-h-0 lg:w-full lg:flex-1 ${
                    cinemaMode ? 'lg:max-h-[min(48vh,460px)]' : 'lg:max-h-[min(42vh,400px)]'
                  }`}
                >
                  <Cover
                    src={current.track.thumbnail}
                    alt={current.track.title}
                    className={`aspect-square rounded-3xl shadow-2xl shadow-black/60 lg:h-full lg:w-auto lg:max-w-full ${
                      cinemaMode ? 'w-[min(56vh,84vw)]' : 'w-[min(48vh,78vw)]'
                    }`}
                  />
                </div>
                <div className="max-w-3xl shrink-0 text-center">
                  <h1 className="text-3xl font-bold leading-tight [overflow-wrap:anywhere] sm:text-4xl lg:text-5xl">{current.track.title}</h1>
                  <p className="mt-2 text-xl text-zinc-300">
                    {current.track.artist}
                    {current.track.album ? ` · ${current.track.album}` : ''}
                    {current.track.year ? ` (${current.track.year})` : ''}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-sm text-zinc-400">
                    <SourceBadge source={current.track.source} />
                    {current.track.genre && (
                      <span className="rounded-full border border-accent/35 bg-accent/15 px-2.5 py-0.5 text-xs font-medium text-purple-200">
                        {current.track.genre}
                      </span>
                    )}
                    {current.track.subgenre && (
                      <span className="rounded-full border border-white/15 bg-white/10 px-2.5 py-0.5 text-xs font-medium text-zinc-200">
                        {current.track.subgenre}
                      </span>
                    )}
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
                    <p className="truncate text-sm text-zinc-300">
                      {current.track.artist}
                      {current.track.album ? ` · ${current.track.album}` : ''}
                    </p>
                  </div>
                  <div className="hidden shrink-0 items-center gap-2 text-xs text-zinc-400 sm:flex">
                    <SourceBadge source={current.track.source} />
                    {current.track.genre && (
                      <span className="rounded-full border border-accent/35 bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-purple-200">
                        {current.track.genre}
                      </span>
                    )}
                    {current.track.subgenre && (
                      <span className="rounded-full border border-white/15 bg-white/10 px-2 py-0.5 text-[11px] font-medium text-zinc-200">
                        {current.track.subgenre}
                      </span>
                    )}
                    <span>pedido por {current.requesterName}</span>
                  </div>
                </div>
                <LyricsView
                  variant="kiosk"
                  lyrics={lyrics}
                  loading={lyricsLoading}
                  error={lyricsError}
                  currentTimeSec={effectiveCurrentSec}
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
                  <p className="truncate text-sm text-zinc-300">
                    {current.track.artist}
                    {current.track.album ? ` · ${current.track.album}` : ''}
                  </p>
                </div>
                <div className="hidden shrink-0 items-center gap-2 text-xs text-zinc-400 sm:flex">
                  <SourceBadge source={current.track.source} />
                  {current.track.genre && (
                    <span className="rounded-full border border-accent/35 bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-purple-200">
                      {current.track.genre}
                    </span>
                  )}
                  {current.track.subgenre && (
                    <span className="rounded-full border border-white/15 bg-white/10 px-2 py-0.5 text-[11px] font-medium text-zinc-200">
                      {current.track.subgenre}
                    </span>
                  )}
                  <span>pedido por {current.requesterName}</span>
                </div>
              </div>
            )}

            {/* Persistent <video> stage wrapper: stays mounted across Capa/Letra/Clipe toggles so playback never resets */}
            <div
              className={
                effectiveStageMode === 'video'
                  ? `relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-3xl border border-white/10 bg-black shadow-2xl shadow-black/60 lg:min-h-0 lg:flex-1 ${
                      cinemaMode ? 'max-h-[56vh] max-w-6xl lg:max-h-[54vh]' : 'max-h-[48vh] max-w-4xl lg:max-h-[48vh]'
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
                  if (isSpotifyOutput || activeMediaKind !== 'video' || !current || current.track.status !== 'ready' || !videoRef.current?.src) {
                    return;
                  }
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
                <VideoLyricsOverlay lyrics={lyrics} loading={lyricsLoading} currentTimeSec={effectiveCurrentSec} />
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
                <span>{formatTime(effectiveCurrentSec)}</span>
                <span>{formatTime(effectiveDuration)}</span>
              </div>
            </div>
            <div
              className={`flex shrink-0 flex-wrap items-center justify-center gap-3 transition-opacity duration-300 sm:gap-4 ${
                controlsHidden ? 'pointer-events-none opacity-0' : 'opacity-100'
              }`}
            >
              <button
                type="button"
                data-kiosk-default="true"
                onClick={togglePlay}
                className="h-14 w-14 rounded-full bg-white text-2xl text-zinc-900 hover:scale-105"
                aria-label={effectivePlaying ? 'Pausar' : 'Tocar'}
              >
                {effectivePlaying ? '❚❚' : '▶'}
              </button>
              <button
                type="button"
                onClick={() => run(api.skip)}
                className="h-12 w-12 rounded-full bg-white/10 text-xl hover:bg-white/20"
                aria-label="Pular"
              >
                ⏭
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    isSpotifyOutput
                      ? applyStageSpotifyVolume(spotifyVolume - 10, true)
                      : setVolume((v) => Math.max(0, Math.round((v - 0.1) * 100) / 100))
                  }
                  aria-label="Diminuir volume"
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-xs font-bold hover:bg-white/20"
                >
                  🔉-
                </button>
                <input
                  type="range"
                  data-kiosk-focus="skip"
                  min={0}
                  max={isSpotifyOutput ? 100 : 1}
                  step={isSpotifyOutput ? 5 : 0.05}
                  value={isSpotifyOutput ? spotifyVolume : volume}
                  onChange={(e) =>
                    isSpotifyOutput ? applyStageSpotifyVolume(Number(e.target.value), false) : setVolume(Number(e.target.value))
                  }
                  className={`w-24 sm:w-28 ${isSpotifyOutput ? 'accent-green-400' : 'accent-accent'}`}
                  aria-label={isSpotifyOutput ? 'Volume do Spotify Connect' : 'Volume'}
                />
                <button
                  type="button"
                  onClick={() =>
                    isSpotifyOutput
                      ? applyStageSpotifyVolume(spotifyVolume + 10, true)
                      : setVolume((v) => Math.min(1, Math.round((v + 0.1) * 100) / 100))
                  }
                  aria-label="Aumentar volume"
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-xs font-bold hover:bg-white/20"
                >
                  🔊+
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center text-center">
            {spotifyBadge && (
              <SpotifyOutputBadge
                label={spotifyBadge}
                onClick={() => setSettingsOpen(true)}
                className="mb-4 px-3 py-1"
              />
            )}
            <p className="text-6xl">🎶</p>
            <h1 className="mt-4 text-4xl font-bold">Nada tocando ainda</h1>
            <p className="mt-2 text-lg text-zinc-400">
              {state.queue.length > 0 ? 'Baixando a próxima música…' : 'Escaneie o QR Code ou escolha uma música no acervo local!'}
            </p>
            <button
              type="button"
              data-kiosk-default="true"
              onClick={() => setCatalogOpen(true)}
              className="mt-5 rounded-2xl bg-accent px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-accent/25 transition hover:brightness-110 sm:text-base"
            >
              📚 Explorar Acervo Local
            </button>
          </div>
        )}
        </div>

        {holdState && (
          <div
            role="status"
            aria-live="polite"
            className="glass pointer-events-none fixed bottom-12 left-1/2 z-40 flex -translate-x-1/2 flex-col items-center gap-1.5 border-accent-2/50 bg-panel/95 px-4 py-2 shadow-2xl backdrop-blur-md"
          >
            <span className="text-xs font-semibold text-white">
              {holdState.target === 'BACK'
                ? 'Segurando: Voltar…'
                : holdState.target === 'SKIP'
                  ? 'Segurando: Pular faixa…'
                  : 'Segurando: Menu do Host…'}
            </span>
            <div className="h-1.5 w-36 overflow-hidden rounded-full bg-white/15">
              <div
                key={`${holdState.target}-${holdState.startedAt}`}
                style={{ '--hold-duration': `${holdState.durationMs}ms` } as Record<string, string>}
                className="animate-hold-fill h-full rounded-full bg-gradient-to-r from-accent to-accent-2"
              />
            </div>
          </div>
        )}

        {unlocked && (
          <footer
            aria-label="Atalhos de navegação"
            aria-hidden={controlsHidden}
            className={`pointer-events-none mt-2 flex w-full max-w-2xl shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center text-[11px] text-zinc-400/85 transition-opacity duration-300 lg:mx-auto lg:mt-0 ${
              controlsHidden ? 'opacity-0' : 'opacity-100'
            }`}
          >
            <span>↑↓←→ Navegar</span>
            <span>·</span>
            <span>Enter Escolher</span>
            <span>·</span>
            <span>Espaço Tocar</span>
            <span className="hidden sm:inline">·</span>
            <span className="hidden sm:inline">Esc / Segurar Enter Voltar</span>
            <span className="hidden md:inline">·</span>
            <span className="hidden md:inline">Segurar Espaço Pular</span>
            <span className="hidden md:inline">·</span>
            <span className="hidden md:inline">←+→ Menu</span>
          </footer>
        )}

        {reactionsEnabled && reactions.length > 0 && (
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute right-4 z-20 flex h-64 w-36 items-end justify-end overflow-visible sm:right-8 ${
              cinemaMode ? 'bottom-24' : 'bottom-6'
            }`}
          >
            {reactions.map((reaction) => {
              const offsetPx = ((reaction.id * 29) % 72) - 36;
              return (
                <div
                  key={reaction.id}
                  style={{ right: `${36 + offsetPx}px` }}
                  className="animate-float-reaction absolute bottom-0 flex flex-col items-center gap-0.5"
                >
                  <span className="text-3xl drop-shadow-[0_4px_12px_rgba(0,0,0,0.65)] sm:text-4xl">{reaction.emoji}</span>
                  {reaction.senderName && (
                    <span className="max-w-28 truncate rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-medium text-zinc-100 backdrop-blur-sm">
                      {reaction.senderName}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* Sidebar: QR + queue (hidden in Modo Cinema, replaced by discrete corner mini QR) */}
      {!cinemaMode ? (
        <aside ref={asideRef} className="relative z-10 flex w-full flex-col gap-4 border-t border-white/10 bg-black/30 p-5 sm:p-6 lg:w-[420px] lg:border-l lg:border-t-0">
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
                currentRemainingSec={queueRemainingSec}
                onVote={(entry) => run(() => api.vote(entry.id))}
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
          panelRef={hostDialogRef}
          remoteUrl={url}
          config={config}
          playbackOutput={playbackOutput}
          spotifyVolume={spotifyVolume}
          onSpotifyVolumeChange={setSpotifyVolume}
          onToast={toast.show}
          currentTrack={current?.track ?? null}
          defaultView={defaultView}
          onDefaultViewChange={handleDefaultViewChange}
          reactionsEnabled={reactionsEnabled}
          onToggleReactions={() => setReactionsEnabled((v) => !v)}
          onEditCurrentTrack={() => {
            if (!current) return;
            setSettingsOpen(false);
            setEditingTrack(editableFromTrack(current.track));
          }}
          onOpenCatalog={() => {
            setSettingsOpen(false);
            setCatalogOpen(true);
          }}
          onCatalogChanged={() => setCatalogReloadKey((k) => k + 1)}
          onClose={() => setSettingsOpen(false)}
          onChanged={refreshConfig}
          run={run}
        />
      )}

      {catalogOpen && (
        <div
          className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 p-0 backdrop-blur-sm sm:p-6"
          onClick={() => setCatalogOpen(false)}
        >
          <div
            ref={catalogDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="kiosk-catalog-title"
            onClick={(e) => e.stopPropagation()}
            className="flex h-full w-full max-w-4xl flex-col gap-4 overflow-hidden bg-panel p-4 shadow-2xl sm:h-auto sm:max-h-[88vh] sm:rounded-3xl sm:border sm:border-white/15 sm:p-6"
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 id="kiosk-catalog-title" className="text-xl font-bold">
                  Catálogo do acervo
                </h2>
                <p className="text-xs text-zinc-400">
                  Explore por categorias, álbuns e artistas ou edite metadados das faixas.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setCatalogOpen(false)}
                aria-label="Fechar catálogo"
                className="rounded-lg px-2.5 py-1.5 text-zinc-400 hover:bg-white/10 hover:text-white"
              >
                ✕
              </button>
            </div>

            <input
              value={catalogFilter}
              onChange={(e) => setCatalogFilter(e.target.value)}
              placeholder="Filtrar categorias, álbuns, artistas ou músicas…"
              className="rounded-xl bg-white/10 px-4 py-2.5 text-sm text-white outline-none focus:ring-2 focus:ring-accent"
            />

            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <CatalogBrowser
                tab={catalogTab}
                onTabChange={setCatalogTab}
                history={catalogHistory}
                onHistoryChange={setCatalogHistory}
                filterQuery={catalogFilter}
                onClearFilter={() => setCatalogFilter('')}
                reloadKey={catalogReloadKey}
                addingKey={addingKey}
                onAdd={enqueueFromCatalog}
                onAddAlbum={enqueueAlbumFromCatalog}
                canEditMetadata
                canEnqueueAlbum
                onEditTrack={setEditingTrack}
                onCategoriesLoaded={(cats) => setCategorySuggestions(mergeCategorySuggestions(cats))}
              />
            </div>
          </div>
        </div>
      )}

      <TrackMetadataModal
        track={editingTrack}
        categorySuggestions={categorySuggestions}
        onClose={() => setEditingTrack(null)}
        onSaved={(updated) => {
          toast.show(`Metadados de "${updated.title}" atualizados`);
          setCatalogReloadKey((k) => k + 1);
        }}
      />

      {!unlocked && (
        <button
          ref={unlockBtnRef}
          onClick={unlock}
          className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-ink/90 px-6 text-center backdrop-blur"
        >
          <span className="text-7xl">🔊</span>
          <span className="text-3xl font-bold">Toque para iniciar a Jukebox</span>
          <span className="text-zinc-400">Pressione Enter, Espaço ou toque na tela para liberar o áudio.</span>
        </button>
      )}
      {toast.node}
    </div>
  );
}

type RunFn = <T>(action: () => Promise<T>, ok?: string | ((result: T) => string)) => Promise<void>;

function SpotifyOutputBadge({
  label,
  onClick,
  className = '',
  title,
}: {
  label: string;
  onClick: () => void;
  className?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border border-green-400/40 bg-green-500/15 text-xs font-semibold text-green-200 transition hover:bg-green-500/25 ${className}`}
      title={title}
    >
      {label}
    </button>
  );
}

interface HostPanelProps {
  panelRef: RefObject<HTMLDivElement | null>;
  remoteUrl: string;
  config: AppConfig | null;
  playbackOutput: PlaybackOutput;
  spotifyVolume: number;
  onSpotifyVolumeChange: (volume: number) => void;
  onToast: (message: string, error?: boolean) => void;
  currentTrack: Track | null;
  defaultView: DefaultStageView;
  onDefaultViewChange: (view: DefaultStageView) => void;
  reactionsEnabled: boolean;
  onToggleReactions: () => void;
  onEditCurrentTrack: () => void;
  onOpenCatalog: () => void;
  onCatalogChanged: () => void;
  onClose: () => void;
  onChanged: () => void;
  run: RunFn;
}

const AUTO_DJ_MODES: { id: AutoDjMode; label: string; hint: string }[] = [
  { id: 'vibe', label: 'Seguir clima atual', hint: 'Mesma subcategoria → categoria → afinidade segura (Gospel isolado).' },
  { id: 'category', label: 'Travar em Categoria/Subcategoria', hint: 'Toca apenas faixas da categoria/subcategoria selecionada.' },
  { id: 'random', label: 'Aleatório', hint: 'Sorteia qualquer faixa em cache evitando repetições recentes.' },
];

function HostPanel({
  panelRef,
  remoteUrl: qrUrl,
  config,
  playbackOutput,
  spotifyVolume,
  onSpotifyVolumeChange,
  onToast,
  currentTrack,
  defaultView,
  onDefaultViewChange,
  reactionsEnabled,
  onToggleReactions,
  onEditCurrentTrack,
  onOpenCatalog,
  onCatalogChanged,
  onClose,
  onChanged,
  run,
}: HostPanelProps) {
  const [pin, setPin] = useState(getHostPin());
  const [playlist, setPlaylist] = useState('');
  const [categories, setCategories] = useState<CatalogCategory[]>([]);
  const [pickingCategory, setPickingCategory] = useState(false);
  const [autocategorizing, setAutocategorizing] = useState(false);
  const spotify = config?.spotify;
  const activeMode: AutoDjMode = config?.autoDjMode ?? 'vibe';
  const showCategoryPicker = activeMode === 'category' || pickingCategory;
  const activeCategoryName = config?.autoDjCategory ?? '';
  const activeSubcategoryName = config?.autoDjSubgenre ?? '';
  const activeCategoryObj = categories.find((c) => c.name.toLowerCase() === activeCategoryName.toLowerCase());

  const loadCategories = useCallback(() => {
    api
      .catalogCategories()
      .then((res) => setCategories(res.categories))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/50" onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Controles do host"
        className="flex h-full w-full max-w-md flex-col gap-5 overflow-y-auto bg-panel p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold">Controles do host</h2>
          <button
            type="button"
            data-kiosk-default="true"
            onClick={onClose}
            aria-label="Fechar controles do host"
            className="rounded-lg px-2 py-1 hover:bg-white/10"
          >
            ✕
          </button>
        </div>

        <section className="glass flex items-center gap-3 p-3.5">
          <div className="shrink-0 rounded-xl bg-white p-1.5">
            <QRCodeSVG value={qrUrl} size={68} />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">QR Code do Controle Remoto</h3>
            <p className="text-xs text-accent-2 [overflow-wrap:anywhere]">{qrUrl}</p>
          </div>
        </section>

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

        <section className="glass flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="font-semibold">Auto-DJ</h3>
              <p className="text-xs text-zinc-400">
                Quando a fila esvaziar, escolhe automaticamente a próxima faixa em cache sem repetir as últimas tocadas.
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
                  () => api.updateAutoDjConfig({ enabled: next }),
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
          </div>

          <div className="flex flex-col gap-1.5" role="group" aria-label="Modo do Auto-DJ">
            {AUTO_DJ_MODES.map((option) => {
              const selected = activeMode === option.id && (!pickingCategory || option.id === 'category');
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={selected}
                  disabled={!config}
                  onClick={() => {
                    if (!config) return;
                    if (option.id === 'category') {
                      const targetCat = activeCategoryName || categories[0]?.name || '';
                      if (!targetCat) {
                        setPickingCategory(true);
                        onToast('Nenhuma categoria no acervo ainda — auto-categorize ou edite uma faixa.', true);
                        return;
                      }
                      setPickingCategory(true);
                      void run(
                        () =>
                          api.updateAutoDjConfig({
                            mode: 'category',
                            category: targetCat,
                            subgenre: activeCategoryName ? activeSubcategoryName || null : null,
                          }),
                        `Auto-DJ travado em ${targetCat}`,
                      ).then(onChanged);
                      return;
                    }
                    setPickingCategory(false);
                    void run(
                      () => api.updateAutoDjConfig({ mode: option.id }),
                      `Modo Auto-DJ: ${option.label}`,
                    ).then(onChanged);
                  }}
                  className={`flex flex-col rounded-xl border px-3 py-2 text-left transition ${
                    selected
                      ? 'border-accent bg-accent/20 text-white'
                      : 'border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10'
                  } disabled:opacity-50`}
                >
                  <span className="text-xs font-semibold">{option.label}</span>
                  <span className="text-[11px] text-zinc-400">{option.hint}</span>
                </button>
              );
            })}
          </div>

          {showCategoryPicker && (
            <div className="flex flex-col gap-2 rounded-xl border border-white/10 bg-black/25 p-3">
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                  Categoria travada
                </span>
                {categories.length === 0 ? (
                  <p className="text-xs text-zinc-400">
                    Nenhuma categoria encontrada. Use &ldquo;Auto-categorizar acervo&rdquo; abaixo primeiro.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {categories.map((cat) => {
                      const active = activeCategoryName.toLowerCase() === cat.name.toLowerCase();
                      return (
                        <button
                          key={cat.name}
                          type="button"
                          aria-pressed={active}
                          onClick={() => {
                            void run(
                              () =>
                                api.updateAutoDjConfig({
                                  mode: 'category',
                                  category: cat.name,
                                  subgenre: null,
                                }),
                              `Auto-DJ travado em ${cat.name}`,
                            ).then(onChanged);
                          }}
                          className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                            active
                              ? 'border-accent bg-accent text-white'
                              : 'border-white/10 bg-white/5 text-zinc-300 hover:bg-white/15'
                          }`}
                        >
                          {cat.name} ({cat.trackCount})
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {activeCategoryObj && (activeCategoryObj.subcategories?.length ?? 0) > 0 && (
                <div className="flex flex-col gap-1.5 border-t border-white/10 pt-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                    Subcategoria (opcional)
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      aria-pressed={!activeSubcategoryName}
                      onClick={() => {
                        void run(
                          () =>
                            api.updateAutoDjConfig({
                              mode: 'category',
                              category: activeCategoryObj.name,
                              subgenre: null,
                            }),
                          `Auto-DJ: todas de ${activeCategoryObj.name}`,
                        ).then(onChanged);
                      }}
                      className={`rounded-full border px-2.5 py-0.5 text-xs transition ${
                        !activeSubcategoryName
                          ? 'border-accent-2 bg-accent-2/25 font-semibold text-white'
                          : 'border-white/10 bg-white/5 text-zinc-300 hover:bg-white/15'
                      }`}
                    >
                      Todas da categoria
                    </button>
                    {activeCategoryObj.subcategories!.map((sub) => {
                      const active = activeSubcategoryName.toLowerCase() === sub.name.toLowerCase();
                      return (
                        <button
                          key={sub.name}
                          type="button"
                          aria-pressed={active}
                          onClick={() => {
                            void run(
                              () =>
                                api.updateAutoDjConfig({
                                  mode: 'category',
                                  category: activeCategoryObj.name,
                                  subgenre: sub.name,
                                }),
                              `Auto-DJ travado em ${sub.name}`,
                            ).then(onChanged);
                          }}
                          className={`rounded-full border px-2.5 py-0.5 text-xs transition ${
                            active
                              ? 'border-accent-2 bg-accent-2/25 font-semibold text-white'
                              : 'border-white/10 bg-white/5 text-zinc-300 hover:bg-white/15'
                          }`}
                        >
                          {sub.name} ({sub.trackCount})
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        <section className="glass flex items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <h3 className="font-semibold">Reações ao vivo</h3>
            <p className="text-xs text-zinc-400">
              Exibe emojis enviados pelos convidados pelo celular flutuando na tela.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-label="Mostrar reações ao vivo"
            aria-checked={reactionsEnabled}
            onClick={onToggleReactions}
            className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition ${
              reactionsEnabled ? 'bg-accent' : 'bg-white/20'
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${
                reactionsEnabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </section>

        <SpotifyConnectSelector
          config={config}
          playbackOutput={playbackOutput}
          volume={spotifyVolume}
          onVolumeChange={onSpotifyVolumeChange}
          onToast={onToast}
        />

        <section className="glass flex flex-col gap-3 p-4">
          <h3 className="font-semibold">Spotify</h3>
          {!spotify?.configured && (
            <p className="text-sm text-zinc-400">
              Desativado. Preencha <code>SPOTIFY_CLIENT_ID</code> e <code>SPOTIFY_CLIENT_SECRET</code> no <code>.env</code> para habilitar busca,
              Spotify Connect e playlist compartilhada. YouTube e Acervo Local continuam funcionando normalmente.
            </p>
          )}
          {spotify?.configured && !spotify.connected && (
            <>
              <p className="text-sm text-zinc-400">Busca no catálogo ativa. Conecte uma conta para criar a playlist compartilhada e usar o Spotify Connect.</p>
              <a href={api.spotifyAuthUrl()} className="rounded-lg bg-green-500 px-3 py-2 text-center font-semibold text-black">
                Conectar Spotify
              </a>
              <p className="break-all text-xs text-zinc-500">Redirect URI: {spotify.redirectUri}</p>
            </>
          )}
          {spotify?.connected && (
            <>
              {!spotify.playbackAuthorized && (
                <a
                  href={api.spotifyAuthUrl()}
                  className="rounded-lg bg-amber-400 px-3 py-2 text-center text-sm font-semibold text-zinc-950"
                >
                  Reconectar Spotify (liberar Spotify Connect)
                </a>
              )}
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
          <h3 className="font-semibold">Acervo local & catálogo</h3>
          <p className="text-sm text-zinc-400">
            Coloque arquivos de áudio em <code>./data/music</code> (formato sugerido: <code>Categoria/Artista/Álbum/01 - Título.mp3</code>) ou organize categorias e álbuns pela interface.
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={onOpenCatalog}
              className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:brightness-110"
            >
              📚 Explorar catálogo
            </button>
            <button
              type="button"
              onClick={() =>
                run(api.rescanLibrary, ({ added }) => {
                  if (added) {
                    onCatalogChanged();
                    loadCategories();
                  }
                  return added ? `${added} arquivo(s) adicionados ao acervo` : 'Nenhum arquivo novo encontrado';
                })
              }
              className="rounded-lg bg-white/10 px-3 py-2 text-sm hover:bg-white/20"
            >
              Reescanear acervo
            </button>
          </div>
          <button
            type="button"
            disabled={autocategorizing}
            onClick={() => {
              setAutocategorizing(true);
              void run(api.autocategorizeLibrary, ({ updated, skippedManual }) => {
                onCatalogChanged();
                loadCategories();
                if (updated > 0) {
                  return `${updated} faixa(s) auto-categorizada(s)${skippedManual > 0 ? ` (${skippedManual} manuais preservadas)` : ''}`;
                }
                return 'Nenhuma faixa pendente para auto-categorizar';
              }).finally(() => setAutocategorizing(false));
            }}
            className="rounded-lg border border-accent/35 bg-accent/15 px-3 py-2 text-sm font-semibold text-purple-100 transition hover:bg-accent/25 disabled:opacity-50"
          >
            {autocategorizing ? 'Categorizando acervo…' : '✨ Auto-categorizar acervo'}
          </button>
          {currentTrack && (
            <button
              type="button"
              onClick={onEditCurrentTrack}
              className="mt-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-left text-xs font-medium text-zinc-200 hover:bg-white/15"
            >
              ✎ Editar metadados da faixa atual ({currentTrack.title})
            </button>
          )}
        </section>

        <a href="/remote" target="_blank" rel="noreferrer" className="text-sm text-accent-2 underline">
          Abrir modo convidado nesta tela ↗
        </a>
      </div>
    </div>
  );
}
