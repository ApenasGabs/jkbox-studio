import { QRCodeSVG } from 'qrcode.react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Cover } from '../components/Cover';
import { QueueList } from '../components/QueueList';
import { SourceBadge } from '../components/SourceBadge';
import { useToast } from '../components/Toast';
import { api, getHostPin, setHostPin } from '../lib/api';
import { formatTime, isLoopback, remoteUrl } from '../lib/format';
import type { AppConfig, QueueEntry } from '../lib/types';
import { useJukebox } from '../lib/useJukebox';

export function Kiosk() {
  const { state, downloads, connected, send } = useJukebox();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState({ current: 0, duration: 0 });
  const [volume, setVolume] = useState(() => Number(localStorage.getItem('jkbox.volume') ?? 1));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const lastSent = useRef(0);
  const loadedFor = useRef<number | null>(null);
  const firstLoad = useRef(true);
  const toast = useToast();

  const nowPlaying = state.nowPlaying;
  const current = nowPlaying?.item;

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
    if (firstLoad.current && nowPlaying && nowPlaying.positionSec > 0) audio.currentTime = nowPlaying.positionSec;
    firstLoad.current = false;
    if (unlocked) audio.play().catch(() => setPlaying(false));
  }, [current, nowPlaying, unlocked]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
    localStorage.setItem('jkbox.volume', String(volume));
  }, [volume]);

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
  const url = remoteUrl(config?.publicUrl ?? null);
  const progressPct = time.duration > 0 ? (time.current / time.duration) * 100 : 0;

  return (
    <div className="relative flex h-full flex-col overflow-hidden lg:flex-row">
      {/* Blurred backdrop from the album art */}
      {current?.track.thumbnail && (
        <div
          className="pointer-events-none absolute inset-0 scale-110 bg-cover bg-center opacity-25 blur-3xl"
          style={{ backgroundImage: `url(${current.track.thumbnail})` }}
        />
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
      <main className="relative z-10 flex flex-1 flex-col items-center justify-center gap-6 p-8">
        <header className="absolute left-8 top-6 flex items-center gap-3">
          <span className="text-2xl font-black tracking-tight">
            jkbox<span className="text-accent">studio</span>
          </span>
          <span className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-500'}`} title={connected ? 'online' : 'reconectando'} />
        </header>
        <button
          onClick={() => setSettingsOpen((v) => !v)}
          className="absolute right-8 top-6 rounded-full bg-white/10 px-3 py-1 text-sm hover:bg-white/20"
        >
          ⚙︎ Host
        </button>

        {current ? (
          <>
            <Cover src={current.track.thumbnail} alt={current.track.title} className="aspect-square w-[min(60vh,80vw)] rounded-3xl shadow-2xl shadow-black/60" />
            <div className="max-w-3xl text-center">
              <h1 className="text-4xl font-bold leading-tight lg:text-5xl">{current.track.title}</h1>
              <p className="mt-2 text-xl text-zinc-300">{current.track.artist}</p>
              <div className="mt-3 flex items-center justify-center gap-2 text-sm text-zinc-400">
                <SourceBadge source={current.track.source} />
                <span>pedido por {current.requesterName}</span>
              </div>
            </div>
            <div className="w-full max-w-2xl">
              <div className="h-2 overflow-hidden rounded-full bg-white/10">
                <div className="h-full bg-gradient-to-r from-accent to-accent-2 transition-[width] duration-300" style={{ width: `${progressPct}%` }} />
              </div>
              <div className="mt-1 flex justify-between text-xs text-zinc-400">
                <span>{formatTime(time.current)}</span>
                <span>{formatTime(time.duration || current.track.durationSec)}</span>
              </div>
            </div>
            <div className="flex items-center gap-4">
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
      <aside className="relative z-10 flex w-full flex-col gap-4 border-white/10 bg-black/30 p-6 lg:w-[420px] lg:border-l">
        <div className="glass flex items-center gap-4 p-4">
          <div className="rounded-xl bg-white p-2">
            <QRCodeSVG value={url} size={112} />
          </div>
          <div className="min-w-0">
            <p className="font-semibold">Peça sua música 📱</p>
            <p className="break-all text-sm text-accent-2">{url}</p>
            {isLoopback(url) && (
              <p className="mt-1 text-xs text-amber-300">Defina PUBLIC_URL com o IP da rede para os celulares acessarem.</p>
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-zinc-400">Próximas ({state.queue.length})</h2>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
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
          className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-ink/90 text-center backdrop-blur"
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
  const spotify = config?.spotify;

  return (
    <div className="absolute inset-0 z-30 flex justify-end bg-black/50" onClick={onClose}>
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
