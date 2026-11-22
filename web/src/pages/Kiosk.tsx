import { QRCodeSVG } from 'qrcode.react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Cover } from '../components/Cover';
import { LyricsView } from '../components/LyricsView';
import { QueueList } from '../components/QueueList';
import { SourceBadge } from '../components/SourceBadge';
import { useToast } from '../components/Toast';
import { api, getHostPin, setHostPin } from '../lib/api';
import { cssImageUrl, formatTime, isLoopback, remoteUrl } from '../lib/format';
import type { AppConfig, QueueEntry } from '../lib/types';
import { useJukebox } from '../lib/useJukebox';
import { useTrackLyrics } from '../lib/useTrackLyrics';

type StageMode = 'cover' | 'lyrics';

const STAGE_MODE_KEY = 'jkbox.stageMode';
const STAGE_MODES: { id: StageMode; label: string }[] = [
  { id: 'cover', label: 'Capa' },
  { id: 'lyrics', label: 'Letra' },
];
const MAX_OFFSET_MS = 300_000;

export function Kiosk() {
  const { state, downloads, lyricsOffset, connected, send } = useJukebox();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState({ current: 0, duration: 0 });
  const [volume, setVolume] = useState(() => Number(localStorage.getItem('jkbox.volume') ?? 1));
  const [stageMode, setStageMode] = useState<StageMode>(() =>
    localStorage.getItem(STAGE_MODE_KEY) === 'lyrics' ? 'lyrics' : 'cover',
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [offsetBusy, setOffsetBusy] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const lastSent = useRef(0);
  const loadedFor = useRef<number | null>(null);
  const firstLoad = useRef(true);
  /** Position to restore after a reload; applied on `loadedmetadata` (setting it earlier is ignored). */
  const pendingSeek = useRef<number | null>(null);
  const pendingOffsetRef = useRef<number | null>(null);
  const toast = useToast();

  const nowPlaying = state.nowPlaying;
  const current = nowPlaying?.item;
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
      toast.show(spotify === 'connected' ? 'Spotify conectado! Playlist compartilhada pronta.' : `Spotify: ${params.get('message') ?? 'erro'}`, spotify !== 'connected');
      window.history.replaceState(null, '', '/');
    }
  }, [refreshConfig, toast.show]);

  // Load the current queue item into the <audio> element whenever it changes
  // (keyed by queue item, so the same song requested twice in a row still restarts).
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!current) {
      if (loadedFor.current !== null) {
        audio.removeAttribute('src');
        audio.load();
        setTime({ current: 0, duration: 0 });
      }
      loadedFor.current = null;
      return;
    }
    if (loadedFor.current === current.id) return;
    loadedFor.current = current.id;
    audio.src = api.streamUrl(current.trackId);
    // Resume where we were after a page reload.
    pendingSeek.current = firstLoad.current && nowPlaying && nowPlaying.positionSec > 0 ? nowPlaying.positionSec : null;
    firstLoad.current = false;
    if (unlocked) audio.play().catch(() => setPlaying(false));
  }, [current, nowPlaying, unlocked]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
    localStorage.setItem('jkbox.volume', String(volume));
  }, [volume]);

  useEffect(() => {
    localStorage.setItem(STAGE_MODE_KEY, stageMode);
  }, [stageMode]);

  useEffect(() => {
    pendingOffsetRef.current = null;
  }, [current?.trackId]);

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      const audio = audioRef.current;
      if (audio && !audio.paused) {
        setTime((prev) => ({
          current: audio.currentTime,
          duration: Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : prev.duration,
        }));
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [playing]);

  const reportProgress = (force = false) => {
    const audio = audioRef.current;
    if (!audio || !current) return;
    const now = Date.now();
    if (!force && now - lastSent.current < 1000) return;
    lastSent.current = now;
    send({ type: 'progress', queueId: current.id, positionSec: audio.currentTime, paused: audio.paused });
  };

  const unlock = () => {
    setUnlocked(true);
    audioRef.current?.play().catch(() => {});
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio || !current) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
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
  const progressPct = time.duration > 0 ? (time.current / time.duration) * 100 : 0;
  const backdrop = cssImageUrl(current?.track.thumbnail);

  return (
    // Mobile/tablet: natural page scroll so the QR code and queue stay reachable.
    // Desktop (lg+): fixed full-height split layout.
    <div className="relative flex min-h-full flex-col overflow-x-hidden lg:h-full lg:flex-row lg:overflow-hidden">
      {/* Blurred backdrop from the album art */}
      {backdrop && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute inset-0 scale-110 bg-cover bg-center opacity-25 blur-3xl" style={{ backgroundImage: backdrop }} />
        </div>
      )}

      <audio
        ref={audioRef}
        preload="auto"
        onPlay={() => {
          setPlaying(true);
          reportProgress(true);
        }}
        onPause={() => {
          setPlaying(false);
          reportProgress(true);
        }}
        onLoadedMetadata={(e) => {
          const seek = pendingSeek.current;
          pendingSeek.current = null;
          if (seek !== null && Number.isFinite(e.currentTarget.duration) && seek < e.currentTarget.duration) {
            e.currentTarget.currentTime = seek;
          }
        }}
        onTimeUpdate={(e) => {
          setTime({ current: e.currentTarget.currentTime, duration: e.currentTarget.duration || current?.track.durationSec || 0 });
          reportProgress();
        }}
        onEnded={() => current && api.ended(current.id).catch(() => {})}
        onError={() => {
          if (!current || !audioRef.current?.src) return;
          toast.show(`Não foi possível tocar "${current.track.title}". Pulando…`, true);
          const id = current.id;
          window.setTimeout(() => api.ended(id).catch(() => {}), 2000);
        }}
      />

      {/* Now playing */}
      <main className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-5 pb-8 pt-4 sm:px-8 lg:gap-5 lg:p-8 lg:pt-20">
        {/* In the flow on mobile/tablet (never overlaps the cover); pinned to the corners on desktop. */}
        <div className="flex w-full items-center justify-between gap-3 lg:absolute lg:inset-x-8 lg:top-6 lg:w-auto">
          <header className="flex items-center gap-3">
            <span className="text-2xl font-black tracking-tight">
              jkbox<span className="text-accent">studio</span>
            </span>
            <span className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-500'}`} title={connected ? 'online' : 'reconectando'} />
          </header>
          <button onClick={() => setSettingsOpen((v) => !v)} className="rounded-full bg-white/10 px-3 py-1 text-sm hover:bg-white/20">
            ⚙︎ Host
          </button>
        </div>

        {current ? (
          <>
            <div
              role="tablist"
              aria-label="Modo de visualização do palco"
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-white/10 bg-white/5 p-1 backdrop-blur"
            >
              {STAGE_MODES.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  role="tab"
                  aria-selected={stageMode === mode.id}
                  onClick={() => setStageMode(mode.id)}
                  className={`rounded-full px-4 py-1 text-xs font-semibold transition sm:text-sm ${
                    stageMode === mode.id ? 'bg-white text-zinc-900 shadow' : 'text-zinc-300 hover:text-white'
                  }`}
                >
                  {mode.label}
                </button>
              ))}
            </div>

            {stageMode === 'cover' ? (
              <>
                <Cover
                  src={current.track.thumbnail}
                  alt={current.track.title}
                  className="aspect-square w-[min(48vh,78vw)] rounded-3xl shadow-2xl shadow-black/60 lg:w-[min(52vh,80vw)]"
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
            ) : (
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
            )}

            <div className="w-full max-w-2xl shrink-0">
              <div className="h-2 overflow-hidden rounded-full bg-white/10">
                <div className="h-full bg-gradient-to-r from-accent to-accent-2 transition-[width] duration-300" style={{ width: `${progressPct}%` }} />
              </div>
              <div className="mt-1 flex justify-between text-xs text-zinc-400">
                <span>{formatTime(time.current)}</span>
                <span>{formatTime(time.duration || current.track.durationSec)}</span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-4">
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

      {/* Sidebar: QR + queue */}
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

      {settingsOpen && (
        <HostPanel
          config={config}
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
  onClose: () => void;
  onChanged: () => void;
  run: RunFn;
}

function HostPanel({ config, onClose, onChanged, run }: HostPanelProps) {
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
