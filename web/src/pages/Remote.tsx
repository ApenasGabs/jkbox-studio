import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Cover } from '../components/Cover';
import { LyricsView } from '../components/LyricsView';
import { QueueList } from '../components/QueueList';
import { SourceBadge } from '../components/SourceBadge';
import { useToast } from '../components/Toast';
import { api, getClientId, getName, type SearchSource, setName } from '../lib/api';
import { formatTime } from '../lib/format';
import type { AppConfig, QueueEntry, SearchResult } from '../lib/types';
import { useInterpolatedTime } from '../lib/useInterpolatedTime';
import { useJukebox } from '../lib/useJukebox';
import { useTrackLyrics } from '../lib/useTrackLyrics';

const TABS: { id: SearchSource; label: string }[] = [
  { id: 'all', label: 'Tudo' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'spotify', label: 'Spotify' },
  { id: 'local', label: 'Acervo' },
];

export function Remote() {
  const { state, position, downloads, lyricsOffset, connected } = useJukebox();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [view, setView] = useState<'search' | 'queue' | 'lyrics'>('search');
  const [name, setNameState] = useState(getName());
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<SearchSource>('all');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const toast = useToast();
  const me = getClientId();
  const current = state.nowPlaying?.item;
  const duration = current?.track.durationSec ?? 0;
  const livePositionSec = useInterpolatedTime(position, Boolean(current), connected, current?.track.durationSec);
  const { lyrics, loading: lyricsLoading, error: lyricsError, reload: reloadLyrics } = useTrackLyrics(
    current?.trackId,
    lyricsOffset,
  );

  useEffect(() => {
    api.config().then(setConfig).catch(() => {});
  }, []);

  const runSearch = async (q: string, src: SearchSource) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const res = src === 'local' && !q.trim() ? { ...(await api.library()), errors: {} } : await api.search(q, src, controller.signal);
      setResults(res.results);
      setErrors(res.errors);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') toast.show((err as Error).message, true);
    } finally {
      if (abortRef.current === controller) setLoading(false);
    }
  };

  // The local library can be browsed without typing anything.
  useEffect(() => {
    if (source === 'local') void runSearch(query, 'local');
  }, [source]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (query.trim() || source === 'local') void runSearch(query, source);
  };

  const add = async (result: SearchResult) => {
    const key = `${result.source}:${result.sourceId}`;
    setAdding(key);
    try {
      const outcome = await api.enqueue(result);
      toast.show(
        outcome.duplicate
          ? 'Essa já está na fila — seu pedido contou como voto 👍'
          : outcome.cached
            ? 'Adicionada! Já está no acervo, pronta para tocar ⚡'
            : 'Adicionada! Baixando em segundo plano…',
      );
    } catch (err) {
      toast.show((err as Error).message, true);
    } finally {
      setAdding(null);
    }
  };

  const vote = (entry: QueueEntry) => api.vote(entry.id).catch((err) => toast.show(err.message, true));
  const remove = (entry: QueueEntry) => api.remove(entry.id).catch((err) => toast.show(err.message, true));

  const tabs = TABS.filter((t) => t.id !== 'spotify' || config?.spotify.configured);

  return (
    <div className="mx-auto flex min-h-full max-w-xl flex-col pb-24">
      <header className="sticky top-0 z-20 flex flex-col gap-3 bg-ink/90 p-4 backdrop-blur">
        <div className="flex items-center justify-between">
          <span className="text-xl font-black tracking-tight">
            jkbox<span className="text-accent">studio</span>
          </span>
          <span className={`text-xs ${connected ? 'text-emerald-400' : 'text-red-400'}`}>{connected ? '● ao vivo' : '● reconectando'}</span>
        </div>

        {current && (
          <button
            type="button"
            onClick={() => setView('lyrics')}
            title="Abrir letra sincronizada"
            className="glass flex w-full items-center gap-3 p-2 text-left transition hover:bg-white/10"
          >
            <Cover src={current.track.thumbnail} alt={current.track.title} className="h-12 w-12 shrink-0 rounded-lg" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">
                {position.paused ? '⏸' : '▶'} {current.track.title}
              </p>
              <p className="truncate text-xs text-zinc-400">{current.track.artist}</p>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/10">
                <div className="h-full bg-accent" style={{ width: `${duration ? Math.min(100, (livePositionSec / duration) * 100) : 0}%` }} />
              </div>
            </div>
            <span className="shrink-0 text-xs text-zinc-400">{formatTime(livePositionSec)}</span>
          </button>
        )}

        <label className="flex items-center gap-2 text-sm">
          <span className="text-zinc-400">Seu nome:</span>
          <input
            value={name}
            onChange={(e) => {
              setNameState(e.target.value);
              setName(e.target.value);
            }}
            maxLength={40}
            placeholder="Convidado"
            className="min-w-0 flex-1 rounded-lg bg-white/10 px-3 py-1.5 outline-none focus:ring-2 focus:ring-accent"
          />
        </label>

        <div className="grid grid-cols-3 gap-1 rounded-xl bg-white/5 p-1 text-xs sm:text-sm" role="tablist" aria-label="Abas do controle remoto">
          {(
            [
              { id: 'search', label: '🔎 Buscar' },
              { id: 'queue', label: `🎶 Fila (${state.queue.length})` },
              { id: 'lyrics', label: '🎤 Letra' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={view === tab.id}
              onClick={() => setView(tab.id)}
              className={`truncate rounded-lg px-2 py-2 font-semibold transition ${
                view === tab.id ? 'bg-white text-zinc-900' : 'text-zinc-300 hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </header>

      {view === 'search' ? (
        <section className="flex flex-col gap-3 px-4">
          <form onSubmit={submit} className="flex gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Nome da música ou link do YouTube/Spotify"
              enterKeyHint="search"
              className="min-w-0 flex-1 rounded-xl bg-white/10 px-4 py-3 outline-none focus:ring-2 focus:ring-accent"
            />
            <button type="submit" className="rounded-xl bg-accent px-4 font-semibold disabled:opacity-50" disabled={loading}>
              {loading ? '…' : 'Buscar'}
            </button>
          </form>

          <div className="flex gap-2 overflow-x-auto">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setSource(tab.id)}
                className={`rounded-full px-3 py-1 text-sm ${source === tab.id ? 'bg-accent text-white' : 'bg-white/10 text-zinc-300'}`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {Object.entries(errors).map(([src, message]) => (
            <p key={src} className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {src}: {message}
            </p>
          ))}

          {loading && results.length === 0 && <p className="py-8 text-center text-sm text-zinc-500">Buscando…</p>}
          {!loading && results.length === 0 && (
            <p className="py-8 text-center text-sm text-zinc-500">
              Busque por nome ou cole um link do YouTube{config?.spotify.configured ? ' ou Spotify' : ''}.
            </p>
          )}

          <ul className="flex flex-col gap-2">
            {results.map((result) => {
              const key = `${result.source}:${result.sourceId}`;
              return (
                <li key={key} className="flex items-center gap-3 rounded-xl bg-white/5 p-2">
                  <Cover src={result.thumbnail} alt={result.title} className="h-14 w-14 shrink-0 rounded-lg" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{result.title}</p>
                    <p className="truncate text-xs text-zinc-400">
                      {result.artist || '—'} · {formatTime(result.durationSec)}
                    </p>
                    <div className="mt-1">
                      <SourceBadge source={result.source} cached={result.cached} />
                    </div>
                  </div>
                  <button
                    onClick={() => add(result)}
                    disabled={adding === key}
                    className="rounded-xl bg-white px-3 py-2 text-sm font-semibold text-zinc-900 disabled:opacity-50"
                  >
                    {adding === key ? '…' : '+ Fila'}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : view === 'queue' ? (
        <section className="px-4">
          <QueueList queue={state.queue} downloads={downloads} onVote={vote} onRemove={remove} canRemove={(e) => e.requesterId === me} />
        </section>
      ) : (
        <section className="px-4">
          {current ? (
            <LyricsView
              variant="remote"
              lyrics={lyrics}
              loading={lyricsLoading}
              error={lyricsError}
              currentTimeSec={livePositionSec}
              onRetry={reloadLyrics}
              className="h-[58dvh] min-h-[300px] max-h-[560px]"
            />
          ) : (
            <div className="glass flex flex-col items-center gap-3 px-6 py-12 text-center">
              <span className="text-4xl">🎤</span>
              <p className="font-semibold">Nenhuma música tocando agora</p>
              <p className="text-sm text-zinc-400">Peça uma música para acompanhar a letra sincronizada em tempo real.</p>
              <button
                type="button"
                onClick={() => setView('search')}
                className="mt-1 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white"
              >
                🔎 Buscar música
              </button>
            </div>
          )}
        </section>
      )}
      {toast.node}
    </div>
  );
}
