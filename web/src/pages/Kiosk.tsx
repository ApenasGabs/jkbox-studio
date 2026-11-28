import { QRCodeSVG } from 'qrcode.react';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { AddToPlaylistModal } from '../components/AddToPlaylistModal';
import { CatalogBrowser, type DiscoverSimilarRequest } from '../components/CatalogBrowser';
import { Cover } from '../components/Cover';
import { DiscoveryModal, type DiscoveryRequestContext } from '../components/DiscoveryModal';
import { GenreBadges } from '../components/GenreBadges';
import { LyricsView } from '../components/LyricsView';
import { MdnsHostnamePanel } from '../components/MdnsHostnamePanel';
import { PlaylistManagerPanel } from '../components/PlaylistManagerPanel';
import { QrAccessCard } from '../components/QrAccessCard';
import { QueueList } from '../components/QueueList';
import { SourceBadge } from '../components/SourceBadge';
import { SpotifyConnectSelector } from '../components/SpotifyConnectSelector';
import { useToast } from '../components/Toast';
import { TrackMetadataModal } from '../components/TrackMetadataModal';
import { VideoLyricsOverlay } from '../components/VideoLyricsOverlay';
import { api, getHostPin, setHostPin } from '../lib/api';
import { takePinFromUrl } from '../lib/hostPin';
import { HostPinPanel } from '../components/HostPinPanel';
import { GestureHudOverlay } from '../components/GestureHudOverlay';
import {
  AutoDjPanel,
  GestureControlPanel,
  LibraryMaintenancePanel,
  type RunFn,
  SpotifyAccountPanel,
} from '../components/HostControls';
import {
  buildDiscoveryContext,
  type CatalogRoute,
  type CatalogTab,
  DEFAULT_CATEGORY_SUGGESTIONS,
  type EditableTrack,
  editableFromTrack,
  mergeCategorySuggestions,
  type PlaylistPickerTrack,
  playlistTrackFromTrack,
} from '../lib/catalog';
import {
  cssImageUrl,
  formatTime,
  type QrAddressMode,
  type RemoteAccessTargets,
  resolveRemoteAccessUrls,
} from '../lib/format';
import { computeStageLayoutFlags, type StageMode } from '../lib/immersiveStage';
import { interpolatePlaybackSec } from '../lib/lrc';
import { activateFocusedElement, findNextSpatialCandidate, getFocusableElements } from '../lib/spatialNav';
import { formatSpotifyOutputBadge, formatSpotifyVideoSyncBadge } from '../lib/spotifyConnect';
import { clampVideoSeekSec, planSpotifyVideoSync } from '../lib/videoSync';
import type {
  AppConfig,
  KioskCommand,
  KioskControl,
  MdnsStatus,
  PlaybackOutput,
  PlaylistSummary,
  QueueEntry,
  SearchResult,
  Track,
} from '../lib/types';
import { useInterpolatedTime } from '../lib/useInterpolatedTime';
import { type DownloadInfo, mergeAutoDjIntoConfig, useJukebox } from '../lib/useJukebox';
import { useKioskInput } from '../lib/useKioskInput';
import {
  type GestureAction,
  type GestureContextMode,
  type GestureSettings,
  loadGestureSettings,
  saveGestureSettings,
} from '../lib/gestureEngine';
import { useWebcamKioskInput } from '../lib/useWebcamKioskInput';
import { useSpotifyVolumeControl } from '../lib/useSpotifyVolume';
import { useTrackLyrics } from '../lib/useTrackLyrics';
import { resolveGuestModeAfterCommand } from '../lib/kioskGuestMode';
import { Remote } from './Remote';

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
  const {
    state,
    playbackOutput,
    autoDj,
    position,
    downloads,
    lyricsOffset,
    mdns,
    setMdns,
    network,
    reactions,
    notice,
    connected,
    send,
    subscribeInput,
    subscribeKioskControl,
  } = useJukebox();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [qrModeOverride, setQrModeOverride] = useState<QrAddressMode | null>(null);
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
  const [guestModeOpen, setGuestModeOpen] = useState(false);
  const [catalogTab, setCatalogTab] = useState<CatalogTab>('categories');
  const [catalogHistory, setCatalogHistory] = useState<CatalogRoute[]>([{ kind: 'root' }]);
  const [catalogFilter, setCatalogFilter] = useState('');
  const [catalogReloadKey, setCatalogReloadKey] = useState(0);
  const [categorySuggestions, setCategorySuggestions] = useState<string[]>([...DEFAULT_CATEGORY_SUGGESTIONS]);
  const [editingTrack, setEditingTrack] = useState<EditableTrack | null>(null);
  const [playlistPickerTrack, setPlaylistPickerTrack] = useState<PlaylistPickerTrack | null>(null);
  const [discoveryContext, setDiscoveryContext] = useState<DiscoveryRequestContext | null>(null);
  const [addingKey, setAddingKey] = useState<string | null>(null);
  const [offsetBusy, setOffsetBusy] = useState(false);
  const [cinemaMode, setCinemaMode] = useState(false);
  const [cinemaIdle, setCinemaIdle] = useState(false);
  const [queueDrawerOpen, setQueueDrawerOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(min-width: 1024px)').matches
      : true,
  );
  const [reactionsEnabled, setReactionsEnabled] = useState<boolean>(readInitialReactionsEnabled);
  const [isFullscreen, setIsFullscreen] = useState(() =>
    typeof document !== 'undefined' ? Boolean(document.fullscreenElement) : false,
  );
  const [dismissedUpNextId, setDismissedUpNextId] = useState<number | null>(null);
  const kioskRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const queueDrawerRef = useRef<HTMLDivElement>(null);
  const hostDialogRef = useRef<HTMLDivElement>(null);
  const catalogDialogRef = useRef<HTMLDivElement>(null);
  const guestRemoteDialogRef = useRef<HTMLDivElement>(null);
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
  const latestSpotifyTimeSecRef = useRef(0);
  const latestSpotifyPausedRef = useRef(false);
  const lastSpotifyVideoSeekMsRef = useRef(0);
  const lastSpotifyEmbedSeekMsRef = useRef(0);
  const embedSyncRef = useRef<{ queueId: number; lastTimeSec: number; updatedAtMs: number; paused: boolean } | null>(null);
  const wasSpotifyOutputRef = useRef(false);
  const toast = useToast();

  const isSpotifyOutput = playbackOutput.type === 'spotify';
  const spotifyBadge = formatSpotifyOutputBadge(playbackOutput);
  const spotifyVideoBadge = formatSpotifyVideoSyncBadge(playbackOutput);
  const nowPlaying = state.nowPlaying;
  const current = nowPlaying?.item;
  const spotifyTimeSec = useInterpolatedTime(
    position,
    Boolean(current) && isSpotifyOutput,
    connected,
    current?.track.durationSec,
  );
  latestSpotifyTimeSecRef.current = spotifyTimeSec;
  latestSpotifyPausedRef.current = position.paused;
  const effectivePlaying = isSpotifyOutput ? !position.paused : playing;
  const effectiveCurrentSec = isSpotifyOutput ? spotifyTimeSec : time.current;
  latestEmbedStartSecRef.current = isSpotifyOutput ? spotifyTimeSec : (audioRef.current?.currentTime ?? 0);
  latestEmbedPlayingRef.current = isSpotifyOutput ? !position.paused : (audioRef.current ? !audioRef.current.paused : playing);
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
  const handleMdnsUpdated = useCallback(
    (nextMdns: MdnsStatus) => {
      setMdns(nextMdns);
      setQrModeOverride(null);
      setConfig((prev) => (prev ? { ...prev, mdns: nextMdns } : prev));
    },
    [setMdns],
  );

  useEffect(() => {
    refreshConfig();
    const urlPin = takePinFromUrl();
    if (urlPin) setHostPin(urlPin);
    // The Kiosk on the jukebox machine (loopback) or with a valid stored PIN learns the current
    // Host PIN, so the TV keeps full control even when the PIN is auto-generated.
    api
      .hostPinStatus()
      .then((status) => {
        if (status.pin && getHostPin() !== status.pin) setHostPin(status.pin);
      })
      .catch(() => {});
    const params = new URLSearchParams(window.location.search);
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
    setConfig((prev) => mergeAutoDjIntoConfig(prev, autoDj));
  }, [autoDj]);

  useEffect(() => {
    if (notice) toast.show(notice.message, notice.error);
  }, [notice, toast.show]);

  useEffect(() => {
    setVideoFailedQueueId(null);
  }, [current?.id]);

  // Load the current queue item into <video> (when cached MP4 is available & VIDEO_MODE=cache)
  // or <audio>. Switching between Capa / Letra / Clipe keeps the active element untouched in local
  // mode so currentTime and play/pause state never reset. When Spotify Connect is active, keep local
  // <audio> paused/muted and drive muted <video> only while Clipe mode is visible.
  useEffect(() => {
    const audio = audioRef.current;
    const video = videoRef.current;
    if (!audio) return;
    const prevWasSpotify = wasSpotifyOutputRef.current;
    wasSpotifyOutputRef.current = isSpotifyOutput;

    const clearEl = (el: HTMLMediaElement | null) => {
      if (!el || !el.getAttribute('src')) return;
      el.pause();
      el.removeAttribute('src');
      el.load();
    };

    if (isSpotifyOutput) {
      audio.muted = true;
      clearEl(audio);
      if (video) {
        video.muted = true;
        video.defaultMuted = true;
      }

      if (!current || !config || !videoAvailableInCache || effectiveStageMode !== 'video' || !video) {
        clearEl(video);
        loadedTarget.current = null;
        setPlaying(false);
        return;
      }

      const prev = loadedTarget.current;
      if (prev && prev.queueId === current.id && prev.kind === 'video') return;

      firstLoad.current = false;
      loadedTarget.current = { queueId: current.id, kind: 'video' };
      pendingSeek.current = latestSpotifyTimeSecRef.current > 0 ? latestSpotifyTimeSecRef.current : null;
      lastSpotifyVideoSeekMsRef.current = 0;
      video.muted = true;
      video.defaultMuted = true;
      video.src = api.videoUrl(current.trackId);
      if (!latestSpotifyPausedRef.current) {
        video.play().catch(() => {});
      }
      return;
    }

    audio.muted = false;
    if (video) {
      video.muted = false;
      video.defaultMuted = false;
    }

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
    if (prev && prev.queueId === current.id && prev.kind === activeMediaKind) {
      if (prevWasSpotify) {
        const activeEl = activeMediaKind === 'video' ? video! : audio;
        activeEl.volume = volume;
        if (unlocked && activeEl.paused) {
          activeEl.play().catch(() => setPlaying(false));
        }
      }
      return;
    }

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
  }, [current, nowPlaying, config, activeMediaKind, unlocked, isSpotifyOutput, videoAvailableInCache, effectiveStageMode]);

  // Sync muted <video> play/pause & position (only seeking when drift > ~2.75s) during Spotify Connect.
  useEffect(() => {
    const video = videoRef.current;
    if (!isSpotifyOutput || effectiveStageMode !== 'video' || !videoAvailableInCache || !current || !video) {
      return;
    }
    video.muted = true;
    video.defaultMuted = true;
    const nowMs = performance.now();
    const plan = planSpotifyVideoSync({
      readyState: video.readyState,
      seeking: video.seeking,
      currentTime: video.currentTime,
      duration: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : current.track.durationSec,
      mediaPaused: video.paused,
      targetTimeSec: spotifyTimeSec,
      targetPaused: position.paused,
      nowMs,
      lastSeekAtMs: lastSpotifyVideoSeekMsRef.current,
    });
    if (plan.deferSeekSec !== null) {
      pendingSeek.current = plan.deferSeekSec;
    }
    if (plan.seekSec !== null) {
      video.currentTime = plan.seekSec;
      lastSpotifyVideoSeekMsRef.current = nowMs;
    }
    if (plan.pause) {
      video.pause();
    } else if (plan.play) {
      video.play().catch(() => {});
    }
  }, [
    isSpotifyOutput,
    effectiveStageMode,
    videoAvailableInCache,
    current?.id,
    current?.track.durationSec,
    spotifyTimeSec,
    position.paused,
  ]);

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
      const startSec = latestEmbedStartSecRef.current;
      const shouldPlay = latestEmbedPlayingRef.current;
      embedSyncRef.current = {
        queueId: current.id,
        lastTimeSec: startSec,
        updatedAtMs: performance.now(),
        paused: !shouldPlay,
      };
      lastSpotifyEmbedSeekMsRef.current = 0;
      setEmbedSrc(youtubeEmbedUrl(current.track.youtubeId, startSec, shouldPlay));
    } else {
      embedSyncRef.current = null;
      setEmbedSrc(null);
    }
  }, [effectiveStageMode, videoAvailableInCache, videoAvailableInEmbed, current?.id, current?.track.youtubeId, isSpotifyOutput]);

  // Listen to YouTube embed postMessage time reports when active so drift sync stays accurate.
  useEffect(() => {
    if (!embedSrc || !current) return;
    const queueId = current.id;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== 'https://www.youtube-nocookie.com' && event.origin !== 'https://www.youtube.com') {
        return;
      }
      if (typeof event.data !== 'string') return;
      let payload: { event?: string; info?: { currentTime?: unknown; playerState?: unknown } };
      try {
        payload = JSON.parse(event.data) as typeof payload;
      } catch {
        return;
      }
      if (payload.event !== 'infoDelivery' || !payload.info) return;
      const reportedTime = payload.info.currentTime;
      const playerState = payload.info.playerState;
      const prev = embedSyncRef.current;
      embedSyncRef.current = {
        queueId,
        lastTimeSec: typeof reportedTime === 'number' && Number.isFinite(reportedTime) ? reportedTime : (prev?.lastTimeSec ?? 0),
        updatedAtMs: performance.now(),
        paused: typeof playerState === 'number' ? playerState === 2 : (prev?.paused ?? false),
      };
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [embedSrc, current?.id]);

  // Keep muted embed iframe play/pause (and Spotify Connect drift) synced with authoritative playback.
  useEffect(() => {
    if (!embedSrc || !embedIframeRef.current?.contentWindow) return;
    const win = embedIframeRef.current.contentWindow;
    const func = effectivePlaying ? 'playVideo' : 'pauseVideo';
    win.postMessage(JSON.stringify({ event: 'command', func, args: [] }), '*');
    if (embedSyncRef.current && current && embedSyncRef.current.queueId === current.id) {
      const nowMs = performance.now();
      const elapsedMs = embedSyncRef.current.paused ? 0 : Math.max(0, nowMs - embedSyncRef.current.updatedAtMs);
      embedSyncRef.current = {
        queueId: current.id,
        lastTimeSec: interpolatePlaybackSec(embedSyncRef.current.lastTimeSec, elapsedMs, embedSyncRef.current.paused, current.track.durationSec),
        updatedAtMs: nowMs,
        paused: !effectivePlaying,
      };
    }
  }, [effectivePlaying, embedSrc, current?.id, current?.track.durationSec]);

  useEffect(() => {
    if (
      !isSpotifyOutput ||
      effectiveStageMode !== 'video' ||
      videoAvailableInCache ||
      !embedSrc ||
      !current ||
      !embedIframeRef.current?.contentWindow ||
      embedSyncRef.current?.queueId !== current.id
    ) {
      return;
    }
    const nowMs = performance.now();
    const syncState = embedSyncRef.current;
    const elapsedMs = syncState.paused ? 0 : Math.max(0, nowMs - syncState.updatedAtMs);
    const estimatedEmbedSec = interpolatePlaybackSec(
      syncState.lastTimeSec,
      elapsedMs,
      syncState.paused,
      current.track.durationSec,
    );
    const plan = planSpotifyVideoSync({
      readyState: 1,
      currentTime: estimatedEmbedSec,
      duration: current.track.durationSec,
      mediaPaused: syncState.paused,
      targetTimeSec: spotifyTimeSec,
      targetPaused: position.paused,
      nowMs,
      lastSeekAtMs: lastSpotifyEmbedSeekMsRef.current,
    });
    if (plan.seekSec !== null) {
      embedIframeRef.current.contentWindow.postMessage(
        JSON.stringify({ event: 'command', func: 'seekTo', args: [plan.seekSec, true] }),
        '*',
      );
      lastSpotifyEmbedSeekMsRef.current = nowMs;
      embedSyncRef.current = {
        queueId: current.id,
        lastTimeSec: plan.seekSec,
        updatedAtMs: nowMs,
        paused: position.paused,
      };
    }
  }, [isSpotifyOutput, effectiveStageMode, videoAvailableInCache, embedSrc, current?.id, current?.track.durationSec, spotifyTimeSec, position.paused]);

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

  const kioskControlRef = useRef<(control: KioskControl) => void>(() => {});
  kioskControlRef.current = (control: KioskControl) => {
    switch (control.action) {
      case 'play':
      case 'pause':
      case 'toggle': {
        if (!current) return;
        const wantPlay = control.action === 'toggle' ? !effectivePlaying : control.action === 'play';
        if (isSpotifyOutput) {
          if (wantPlay !== effectivePlaying) void run(wantPlay ? api.spotifyResume : api.spotifyPause);
          return;
        }
        const media = getActiveMedia();
        if (!media) return;
        if (wantPlay) media.play().catch(() => {});
        else media.pause();
        return;
      }
      case 'volume':
        if (isSpotifyOutput) applyStageSpotifyVolume(control.value, true);
        else setVolume(Math.round(control.value) / 100);
        return;
      case 'stage':
        if (control.value === 'cinema') {
          setCinemaMode(true);
        } else {
          setCinemaMode(false);
          setStageMode(control.value);
        }
        return;
      case 'reactions':
        setReactionsEnabled(control.value);
        return;
    }
  };
  useEffect(() => subscribeKioskControl((control) => kioskControlRef.current(control)), [subscribeKioskControl]);

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

  const liveMdns = mdns ?? config?.mdns ?? null;
  const effectiveConfig: AppConfig | null = config
    ? {
        ...config,
        mdns: liveMdns,
        ...(network
          ? {
              publicUrl: network.publicUrl,
              lanIps: network.lanIps,
              lanUrl: network.lanUrl,
              publicUrlWarning: network.publicUrlWarning,
            }
          : {}),
      }
    : null;
  const accessTargets = resolveRemoteAccessUrls(
    effectiveConfig ?? network,
    liveMdns,
    window.location.origin,
    qrModeOverride,
  );
  const url = accessTargets.qrUrl;
  const publicUrlWarning = network?.publicUrlWarning ?? config?.publicUrlWarning ?? null;
  const handleSelectQrMode = useCallback((mode: QrAddressMode) => {
    setQrModeOverride(mode);
  }, []);
  const handleToggleQrMode = useCallback(() => {
    setQrModeOverride((prev) => {
      const currentMode = prev ?? (accessTargets.activeMode === 'mdns' ? 'mdns' : 'ip');
      return currentMode === 'mdns' ? 'ip' : 'mdns';
    });
  }, [accessTargets.activeMode]);
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
  const {
    isDesktopImmersive,
    sidebarCollapsed,
    autoHideActive,
    controlsHidden,
  } = computeStageLayoutFlags({
    isDesktop,
    cinemaMode,
    stageMode: effectiveStageMode,
    hasTrack: Boolean(current),
    hasModalOpen: Boolean(
      settingsOpen || catalogOpen || guestModeOpen || queueDrawerOpen || editingTrack || playlistPickerTrack || discoveryContext,
    ),
    unlocked,
    idle: cinemaIdle,
  });
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

  const enqueuePlaylistFromCatalog = async (playlist: PlaylistSummary, shuffle: boolean) => {
    try {
      const outcome = await api.enqueuePlaylist(playlist.id, { shuffle });
      if (outcome.total === 0) {
        toast.show(`A playlist "${playlist.name}" está vazia`, true);
        return;
      }
      toast.show(
        outcome.enqueued > 0
          ? `${outcome.enqueued} música${outcome.enqueued === 1 ? '' : 's'} de "${playlist.name}" adicionada${outcome.enqueued === 1 ? '' : 's'}${shuffle ? ' (embaralhadas)' : ''} ⚡`
          : `As faixas de "${playlist.name}" já estavam na fila`,
      );
    } catch (err) {
      toast.show((err as Error).message, true);
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

  const openDiscoverFromCatalog = useCallback((req: DiscoverSimilarRequest) => {
    setDiscoveryContext(buildDiscoveryContext(req));
  }, []);

  const activeScope = !unlocked
    ? 'unlock'
    : discoveryContext
      ? 'discovery'
      : playlistPickerTrack
        ? 'playlist-picker'
        : editingTrack
          ? 'metadata'
          : guestModeOpen
            ? 'guest-remote'
            : catalogOpen
              ? 'catalog'
              : settingsOpen
                ? 'host'
                : queueDrawerOpen
                  ? 'queue-drawer'
                  : 'main';

  const getActiveScopeElements = useCallback((): HTMLElement[] => {
    if (activeScope === 'unlock') {
      return unlockBtnRef.current ? [unlockBtnRef.current] : [];
    }
    if (activeScope === 'discovery') {
      return getFocusableElements(document.querySelector('[data-kiosk-scope="discovery"]'));
    }
    if (activeScope === 'playlist-picker') {
      return getFocusableElements(document.querySelector('[data-kiosk-scope="playlist-picker"]'));
    }
    if (activeScope === 'metadata') {
      return getFocusableElements(document.querySelector('[data-kiosk-scope="metadata"]'));
    }
    if (activeScope === 'guest-remote') {
      return getFocusableElements(guestRemoteDialogRef.current);
    }
    if (activeScope === 'catalog') {
      return getFocusableElements(catalogDialogRef.current);
    }
    if (activeScope === 'host') {
      return getFocusableElements(hostDialogRef.current);
    }
    if (activeScope === 'queue-drawer') {
      return getFocusableElements(queueDrawerRef.current);
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
      if (!focusedElRef.current || !focusedElRef.current.isConnected || !candidates.includes(focusedElRef.current)) {
        focusDefaultInScope();
      }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [activeScope, catalogHistory, catalogTab, current?.id, cinemaMode, queueDrawerOpen, effectiveStageMode, sidebarCollapsed, getActiveScopeElements, focusDefaultInScope]);

  useEffect(() => {
    const root = kioskRef.current;
    if (!root || typeof MutationObserver === 'undefined') return;
    const isUnavailableFocusTarget = (el: HTMLElement | null): boolean =>
      Boolean(el && (!el.isConnected || ('disabled' in el && Boolean((el as HTMLButtonElement).disabled))));
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (!dpadActiveRef.current || scheduled) return;
      if (isUnavailableFocusTarget(focusedElRef.current)) {
        scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          if (!dpadActiveRef.current) return;
          if (isUnavailableFocusTarget(focusedElRef.current)) {
            focusDefaultInScope();
          }
        });
      }
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled'],
    });
    return () => observer.disconnect();
  }, [focusDefaultInScope]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(min-width: 1024px)');
    setIsDesktop(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (!sidebarCollapsed && queueDrawerOpen) {
      setQueueDrawerOpen(false);
    }
  }, [sidebarCollapsed, queueDrawerOpen]);

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => {
    if (!autoHideActive) {
      setCinemaIdle(false);
      wakeCinemaRef.current = null;
      return;
    }
    setCinemaIdle(false);
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
    window.addEventListener('keydown', resetIdle);
    return () => {
      wakeCinemaRef.current = null;
      window.clearTimeout(timer);
      window.removeEventListener('mousemove', resetIdle);
      window.removeEventListener('mousedown', resetIdle);
      window.removeEventListener('touchstart', resetIdle);
      window.removeEventListener('keydown', resetIdle);
    };
  }, [autoHideActive, effectiveStageMode, current?.id]);

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
        if (discoveryContext) {
          setDiscoveryContext(null);
          return;
        }
        if (playlistPickerTrack) {
          setPlaylistPickerTrack(null);
          return;
        }
        if (editingTrack) {
          setEditingTrack(null);
          return;
        }
        if (guestModeOpen) {
          setGuestModeOpen(resolveGuestModeAfterCommand(guestModeOpen, command));
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
        if (queueDrawerOpen) {
          setQueueDrawerOpen(false);
          return;
        }
        if (cinemaMode && !document.fullscreenElement) {
          setCinemaMode(false);
        }
        return;
      }

      if (command === 'MENU') {
        if (discoveryContext) setDiscoveryContext(null);
        if (playlistPickerTrack) setPlaylistPickerTrack(null);
        if (editingTrack) setEditingTrack(null);
        if (guestModeOpen) setGuestModeOpen(resolveGuestModeAfterCommand(guestModeOpen, command));
        if (catalogOpen) setCatalogOpen(false);
        if (queueDrawerOpen) setQueueDrawerOpen(false);
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
        } else {
          const candidates = getActiveScopeElements();
          const currentEl = focusedElRef.current;
          const target =
            currentEl && currentEl.isConnected && candidates.includes(currentEl) ? currentEl : focusDefaultInScope();
          activateFocusedElement(target);
        }
        return;
      }

      if (command === 'SELECT') {
        const candidates = getActiveScopeElements();
        const currentEl = focusedElRef.current;
        const target =
          currentEl && currentEl.isConnected && candidates.includes(currentEl) ? currentEl : focusDefaultInScope();
        activateFocusedElement(target);
        return;
      }

      // Spatial D-Pad directions: UP, DOWN, LEFT, RIGHT
      const candidates = getActiveScopeElements();
      if (candidates.length === 0) return;
      const currentEl = focusedElRef.current;
      if (!currentEl || !currentEl.isConnected || !candidates.includes(currentEl)) {
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
      discoveryContext,
      playlistPickerTrack,
      editingTrack,
      guestModeOpen,
      catalogOpen,
      catalogHistory.length,
      settingsOpen,
      queueDrawerOpen,
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

  const [gestureSettings, setGestureSettings] = useState<GestureSettings>(loadGestureSettings);

  const handleGestureSettingsChange = useCallback((next: GestureSettings) => {
    setGestureSettings(saveGestureSettings(next));
  }, []);

  const gestureContext: GestureContextMode =
    activeScope === 'main' || activeScope === 'unlock' ? 'stage' : 'modal';

  const handleGestureAction = useCallback(
    (action: GestureAction) => {
      wakeCinemaRef.current?.();

      if (!unlocked) {
        dpadActiveRef.current = true;
        unlock();
        return;
      }

      if (action === 'VOL_UP') {
        if (isSpotifyOutput) {
          applyStageSpotifyVolume(spotifyVolume + 10, true);
        } else {
          setVolume((v) => Math.min(1, Math.round((v + 0.1) * 100) / 100));
        }
        return;
      }

      if (action === 'VOL_DOWN') {
        if (isSpotifyOutput) {
          applyStageSpotifyVolume(spotifyVolume - 10, true);
        } else {
          setVolume((v) => Math.max(0, Math.round((v - 0.1) * 100) / 100));
        }
        return;
      }

      if (action === 'OPEN_CATALOG') {
        dpadActiveRef.current = true;
        setCatalogOpen(true);
        return;
      }

      if (action === 'CYCLE_STAGE') {
        const availableModes: StageMode[] =
          effectiveConfig?.videoMode === 'off' ? ['cover', 'lyrics'] : ['cover', 'lyrics', 'video'];
        setStageMode((prev) => {
          const idx = availableModes.indexOf(prev);
          return availableModes[(idx + 1) % availableModes.length] ?? 'cover';
        });
        return;
      }

      if (action === 'CYCLE_TAB') {
        if (catalogOpen) {
          const tabs: CatalogTab[] = ['categories', 'playlists', 'albums', 'artists', 'all'];
          setCatalogTab((prev) => {
            const idx = tabs.indexOf(prev);
            return tabs[(idx + 1) % tabs.length] ?? 'categories';
          });
          setCatalogHistory([{ kind: 'root' }]);
          return;
        }
        handleKioskCommand('RIGHT');
        return;
      }

      handleKioskCommand(action);
    },
    [
      unlocked,
      isSpotifyOutput,
      applyStageSpotifyVolume,
      spotifyVolume,
      effectiveConfig?.videoMode,
      catalogOpen,
      handleKioskCommand,
    ],
  );

  const gestureWebcam = useWebcamKioskInput({
    settings: gestureSettings,
    context: gestureContext,
    onAction: handleGestureAction,
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
    if (isSpotifyOutput || activeMediaKind !== kind) return;
    setPlaying(true);
    reportProgress(true, el);
  };

  const handleMediaPause = (kind: 'audio' | 'video', el: HTMLMediaElement) => {
    if (isSpotifyOutput || activeMediaKind !== kind) return;
    setPlaying(false);
    reportProgress(true, el);
  };

  const handleLoadedMetadata = (kind: 'audio' | 'video', el: HTMLMediaElement) => {
    if (isSpotifyOutput) {
      if (kind !== 'video') return;
      const target = pendingSeek.current ?? latestSpotifyTimeSecRef.current;
      pendingSeek.current = null;
      const seek = clampVideoSeekSec(target, el.duration);
      if (seek > 0 && Number.isFinite(el.duration) && el.duration > 0) {
        el.currentTime = seek;
        lastSpotifyVideoSeekMsRef.current = performance.now();
      }
      if (!latestSpotifyPausedRef.current && el.paused) {
        el.play().catch(() => {});
      }
      return;
    }
    if (activeMediaKind !== kind) return;
    const seek = pendingSeek.current;
    pendingSeek.current = null;
    if (seek !== null && Number.isFinite(el.duration) && seek < el.duration) {
      el.currentTime = seek;
    }
  };

  const handleTimeUpdate = (kind: 'audio' | 'video', el: HTMLMediaElement) => {
    if (isSpotifyOutput || activeMediaKind !== kind) return;
    setTime({ current: el.currentTime, duration: el.duration || current?.track.durationSec || 0 });
    reportProgress(false, el);
  };

  const handleMediaEnded = (kind: 'audio' | 'video') => {
    if (isSpotifyOutput || activeMediaKind !== kind || !current) return;
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
        className={
          isDesktopImmersive
            ? 'relative z-10 flex min-h-0 w-full flex-1 flex-col items-center justify-center p-0'
            : `relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-5 pt-4 sm:px-8 lg:justify-between lg:gap-3 lg:px-8 lg:pb-3 lg:pt-6 ${
                cinemaMode ? 'pb-24 sm:pb-14' : 'pb-12 sm:pb-14'
              }`
        }
      >
        {/* Top bar (+ compact track pill & stage tabs in desktop immersive mode) */}
        <div
          className={
            isDesktopImmersive
              ? `pointer-events-none lg:absolute lg:inset-x-0 lg:top-0 lg:z-20 lg:flex lg:flex-col lg:gap-2 lg:bg-gradient-to-b lg:from-black/85 lg:via-black/55 lg:to-transparent lg:px-6 lg:pb-8 lg:pt-4 transition-opacity duration-300 ${
                  controlsHidden ? 'opacity-0' : 'opacity-100'
                }`
              : `flex w-full shrink-0 flex-wrap items-center justify-between gap-2 transition-opacity duration-300 ${
                  controlsHidden ? 'pointer-events-none opacity-0' : 'opacity-100'
                }`
          }
        >
          <div
            className={`flex w-full items-center justify-between gap-3 ${
              isDesktopImmersive ? (controlsHidden ? 'pointer-events-none' : 'pointer-events-auto') : 'flex-wrap'
            }`}
          >
            <div className="flex min-w-0 items-center gap-3">
              <header className="flex shrink-0 items-center gap-3">
                <span className="text-2xl font-black tracking-tight">
                  jkbox<span className="text-accent">studio</span>
                </span>
                <span className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-500'}`} title={connected ? 'online' : 'reconectando'} />
              </header>
              {isDesktopImmersive && current && (
                <div className="hidden min-w-0 items-center gap-2.5 border-l border-white/15 pl-3 lg:flex">
                  <Cover src={current.track.thumbnail} alt={current.track.title} className="h-9 w-9 shrink-0 rounded-lg" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold leading-tight text-white">{current.track.title}</p>
                    <p className="truncate text-xs text-zinc-300">
                      {current.track.artist}
                      {current.track.album ? ` · ${current.track.album}` : ''}
                      {` · pedido por ${current.requesterName}`}
                    </p>
                  </div>
                </div>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setCatalogOpen(true)}
                className="rounded-full bg-white/10 px-3 py-1 text-xs font-medium transition hover:bg-white/20 sm:text-sm"
                title="Explorar acervo local"
              >
                📚 Acervo
              </button>
              {sidebarCollapsed && (
                <button
                  type="button"
                  aria-expanded={queueDrawerOpen}
                  onClick={() => setQueueDrawerOpen((v) => !v)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition sm:text-sm ${
                    queueDrawerOpen ? 'bg-accent text-white shadow' : 'bg-white/10 hover:bg-white/20'
                  }`}
                  title="Abrir fila de músicas e QR Code"
                >
                  📋 Fila ({state.queue.length})
                </button>
              )}
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

          {isDesktopImmersive && current && (
            <div className={`flex flex-wrap items-center justify-center gap-2 ${controlsHidden ? 'pointer-events-none' : 'pointer-events-auto'}`}>
              <StageTabsControls
                effectiveStageMode={effectiveStageMode}
                hasVideoAvailable={hasVideoAvailable}
                videoMode={config?.videoMode}
                videoLyricsOverlay={videoLyricsOverlay}
                spotifyBadge={spotifyBadge}
                onSelectStageMode={setStageMode}
                onToggleVideoLyrics={() => setVideoLyricsOverlay((v) => !v)}
                onOpenSettings={() => setSettingsOpen(true)}
                onAddPlaylist={() => setPlaylistPickerTrack(playlistTrackFromTrack(current.track))}
              />
            </div>
          )}
        </div>

        {showUpNextBanner && nextUp && current && (
          <div
            role="status"
            aria-live="polite"
            className={`glass absolute inset-x-3 top-16 z-20 flex items-center gap-3 border-accent/40 bg-panel/90 p-3 shadow-2xl shadow-black/60 backdrop-blur-md sm:inset-x-auto sm:right-6 sm:w-80 ${
              isDesktopImmersive ? 'sm:top-28' : 'sm:top-20'
            }`}
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

        <div
          className={
            isDesktopImmersive
              ? 'relative flex min-h-0 h-full w-full flex-1 flex-col items-center justify-center'
              : 'flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-4 lg:gap-3 xl:gap-4'
          }
        >
          {current ? (
            <>
              {!isDesktopImmersive && (
                <div
                  className={`flex shrink-0 flex-wrap items-center justify-center gap-2 transition-opacity duration-300 ${
                    controlsHidden ? 'pointer-events-none opacity-0' : 'opacity-100'
                  }`}
                >
                  <StageTabsControls
                    effectiveStageMode={effectiveStageMode}
                    hasVideoAvailable={hasVideoAvailable}
                    videoMode={config?.videoMode}
                    videoLyricsOverlay={videoLyricsOverlay}
                    spotifyBadge={spotifyBadge}
                    onSelectStageMode={setStageMode}
                    onToggleVideoLyrics={() => setVideoLyricsOverlay((v) => !v)}
                    onOpenSettings={() => setSettingsOpen(true)}
                    onAddPlaylist={() => setPlaylistPickerTrack(playlistTrackFromTrack(current.track))}
                  />
                </div>
              )}

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
                    <GenreBadges genre={current.track.genre} subgenre={current.track.subgenre} variant="kiosk-hero" />
                    <span>pedido por {current.requesterName}</span>
                  </div>
                </div>
              </>
            ) : effectiveStageMode === 'lyrics' ? (
              <>
                {!isDesktopImmersive && (
                  <CompactTrackHeader track={current.track} requesterName={current.requesterName} maxWidthClass="max-w-3xl" />
                )}
                <LyricsView
                  variant="kiosk"
                  immersive={isDesktopImmersive}
                  controlsHidden={controlsHidden}
                  lyrics={lyrics}
                  loading={lyricsLoading}
                  error={lyricsError}
                  currentTimeSec={effectiveCurrentSec}
                  onRetry={reloadLyrics}
                  onAdjustOffset={adjustLyricsOffset}
                  onResetOffset={resetLyricsOffset}
                  offsetBusy={offsetBusy}
                  className={
                    isDesktopImmersive
                      ? 'h-full w-full flex-1'
                      : 'h-[52vh] min-h-[280px] max-h-[500px] w-full max-w-3xl lg:h-auto lg:max-h-none lg:min-h-0 lg:flex-1'
                  }
                />
              </>
            ) : (
              !isDesktopImmersive && (
                <CompactTrackHeader track={current.track} requesterName={current.requesterName} maxWidthClass="max-w-4xl" />
              )
            )}

            {/* Persistent <video> stage wrapper: stays mounted across Capa/Letra/Clipe toggles so playback never resets */}
            <div
              data-kiosk-stage={effectiveStageMode === 'video' ? 'video' : undefined}
              className={
                effectiveStageMode === 'video'
                  ? isDesktopImmersive
                    ? 'relative flex h-full w-full flex-1 items-center justify-center overflow-hidden bg-black'
                    : `relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-3xl border border-white/10 bg-black shadow-2xl shadow-black/60 lg:min-h-0 lg:flex-1 ${
                        cinemaMode ? 'max-h-[56vh] max-w-6xl lg:max-h-[54vh]' : 'max-h-[48vh] max-w-4xl lg:max-h-[48vh]'
                      }`
                  : 'pointer-events-none fixed left-0 top-0 h-px w-px overflow-hidden opacity-0'
              }
              aria-hidden={effectiveStageMode !== 'video'}
            >
              <video
                ref={videoRef}
                muted={isSpotifyOutput}
                playsInline
                preload="auto"
                className={videoAvailableInCache ? 'h-full w-full object-contain' : 'hidden'}
                onPlay={(e) => handleMediaPlay('video', e.currentTarget)}
                onPause={(e) => handleMediaPause('video', e.currentTarget)}
                onLoadedMetadata={(e) => handleLoadedMetadata('video', e.currentTarget)}
                onTimeUpdate={(e) => handleTimeUpdate('video', e.currentTarget)}
                onEnded={() => handleMediaEnded('video')}
                onError={() => {
                  if (
                    !current ||
                    !videoRef.current?.src ||
                    !videoAvailableInCache ||
                    (!isSpotifyOutput && (activeMediaKind !== 'video' || current.track.status !== 'ready'))
                  ) {
                    return;
                  }
                  setVideoFailedQueueId(current.id);
                  toast.show(
                    isSpotifyOutput ? 'Videoclipe indisponível no momento.' : 'Videoclipe indisponível — reproduzindo áudio.',
                    true,
                  );
                }}
              />
              {effectiveStageMode === 'video' && !videoAvailableInCache && embedSrc && (
                <iframe
                  ref={embedIframeRef}
                  title={`Videoclipe de ${current.track.title}`}
                  src={embedSrc}
                  allow="autoplay; encrypted-media; picture-in-picture"
                  className="h-full w-full border-0"
                  onLoad={() => {
                    const win = embedIframeRef.current?.contentWindow;
                    if (!win) return;
                    win.postMessage(JSON.stringify({ event: 'listening', id: 1 }), '*');
                    const func = effectivePlaying ? 'playVideo' : 'pauseVideo';
                    win.postMessage(JSON.stringify({ event: 'command', func, args: [] }), '*');
                  }}
                />
              )}
              {effectiveStageMode === 'video' && spotifyVideoBadge && (
                <div
                  role="status"
                  className={`pointer-events-none absolute left-3 z-20 max-w-[calc(100%-1.5rem)] truncate rounded-full border border-green-400/35 bg-black/65 px-3 py-1 text-[11px] font-semibold text-green-200 shadow-lg backdrop-blur-md transition-[top] duration-300 sm:text-xs ${
                    isDesktopImmersive && !controlsHidden ? 'top-3 lg:top-32' : 'top-3'
                  }`}
                >
                  {spotifyVideoBadge}
                </div>
              )}
              {effectiveStageMode === 'video' && videoLyricsOverlay && (
                <VideoLyricsOverlay
                  lyrics={lyrics}
                  loading={lyricsLoading}
                  currentTimeSec={effectiveCurrentSec}
                  immersive={isDesktopImmersive}
                  controlsVisible={!controlsHidden}
                />
              )}
            </div>

            <div
              className={
                isDesktopImmersive
                  ? `pointer-events-none lg:absolute lg:inset-x-0 lg:bottom-0 lg:z-20 lg:flex lg:w-full lg:flex-col lg:items-center lg:gap-2 lg:bg-gradient-to-t lg:from-black/90 lg:via-black/65 lg:to-transparent lg:px-6 lg:pb-3 lg:pt-10 transition-opacity duration-300 ${
                      controlsHidden ? 'opacity-0' : 'opacity-100'
                    }`
                  : 'flex w-full shrink-0 flex-col items-center gap-3'
              }
            >
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
                  controlsHidden
                    ? 'pointer-events-none opacity-0'
                    : isDesktopImmersive
                      ? 'pointer-events-auto opacity-100'
                      : 'opacity-100'
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
              {isDesktopImmersive && unlocked && (
                <KioskShortcutFooter controlsHidden={controlsHidden} />
              )}
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

        {!isDesktopImmersive && unlocked && (
          <KioskShortcutFooter controlsHidden={controlsHidden} />
        )}

        {reactionsEnabled && reactions.length > 0 && (
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute right-4 z-20 flex h-64 w-36 items-end justify-end overflow-visible sm:right-8 ${
              sidebarCollapsed ? 'bottom-24' : 'bottom-6'
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

      {/* Sidebar: QR + queue (collapsed in Modo Cinema or Desktop Immersive Clipe/Letra, replaced by discrete corner mini QR + Queue drawer) */}
      {!sidebarCollapsed ? (
        <aside ref={asideRef} className="relative z-10 flex w-full flex-col gap-4 border-t border-white/10 bg-black/30 p-5 sm:p-6 lg:w-[420px] lg:border-l lg:border-t-0">
          <QueueSidebarContent
            accessTargets={accessTargets}
            publicUrlWarning={publicUrlWarning}
            onSelectQrMode={handleSelectQrMode}
            onToggleQrMode={handleToggleQrMode}
            qrSize={112}
            queue={state.queue}
            downloads={downloads}
            currentRemainingSec={queueRemainingSec}
            onVote={(entry) => run(() => api.vote(entry.id))}
            onRemove={remove}
            onRetry={(entry) => run(() => api.retry(entry.trackId), 'Tentando baixar novamente')}
          />
        </aside>
      ) : (
        <div
          aria-label="QR Code para pedir música"
          className="glass fixed bottom-3 right-3 z-20 flex items-center gap-2.5 border-white/15 bg-black/60 p-2 opacity-75 shadow-xl transition-opacity hover:opacity-100 sm:bottom-5 sm:right-5 sm:p-2.5"
        >
          {accessTargets.canToggleMode ? (
            <button
              type="button"
              data-testid="qr-toggle-mini"
              onClick={handleToggleQrMode}
              aria-label="Alternar endereço do QR Code entre .local e IP direto"
              title="Clique para alternar entre .local e IP direto"
              className="rounded-lg bg-white p-1"
            >
              <QRCodeSVG value={url} size={56} />
            </button>
          ) : (
            <div className="rounded-lg bg-white p-1">
              <QRCodeSVG value={url} size={56} />
            </div>
          )}
          <div className="hidden max-w-[160px] pr-1 xl:block">
            <p className="text-xs font-semibold text-white">Peça sua música</p>
            <p className="truncate text-[11px] text-accent-2">{url}</p>
            {accessTargets.alternateUrl && (
              <p className="truncate text-[10px] text-zinc-400">{accessTargets.alternateUrl}</p>
            )}
          </div>
        </div>
      )}

      {queueDrawerOpen && sidebarCollapsed && (
        <div
          className="fixed inset-0 z-30 flex justify-end bg-black/50 backdrop-blur-[2px]"
          onClick={() => setQueueDrawerOpen(false)}
        >
          <div
            ref={queueDrawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Fila de músicas"
            onClick={(e) => e.stopPropagation()}
            className="flex h-full w-full max-w-md flex-col gap-4 border-l border-white/10 bg-panel p-5 shadow-2xl sm:p-6"
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-xl font-bold">Fila ({state.queue.length})</h2>
              <button
                type="button"
                data-kiosk-default="true"
                onClick={() => setQueueDrawerOpen(false)}
                aria-label="Fechar fila"
                className="rounded-lg px-2.5 py-1.5 text-zinc-300 hover:bg-white/10 hover:text-white"
              >
                ✕
              </button>
            </div>
            <QueueSidebarContent
              accessTargets={accessTargets}
              publicUrlWarning={publicUrlWarning}
              onSelectQrMode={handleSelectQrMode}
              onToggleQrMode={handleToggleQrMode}
              qrSize={84}
              queue={state.queue}
              downloads={downloads}
              currentRemainingSec={queueRemainingSec}
              onVote={(entry) => run(() => api.vote(entry.id))}
              onRemove={remove}
              onRetry={(entry) => run(() => api.retry(entry.trackId), 'Tentando baixar novamente')}
            />
          </div>
        </div>
      )}

      <GestureHudOverlay
        enabled={gestureSettings.enabled}
        hudMode={gestureSettings.hudMode}
        context={gestureContext}
        status={gestureWebcam.status}
        error={gestureWebcam.error}
        powerMode={gestureWebcam.powerMode}
        wakeProgress={gestureWebcam.wakeProgress}
        dwellProgress={gestureWebcam.dwellProgress}
        pendingAction={gestureWebcam.pendingAction}
        tooFar={gestureWebcam.tooFar}
        fps={gestureWebcam.fps}
        videoRef={gestureWebcam.videoRef}
        canvasRef={gestureWebcam.canvasRef}
      />

      {settingsOpen && (
        <HostPanel
          panelRef={hostDialogRef}
          remoteUrl={url}
          accessTargets={accessTargets}
          publicUrlWarning={publicUrlWarning}
          onSelectQrMode={handleSelectQrMode}
          onToggleQrMode={handleToggleQrMode}
          config={effectiveConfig}
          playbackOutput={playbackOutput}
          spotifyVolume={spotifyVolume}
          onSpotifyVolumeChange={setSpotifyVolume}
          gestureSettings={gestureSettings}
          gestureStatus={gestureWebcam.status}
          gestureFps={gestureWebcam.fps}
          gestureDelegate={gestureWebcam.delegate}
          onGestureSettingsChange={handleGestureSettingsChange}
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
          onAddCurrentToPlaylist={() => {
            if (!current) return;
            setSettingsOpen(false);
            setPlaylistPickerTrack(playlistTrackFromTrack(current.track));
          }}
          onOpenCatalog={() => {
            setSettingsOpen(false);
            setCatalogOpen(true);
          }}
          onOpenPlaylistsTab={() => {
            setSettingsOpen(false);
            setCatalogTab('playlists');
            setCatalogHistory([{ kind: 'root' }]);
            setCatalogOpen(true);
          }}
          onDiscoverQueueVibe={() => {
            setSettingsOpen(false);
            setDiscoveryContext(buildDiscoveryContext({ mode: 'vibe' }));
          }}
          onOpenGuestMode={() => {
            setSettingsOpen(false);
            setGuestModeOpen(true);
          }}
          reloadKey={catalogReloadKey}
          onCatalogChanged={() => setCatalogReloadKey((k) => k + 1)}
          onClose={() => setSettingsOpen(false)}
          onChanged={refreshConfig}
          onMdnsUpdated={handleMdnsUpdated}
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
                onAddPlaylist={enqueuePlaylistFromCatalog}
                onAddToPlaylist={setPlaylistPickerTrack}
                onDiscoverSimilar={openDiscoverFromCatalog}
                canEditMetadata
                canEnqueueAlbum
                onEditTrack={setEditingTrack}
                onCategoriesLoaded={(cats) => setCategorySuggestions(mergeCategorySuggestions(cats))}
                onPlaylistsChanged={() => setCatalogReloadKey((k) => k + 1)}
                onToast={toast.show}
              />
            </div>
          </div>
        </div>
      )}

      <KioskGuestOverlay
        open={guestModeOpen}
        dialogRef={guestRemoteDialogRef}
        onClose={() => setGuestModeOpen(false)}
      />

      <TrackMetadataModal
        track={editingTrack}
        categorySuggestions={categorySuggestions}
        onClose={() => setEditingTrack(null)}
        onSaved={(updated) => {
          toast.show(`Metadados de "${updated.title}" atualizados`);
          setCatalogReloadKey((k) => k + 1);
        }}
      />

      <AddToPlaylistModal
        track={playlistPickerTrack}
        onClose={() => setPlaylistPickerTrack(null)}
        onChanged={() => setCatalogReloadKey((k) => k + 1)}
        onToast={toast.show}
      />

      <DiscoveryModal
        context={discoveryContext}
        onClose={() => setDiscoveryContext(null)}
        onPopulated={() => setCatalogReloadKey((k) => k + 1)}
        onToast={toast.show}
        onSuggestionsLoaded={() => {
          if (!dpadActiveRef.current) return;
          window.requestAnimationFrame(() => {
            if (dpadActiveRef.current) focusDefaultInScope();
          });
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


/** Compact single-line track header shown above non-immersive Lyrics and Video stages. */
function CompactTrackHeader({
  track,
  requesterName,
  maxWidthClass,
}: {
  track: Track;
  requesterName: string;
  maxWidthClass: string;
}) {
  return (
    <div className={`flex w-full ${maxWidthClass} shrink-0 items-center gap-3 px-1`}>
      <Cover src={track.thumbnail} alt={track.title} className="h-12 w-12 shrink-0 rounded-xl sm:h-14 sm:w-14" />
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-lg font-bold leading-tight sm:text-2xl">{track.title}</h1>
        <p className="truncate text-sm text-zinc-300">
          {track.artist}
          {track.album ? ` · ${track.album}` : ''}
        </p>
      </div>
      <div className="hidden shrink-0 items-center gap-2 text-xs text-zinc-400 sm:flex">
        <SourceBadge source={track.source} />
        <GenreBadges genre={track.genre} subgenre={track.subgenre} variant="kiosk-compact" />
        <span>pedido por {requesterName}</span>
      </div>
    </div>
  );
}

function StageTabsControls({
  effectiveStageMode,
  hasVideoAvailable,
  videoMode,
  videoLyricsOverlay,
  spotifyBadge,
  onSelectStageMode,
  onToggleVideoLyrics,
  onOpenSettings,
  onAddPlaylist,
}: {
  effectiveStageMode: StageMode;
  hasVideoAvailable: boolean;
  videoMode?: AppConfig['videoMode'];
  videoLyricsOverlay: boolean;
  spotifyBadge: string | null;
  onSelectStageMode: (mode: StageMode) => void;
  onToggleVideoLyrics: () => void;
  onOpenSettings: () => void;
  onAddPlaylist: () => void;
}) {
  return (
    <>
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
                  ? videoMode === 'off'
                    ? 'Modo videoclipe desativado (VIDEO_MODE=off)'
                    : 'Videoclipe indisponível para esta faixa'
                  : undefined
              }
              onClick={() => !disabled && onSelectStageMode(mode.id)}
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
          onClick={onToggleVideoLyrics}
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
          onClick={onOpenSettings}
          className="px-3 py-1.5"
          title="Alterar saída de áudio ou volume no painel do Host"
        />
      )}
      <button
        type="button"
        onClick={onAddPlaylist}
        title="Adicionar faixa tocando agora a uma playlist interna"
        className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-zinc-200 transition hover:bg-white/15 hover:text-white sm:text-sm"
      >
        + Playlist
      </button>
    </>
  );
}

function KioskShortcutFooter({ controlsHidden }: { controlsHidden: boolean }) {
  return (
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
  );
}

function QueueSidebarContent({
  accessTargets,
  publicUrlWarning,
  onSelectQrMode,
  onToggleQrMode,
  qrSize,
  queue,
  downloads,
  currentRemainingSec,
  onVote,
  onRemove,
  onRetry,
}: {
  accessTargets: RemoteAccessTargets;
  publicUrlWarning: string | null;
  onSelectQrMode: (mode: QrAddressMode) => void;
  onToggleQrMode: () => void;
  qrSize: number;
  queue: QueueEntry[];
  downloads: Record<string, DownloadInfo>;
  currentRemainingSec: number | null;
  onVote: (entry: QueueEntry) => void;
  onRemove: (entry: QueueEntry) => void;
  onRetry: (entry: QueueEntry) => void;
}) {
  return (
    <>
      <QrAccessCard
        heading="Peça sua música"
        targets={accessTargets}
        qrSize={qrSize}
        variant="sidebar"
        publicUrlWarning={publicUrlWarning}
        onSelectMode={onSelectQrMode}
        onToggleMode={onToggleQrMode}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-zinc-400">Próximas ({queue.length})</h2>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <QueueList
            queue={queue}
            downloads={downloads}
            currentRemainingSec={currentRemainingSec}
            onVote={onVote}
            onRemove={onRemove}
            onRetry={onRetry}
            compact
          />
        </div>
      </div>
    </>
  );
}

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
  accessTargets: RemoteAccessTargets;
  publicUrlWarning: string | null;
  onSelectQrMode: (mode: QrAddressMode) => void;
  onToggleQrMode: () => void;
  config: AppConfig | null;
  playbackOutput: PlaybackOutput;
  spotifyVolume: number;
  onSpotifyVolumeChange: (volume: number) => void;
  gestureSettings: GestureSettings;
  gestureStatus: 'off' | 'loading' | 'ready' | 'error';
  gestureFps: number;
  gestureDelegate: 'GPU' | 'CPU' | null;
  onGestureSettingsChange: (next: GestureSettings) => void;
  onToast: (message: string, error?: boolean) => void;
  currentTrack: Track | null;
  defaultView: DefaultStageView;
  onDefaultViewChange: (view: DefaultStageView) => void;
  reactionsEnabled: boolean;
  onToggleReactions: () => void;
  onEditCurrentTrack: () => void;
  onAddCurrentToPlaylist: () => void;
  onOpenCatalog: () => void;
  onOpenPlaylistsTab: () => void;
  onDiscoverQueueVibe: () => void;
  onOpenGuestMode: () => void;
  reloadKey: number;
  onCatalogChanged: () => void;
  onClose: () => void;
  onChanged: () => void;
  onMdnsUpdated: (mdns: MdnsStatus) => void;
  run: RunFn;
}

function HostPanel({
  panelRef,
  remoteUrl: qrUrl,
  accessTargets,
  publicUrlWarning,
  onSelectQrMode,
  onToggleQrMode,
  config,
  playbackOutput,
  spotifyVolume,
  onSpotifyVolumeChange,
  gestureSettings,
  gestureStatus,
  gestureFps,
  gestureDelegate,
  onGestureSettingsChange,
  onToast,
  currentTrack,
  defaultView,
  onDefaultViewChange,
  reactionsEnabled,
  onToggleReactions,
  onEditCurrentTrack,
  onAddCurrentToPlaylist,
  onOpenCatalog,
  onOpenPlaylistsTab,
  onDiscoverQueueVibe,
  onOpenGuestMode,
  reloadKey,
  onCatalogChanged,
  onClose,
  onChanged,
  onMdnsUpdated,
  run,
}: HostPanelProps) {
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);

  const loadPlaylists = useCallback((signal?: AbortSignal) => {
    api
      .playlists(undefined, signal)
      .then((res) => {
        if (!signal?.aborted) setPlaylists(res.playlists);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadPlaylists(controller.signal);
    return () => controller.abort();
  }, [loadPlaylists, reloadKey]);

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

        <QrAccessCard
          heading="QR Code do Controle Remoto"
          targets={accessTargets}
          qrSize={68}
          variant="host"
          publicUrlWarning={publicUrlWarning}
          onSelectMode={onSelectQrMode}
          onToggleMode={onToggleQrMode}
        />

        <MdnsHostnamePanel mdns={config?.mdns} onUpdated={onMdnsUpdated} onToast={onToast} />

        <HostPinPanel remoteUrl={qrUrl} onToast={onToast} onChanged={onChanged} />

        <GestureControlPanel
          settings={gestureSettings}
          status={gestureStatus}
          fps={gestureFps}
          delegate={gestureDelegate}
          onChange={onGestureSettingsChange}
        />

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

        <AutoDjPanel
          config={config}
          playlists={playlists}
          reloadKey={reloadKey}
          onDiscoverQueueVibe={onDiscoverQueueVibe}
          onToast={onToast}
          onChanged={onChanged}
          run={run}
        />

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

        <SpotifyAccountPanel spotify={config?.spotify} onChanged={onChanged} run={run} />

        <LibraryMaintenancePanel onCatalogChanged={onCatalogChanged} onOpenCatalog={onOpenCatalog} onDiscoverQueueVibe={onDiscoverQueueVibe} run={run}>
        {currentTrack && (
          <div className="mt-1 flex flex-col gap-2">
            <button
              type="button"
              onClick={onEditCurrentTrack}
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-left text-xs font-medium text-zinc-200 hover:bg-white/15"
            >
              ✎ Editar metadados da faixa atual ({currentTrack.title})
            </button>
            <button
              type="button"
              onClick={onAddCurrentToPlaylist}
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-left text-xs font-medium text-zinc-200 hover:bg-white/15"
            >
              + Playlist na faixa atual ({currentTrack.title})
            </button>
          </div>
        )}
        </LibraryMaintenancePanel>

        <PlaylistManagerPanel
          playlists={playlists}
          onChanged={() => {
            loadPlaylists();
            onCatalogChanged();
            onChanged();
          }}
          onToast={onToast}
          onOpenPlaylistsTab={onOpenPlaylistsTab}
        />

        <button
          type="button"
          onClick={onOpenGuestMode}
          className="rounded-xl border border-accent-2/35 bg-accent-2/10 px-4 py-2.5 text-left text-sm font-semibold text-accent-2 transition hover:bg-accent-2/20"
        >
          Abrir modo convidado nesta tela
        </button>
      </div>
    </div>
  );
}

export interface KioskGuestOverlayProps {
  open: boolean;
  dialogRef?: RefObject<HTMLDivElement | null>;
  onClose: () => void;
}

/** Full-screen Guest Mode drawer rendered over `<Kiosk />` without unmounting `<audio>` or `<video>`. */
export const KioskGuestOverlay = ({ open, dialogRef, onClose }: KioskGuestOverlayProps) => {
  if (!open) return null;
  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Modo convidado na TV"
      data-kiosk-scope="guest-remote"
      className="fixed inset-0 z-30 overflow-x-hidden overflow-y-auto bg-ink"
    >
      <Remote embedded onClose={onClose} />
    </div>
  );
};
