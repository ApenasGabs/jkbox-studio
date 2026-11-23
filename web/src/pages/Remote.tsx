import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { AddToPlaylistModal } from '../components/AddToPlaylistModal';
import { CatalogBrowser, type DiscoverSimilarRequest } from '../components/CatalogBrowser';
import { Cover } from '../components/Cover';
import { DiscoveryModal, type DiscoveryRequestContext } from '../components/DiscoveryModal';
import { GenreBadges } from '../components/GenreBadges';
import { LyricsView } from '../components/LyricsView';
import { MdnsHostnamePanel } from '../components/MdnsHostnamePanel';
import { PlaylistImportDetectedCard, PlaylistImportFeedback } from '../components/PlaylistImportBanner';
import { PlaylistManagerPanel } from '../components/PlaylistManagerPanel';
import { QueueList } from '../components/QueueList';
import { SourceBadge } from '../components/SourceBadge';
import { SpotifyConnectSelector } from '../components/SpotifyConnectSelector';
import { useToast } from '../components/Toast';
import { TrackMetadataModal } from '../components/TrackMetadataModal';
import { api, getClientId, getHostPin, getName, type SearchSource, setHostPin, setName } from '../lib/api';
import {
  buildDiscoveryContext,
  type CatalogRoute,
  type CatalogTab,
  DEFAULT_CATEGORY_SUGGESTIONS,
  type EditableTrack,
  editableFromResult,
  editableFromTrack,
  mergeCategorySuggestions,
  type PlaylistPickerTrack,
  playlistTrackFromResult,
  playlistTrackFromTrack,
} from '../lib/catalog';
import { formatTime } from '../lib/format';
import { applyKaraokeFilter } from '../lib/karaoke';
import {
  describePlaylistImportError,
  detectPlaylistLink,
  formatPlaylistImportSummary,
  type PlaylistImportErrorInfo,
} from '../lib/playlistImport';
import { describeSpotifyConnectError, formatSpotifyOutputBadge } from '../lib/spotifyConnect';
import {
  type AppConfig,
  type PlaylistImportResult,
  type PlaylistSummary,
  type QueueEntry,
  REACTION_EMOJIS,
  type ReactionEmoji,
  type SearchResult,
  type Track,
} from '../lib/types';
import { useInterpolatedTime } from '../lib/useInterpolatedTime';
import { useJukebox } from '../lib/useJukebox';
import { useTrackLyrics } from '../lib/useTrackLyrics';

const TABS: { id: SearchSource; label: string }[] = [
  { id: 'all', label: 'Tudo' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'spotify', label: 'Spotify' },
  { id: 'local', label: 'Acervo' },
];

function trackToSearchResult(track: Track): SearchResult {
  return {
    source: track.source,
    sourceId: track.sourceId,
    title: track.title,
    artist: track.artist,
    album: track.album,
    genre: track.genre,
    subgenre: track.subgenre,
    year: track.year,
    trackNumber: track.trackNumber,
    durationSec: track.durationSec,
    thumbnail: track.thumbnail,
    trackId: track.id,
    cached: track.status === 'ready',
  };
}

function formatPlayedAt(finishedAt: number | null | undefined): string | null {
  if (finishedAt == null || !Number.isFinite(finishedAt)) return null;
  const diffMin = Math.floor(Math.max(0, Date.now() - finishedAt) / 60_000);
  if (diffMin < 1) return 'agora';
  if (diffMin < 60) return `há ${diffMin} min`;
  return new Date(finishedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function Remote() {
  const { state, playbackOutput, position, downloads, lyricsOffset, mdns, setMdns, notice, connected, send } = useJukebox();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [view, setView] = useState<'search' | 'queue' | 'lyrics' | 'history'>('search');
  const [name, setNameState] = useState(getName());
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<SearchSource>('all');
  const [karaoke, setKaraoke] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [history, setHistory] = useState<QueueEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [lastReactionEmoji, setLastReactionEmoji] = useState<ReactionEmoji | null>(null);
  const [catalogTab, setCatalogTab] = useState<CatalogTab>('categories');
  const [catalogHistory, setCatalogHistory] = useState<CatalogRoute[]>([{ kind: 'root' }]);
  const [catalogFilter, setCatalogFilter] = useState('');
  const [catalogReloadKey, setCatalogReloadKey] = useState(0);
  const [categorySuggestions, setCategorySuggestions] = useState<string[]>([...DEFAULT_CATEGORY_SUGGESTIONS]);
  const [editingTrack, setEditingTrack] = useState<EditableTrack | null>(null);
  const [playlistPickerTrack, setPlaylistPickerTrack] = useState<PlaylistPickerTrack | null>(null);
  const [discoveryContext, setDiscoveryContext] = useState<DiscoveryRequestContext | null>(null);
  const [hostPlaylists, setHostPlaylists] = useState<PlaylistSummary[]>([]);
  const [importingPlaylist, setImportingPlaylist] = useState(false);
  const [importResult, setImportResult] = useState<PlaylistImportResult | null>(null);
  const [importError, setImportError] = useState<PlaylistImportErrorInfo | null>(null);
  const [hostVerified, setHostVerified] = useState(false);
  const [hostPinOpen, setHostPinOpen] = useState(false);
  const [hostPanelOpen, setHostPanelOpen] = useState(false);
  const [spotifyVolume, setSpotifyVolume] = useState(80);
  const [playbackBusy, setPlaybackBusy] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const reactionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const importingPlaylistRef = useRef(false);
  const toast = useToast();
  const me = getClientId();
  const current = state.nowPlaying?.item;
  const duration = current?.track.durationSec ?? 0;
  const livePositionSec = useInterpolatedTime(position, Boolean(current), connected, current?.track.durationSec);
  const queueRemainingSec = current ? (duration > 0 ? Math.max(0, duration - livePositionSec) : null) : 0;
  const { lyrics, loading: lyricsLoading, error: lyricsError, reload: reloadLyrics } = useTrackLyrics(
    current?.trackId,
    lyricsOffset,
  );
  const canEditMetadata = Boolean(config && (!config.hostPinRequired || hostVerified));
  const spotifyBadge = formatSpotifyOutputBadge(playbackOutput);
  const detectedPlaylist = detectPlaylistLink(query);

  useEffect(() => {
    api
      .config()
      .then((cfg) => {
        setConfig(cfg);
        if (cfg.hostPinRequired && getHostPin()) {
          api
            .verifyPin()
            .then(({ ok }) => setHostVerified(ok))
            .catch(() => setHostVerified(false));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setCatalogFilter(detectPlaylistLink(query) ? '' : query), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (notice) toast.show(notice.message, notice.error);
  }, [notice, toast.show]);

  useEffect(() => {
    return () => {
      if (reactionTimerRef.current) clearTimeout(reactionTimerRef.current);
    };
  }, []);

  const loadHostPlaylists = useCallback((signal?: AbortSignal) => {
    api
      .playlists(undefined, signal)
      .then((res) => {
        if (!signal?.aborted) setHostPlaylists(res.playlists);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!hostPanelOpen || !canEditMetadata) return;
    const controller = new AbortController();
    loadHostPlaylists(controller.signal);
    return () => controller.abort();
  }, [hostPanelOpen, canEditMetadata, catalogReloadKey, loadHostPlaylists]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const res = await api.history(30);
      setHistory(res.history);
    } catch (err) {
      setHistoryError((err as Error).message);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view === 'history') void loadHistory();
  }, [view, current?.id, loadHistory]);

  const sendReaction = (emoji: ReactionEmoji) => {
    if (!connected) return;
    const senderName = name.trim();
    send({
      type: 'reaction',
      emoji,
      ...(senderName ? { senderName } : {}),
      clientId: me,
    });
    setLastReactionEmoji(emoji);
    if (reactionTimerRef.current) clearTimeout(reactionTimerRef.current);
    reactionTimerRef.current = setTimeout(() => setLastReactionEmoji(null), 220);
  };

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

  // The local catalog handles its own fetching via CatalogBrowser.
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const detected = detectPlaylistLink(query);
    if (detected) {
      if (source === 'local') setCatalogFilter('');
      void importPlaylistByUrl(detected.url);
      return;
    }
    if (source === 'local') {
      setCatalogFilter(query);
      return;
    }
    if (query.trim()) void runSearch(applyKaraokeFilter(query, karaoke), source);
  };

  const toggleKaraoke = () => {
    const nextKaraoke = !karaoke;
    const nextSource: SearchSource = nextKaraoke && (source === 'spotify' || source === 'local') ? 'youtube' : source;
    setKaraoke(nextKaraoke);
    if (nextSource !== source) setSource(nextSource);
    if (nextSource !== 'local' && query.trim() && !detectPlaylistLink(query)) {
      void runSearch(applyKaraokeFilter(query, nextKaraoke), nextSource);
    }
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

  const addAlbum = async (items: SearchResult[], albumName: string) => {
    let addedCount = 0;
    let votedCount = 0;
    try {
      for (const item of items) {
        const outcome = await api.enqueue(item);
        if (outcome.duplicate) votedCount += 1;
        else addedCount += 1;
      }
      if (addedCount > 0) {
        toast.show(
          `${addedCount} música${addedCount === 1 ? '' : 's'} de "${albumName}" adicionada${addedCount === 1 ? '' : 's'} à fila ⚡`,
        );
      } else if (votedCount > 0) {
        toast.show(`As faixas de "${albumName}" já estavam na fila — votos registrados 👍`);
      }
    } catch (err) {
      toast.show((err as Error).message, true);
    }
  };

  const addPlaylistToQueue = async (playlist: PlaylistSummary, shuffle: boolean) => {
    try {
      const outcome = await api.enqueuePlaylist(playlist.id, { shuffle });
      if (outcome.total === 0) {
        toast.show(`A playlist "${playlist.name}" está vazia`, true);
        return;
      }
      if (outcome.enqueued > 0) {
        toast.show(
          `${outcome.enqueued} música${outcome.enqueued === 1 ? '' : 's'} de "${playlist.name}" adicionada${outcome.enqueued === 1 ? '' : 's'}${shuffle ? ' (embaralhadas)' : ''} ⚡`,
        );
      } else if (outcome.duplicates > 0) {
        toast.show(`As faixas de "${playlist.name}" já estavam na fila 👍`);
      }
    } catch (err) {
      toast.show((err as Error).message, true);
    }
  };

  const importPlaylistByUrl = async (rawUrl: string): Promise<boolean> => {
    if (importingPlaylistRef.current) return false;
    const trimmedUrl = rawUrl.trim();
    if (!trimmedUrl) return false;
    importingPlaylistRef.current = true;
    setImportingPlaylist(true);
    setImportError(null);
    setImportResult(null);
    try {
      const outcome = await api.importPlaylist(trimmedUrl);
      setImportResult(outcome);
      setQuery((prev) => (prev.trim() === trimmedUrl ? '' : prev));
      setCatalogFilter((prev) => (prev.trim() === trimmedUrl ? '' : prev));
      setCatalogReloadKey((k) => k + 1);
      toast.show(formatPlaylistImportSummary(outcome).toast);
      return true;
    } catch (err) {
      const info = describePlaylistImportError(err);
      setImportError(info);
      toast.show(info.message, true);
      return false;
    } finally {
      importingPlaylistRef.current = false;
      setImportingPlaylist(false);
    }
  };

  const openImportedPlaylist = (playlist: PlaylistSummary) => {
    setQuery('');
    setCatalogFilter('');
    setView('search');
    setSource('local');
    setCatalogTab('playlists');
    setCatalogHistory([{ kind: 'root' }, { kind: 'playlist', id: playlist.id, name: playlist.name }]);
  };

  const handleMetadataSaved = (updated: Track) => {
    toast.show(`Metadados de "${updated.title}" atualizados`);
    setCatalogReloadKey((k) => k + 1);
    setResults((prev) =>
      prev.map((item) => (item.trackId === updated.id ? { ...item, ...trackToSearchResult(updated) } : item)),
    );
    if (view === 'history') void loadHistory();
  };

  const submitHostPin = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = pinInput.trim();
    if (!trimmed) {
      setPinError('Digite o PIN do host.');
      return;
    }
    setPinBusy(true);
    setPinError(null);
    const previous = getHostPin();
    try {
      setHostPin(trimmed);
      const { ok } = await api.verifyPin();
      if (!ok) {
        setHostPin(previous);
        setPinError('PIN incorreto.');
        return;
      }
      setHostVerified(true);
      setHostPinOpen(false);
      setPinInput('');
      toast.show('Modo host ativado para organizar o catálogo');
    } catch (err) {
      setHostPin(previous);
      setPinError((err as Error).message);
    } finally {
      setPinBusy(false);
    }
  };

  const openDiscoverFromCatalog = useCallback((req: DiscoverSimilarRequest) => {
    setDiscoveryContext(buildDiscoveryContext(req));
  }, []);

  const vote = (entry: QueueEntry) => api.vote(entry.id).catch((err) => toast.show(err.message, true));
  const remove = (entry: QueueEntry) => api.remove(entry.id).catch((err) => toast.show(err.message, true));

  const tabs = TABS.filter((t) => t.id !== 'spotify' || config?.spotify.configured);

  return (
    <div className="mx-auto flex min-h-full max-w-3xl flex-col pb-24 lg:max-w-4xl">
      <header className="sticky top-0 z-20 flex flex-col gap-3 bg-ink/90 p-4 backdrop-blur">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xl font-black tracking-tight">
            jkbox<span className="text-accent">studio</span>
          </span>
          <div className="flex items-center gap-2">
            {canEditMetadata && (
              <button
                type="button"
                onClick={() => setHostPanelOpen(true)}
                title="Escolher onde tocar (Player Local ou Spotify Connect) e controles do host"
                className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition ${
                  spotifyBadge
                    ? 'border-green-400/50 bg-green-500/20 text-green-200 hover:bg-green-500/30'
                    : 'border-white/10 bg-white/5 text-zinc-200 hover:bg-white/15'
                }`}
              >
                {spotifyBadge ? '🔊 Spotify Connect' : '🎛 Saída'}
              </button>
            )}
            {config?.hostPinRequired && (
              <button
                type="button"
                onClick={() => {
                  if (hostVerified) {
                    setHostPin('');
                    setHostVerified(false);
                    setHostPanelOpen(false);
                    toast.show('Modo host bloqueado');
                  } else {
                    setPinInput('');
                    setPinError(null);
                    setHostPinOpen(true);
                  }
                }}
                title={hostVerified ? 'Modo host ativo (clique para bloquear)' : 'Entrar no modo host para editar metadados e escolher saída'}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition ${
                  hostVerified
                    ? 'border-accent/50 bg-accent/20 text-purple-100 hover:bg-accent/30'
                    : 'border-white/10 bg-white/5 text-zinc-300 hover:bg-white/15 hover:text-white'
                }`}
              >
                {hostVerified ? '🔓 Host' : '🔒 Host'}
              </button>
            )}
            <span className={`text-xs ${connected ? 'text-emerald-400' : 'text-red-400'}`}>{connected ? '● ao vivo' : '● reconectando'}</span>
          </div>
        </div>

        {current && (
          <div className="glass flex flex-col gap-2 p-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setView('lyrics')}
                title="Abrir letra sincronizada"
                className="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-0.5 text-left transition hover:bg-white/5"
              >
                <Cover src={current.track.thumbnail} alt={current.track.title} className="h-12 w-12 shrink-0 rounded-lg" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">
                    {position.paused ? '⏸' : '▶'} {current.track.title}
                  </p>
                  <p className="truncate text-xs text-zinc-400">{current.track.artist}</p>
                  {spotifyBadge && (
                    <p className="mt-0.5 truncate text-[11px] font-medium text-green-300">{spotifyBadge}</p>
                  )}
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full bg-accent" style={{ width: `${duration ? Math.min(100, (livePositionSec / duration) * 100) : 0}%` }} />
                  </div>
                </div>
                <span className="shrink-0 text-xs text-zinc-400">{formatTime(livePositionSec)}</span>
              </button>
              {canEditMetadata && (
                <button
                  type="button"
                  onClick={() => setPlaylistPickerTrack(playlistTrackFromTrack(current.track))}
                  aria-label={`Adicionar ${current.track.title} à playlist`}
                  title="Adicionar faixa tocando agora a uma playlist"
                  className="shrink-0 rounded-xl border border-white/10 bg-white/5 px-2.5 py-2 text-xs font-semibold text-zinc-200 transition hover:bg-white/15 hover:text-white"
                >
                  <span className="sm:hidden">+ PL</span>
                  <span className="hidden sm:inline">+ Playlist</span>
                </button>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-white/10 pt-1.5">
              <span className="pl-1 text-[11px] text-zinc-400">Reagir na TV</span>
              <div className="flex items-center gap-1" role="group" aria-label="Reações ao vivo">
                {REACTION_EMOJIS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    disabled={!connected}
                    aria-label={`Enviar reação ${emoji}`}
                    onClick={() => sendReaction(emoji)}
                    className={`rounded-lg px-2 py-1 text-base transition active:scale-90 disabled:opacity-40 ${
                      lastReactionEmoji === emoji ? 'scale-110 bg-accent/30' : 'bg-white/10 hover:bg-white/20'
                    }`}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          </div>
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

        <div className="grid grid-cols-4 gap-1 rounded-xl bg-white/5 p-1 text-[11px] sm:text-sm" role="tablist" aria-label="Abas do controle remoto">
          {(
            [
              { id: 'search', label: '🔎 Buscar' },
              { id: 'queue', label: `🎶 Fila (${state.queue.length})` },
              { id: 'lyrics', label: '🎤 Letra' },
              { id: 'history', label: '🕘 Histórico' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={view === tab.id}
              onClick={() => setView(tab.id)}
              className={`truncate rounded-lg px-1.5 py-2 font-semibold transition sm:px-2 ${
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
              placeholder={
                source === 'local'
                  ? 'Filtrar categorias, álbuns, artistas ou músicas…'
                  : 'Nome da música ou link do YouTube/Spotify'
              }
              enterKeyHint="search"
              className="min-w-0 flex-1 rounded-xl bg-white/10 px-4 py-3 outline-none focus:ring-2 focus:ring-accent"
            />
            <button type="submit" className="rounded-xl bg-accent px-4 font-semibold disabled:opacity-50" disabled={loading && source !== 'local'}>
              {loading && source !== 'local' ? '…' : 'Buscar'}
            </button>
          </form>

          {detectedPlaylist && (
            <PlaylistImportDetectedCard
              detected={detectedPlaylist}
              importing={importingPlaylist}
              onImport={() => void importPlaylistByUrl(detectedPlaylist.url)}
            />
          )}

          <div className="flex flex-wrap items-center gap-2">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setSource(tab.id)}
                className={`rounded-full px-3 py-1 text-sm ${source === tab.id ? 'bg-accent text-white' : 'bg-white/10 text-zinc-300'}`}
              >
                {tab.label}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={karaoke}
              onClick={toggleKaraoke}
              title="Adicionar filtro karaokê na busca do YouTube"
              className={`rounded-full border px-3 py-1 text-sm font-medium transition ${
                karaoke
                  ? 'border-accent bg-accent/25 text-white shadow-sm'
                  : 'border-white/10 bg-white/10 text-zinc-300 hover:bg-white/15 hover:text-white'
              }`}
            >
              🎤 Karaokê
            </button>
          </div>

          <PlaylistImportFeedback
            result={importResult}
            error={importError}
            onOpenPlaylist={openImportedPlaylist}
            onDismissResult={() => setImportResult(null)}
            onDismissError={() => setImportError(null)}
          />

          {source === 'local' ? (
            <CatalogBrowser
              tab={catalogTab}
              onTabChange={setCatalogTab}
              history={catalogHistory}
              onHistoryChange={setCatalogHistory}
              filterQuery={catalogFilter}
              onClearFilter={() => {
                setQuery('');
                setCatalogFilter('');
              }}
              karaoke={karaoke}
              reloadKey={catalogReloadKey}
              addingKey={adding}
              onAdd={add}
              onAddAlbum={addAlbum}
              onAddPlaylist={addPlaylistToQueue}
              onAddToPlaylist={setPlaylistPickerTrack}
              onDiscoverSimilar={canEditMetadata ? openDiscoverFromCatalog : undefined}
              onImportPlaylist={importPlaylistByUrl}
              importingPlaylist={importingPlaylist}
              canEditMetadata={canEditMetadata}
              canEnqueueAlbum={canEditMetadata}
              onEditTrack={setEditingTrack}
              onCategoriesLoaded={(cats) => setCategorySuggestions(mergeCategorySuggestions(cats))}
              onPlaylistsChanged={() => setCatalogReloadKey((k) => k + 1)}
              onToast={toast.show}
            />
          ) : (
            <>
              {Object.entries(errors).map(([src, message]) => (
                <p key={src} className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">
                  {src}: {message}
                </p>
              ))}

              {loading && results.length === 0 && <p className="py-8 text-center text-sm text-zinc-500">Buscando…</p>}
              {!loading && results.length === 0 && (
                <div className="flex flex-col items-center gap-3 py-8 text-center">
                  <p className="text-sm text-zinc-500">
                    Busque por nome ou cole um link do YouTube{config?.spotify.configured ? ' ou Spotify' : ''}.
                  </p>
                  <button
                    type="button"
                    onClick={() => setSource('local')}
                    className="rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-xs font-semibold text-zinc-200 transition hover:bg-white/15 hover:text-white"
                  >
                    📚 Explorar Acervo por Categorias, Álbuns e Artistas
                  </button>
                </div>
              )}

              <ul className="flex flex-col gap-2">
                {results.map((result) => {
                  const key = `${result.source}:${result.sourceId}`;
                  const editable = canEditMetadata ? editableFromResult(result) : null;
                  const playlistTrack = canEditMetadata && result.cached !== false ? playlistTrackFromResult(result) : null;
                  return (
                    <li key={key} className="flex items-center gap-3 rounded-xl bg-white/5 p-2">
                      <Cover src={result.thumbnail} alt={result.title} className="h-14 w-14 shrink-0 rounded-lg" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{result.title}</p>
                        <p className="truncate text-xs text-zinc-400">
                          {result.artist || '—'} · {formatTime(result.durationSec)}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <SourceBadge source={result.source} cached={result.cached} />
                          <GenreBadges genre={result.genre} subgenre={result.subgenre} />
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {editable && (
                          <button
                            type="button"
                            onClick={() => setEditingTrack(editable)}
                            aria-label={`Editar metadados de ${result.title}`}
                            title="Editar categoria, álbum ou metadados"
                            className="rounded-xl border border-white/10 bg-white/5 px-2.5 py-2 text-xs font-semibold text-zinc-300 transition hover:bg-white/15 hover:text-white"
                          >
                            ✎
                          </button>
                        )}
                        {playlistTrack && (
                          <button
                            type="button"
                            onClick={() => setPlaylistPickerTrack(playlistTrack)}
                            aria-label={`Adicionar ${result.title} à playlist`}
                            title="Adicionar à playlist"
                            className="rounded-xl border border-white/10 bg-white/5 px-2.5 py-2 text-xs font-semibold text-zinc-200 transition hover:bg-white/15 hover:text-white"
                          >
                            <span className="sm:hidden">+ PL</span>
                            <span className="hidden sm:inline">+ Playlist</span>
                          </button>
                        )}
                        <button
                          onClick={() => add(result)}
                          disabled={adding === key}
                          className="rounded-xl bg-white px-3 py-2 text-sm font-semibold text-zinc-900 disabled:opacity-50"
                        >
                          {adding === key ? '…' : '+ Fila'}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
      ) : view === 'queue' ? (
        <section className="px-4">
          <QueueList
            queue={state.queue}
            downloads={downloads}
            currentRemainingSec={queueRemainingSec}
            onVote={vote}
            onRemove={remove}
            canRemove={(e) => e.requesterId === me}
          />
        </section>
      ) : view === 'lyrics' ? (
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
      ) : (
        <section className="flex flex-col gap-3 px-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Já tocou</h2>
            <button
              type="button"
              onClick={() => void loadHistory()}
              disabled={historyLoading}
              className="rounded-lg bg-white/10 px-2.5 py-1 text-xs font-medium text-zinc-200 hover:bg-white/20 disabled:opacity-50"
            >
              {historyLoading ? 'Atualizando…' : 'Atualizar'}
            </button>
          </div>
          {historyError && (
            <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">{historyError}</p>
          )}
          {historyLoading && history.length === 0 ? (
            <p className="py-8 text-center text-sm text-zinc-500">Carregando histórico…</p>
          ) : history.length === 0 ? (
            <div className="glass flex flex-col items-center gap-3 px-6 py-12 text-center">
              <span className="text-4xl">🕘</span>
              <p className="font-semibold">Nenhuma música tocou ainda</p>
              <p className="text-sm text-zinc-400">As músicas finalizadas aparecem aqui para você pedir de novo com 1 toque.</p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {history.map((entry) => {
                const key = `${entry.track.source}:${entry.track.sourceId}`;
                const playedAt = formatPlayedAt(entry.finishedAt);
                return (
                  <li key={entry.id} className="flex items-center gap-3 rounded-xl bg-white/5 p-2">
                    <Cover src={entry.track.thumbnail} alt={entry.track.title} className="h-12 w-12 shrink-0 rounded-lg" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{entry.track.title}</p>
                      <p className="truncate text-xs text-zinc-400">
                        {entry.track.artist || '—'} · {formatTime(entry.track.durationSec)} · por {entry.requesterName}
                        {playedAt ? ` · ${playedAt}` : ''}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <SourceBadge source={entry.track.source} cached={entry.track.status === 'ready'} />
                        <GenreBadges genre={entry.track.genre} subgenre={entry.track.subgenre} />
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {canEditMetadata && entry.track.status === 'ready' && (
                        <>
                          <button
                            type="button"
                            onClick={() => setEditingTrack(editableFromTrack(entry.track))}
                            aria-label={`Editar metadados de ${entry.track.title}`}
                            title="Editar categoria, álbum ou metadados"
                            className="rounded-xl border border-white/10 bg-white/5 px-2.5 py-2 text-xs font-semibold text-zinc-300 transition hover:bg-white/15 hover:text-white"
                          >
                            ✎
                          </button>
                          <button
                            type="button"
                            onClick={() => setPlaylistPickerTrack(playlistTrackFromTrack(entry.track))}
                            aria-label={`Adicionar ${entry.track.title} à playlist`}
                            title="Adicionar à playlist"
                            className="rounded-xl border border-white/10 bg-white/5 px-2.5 py-2 text-xs font-semibold text-zinc-200 transition hover:bg-white/15 hover:text-white"
                          >
                            <span className="sm:hidden">+ PL</span>
                            <span className="hidden sm:inline">+ Playlist</span>
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => void add(trackToSearchResult(entry.track))}
                        disabled={adding === key}
                        className="shrink-0 rounded-xl bg-white px-3 py-2 text-sm font-semibold text-zinc-900 disabled:opacity-50"
                      >
                        {adding === key ? '…' : '+ Fila'}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
      {hostPinOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={() => !pinBusy && setHostPinOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="host-pin-title"
            onClick={(e) => e.stopPropagation()}
            className="flex w-full max-w-sm flex-col gap-3 rounded-3xl border border-white/15 bg-panel p-5 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h2 id="host-pin-title" className="text-base font-bold">
                Modo host
              </h2>
              <button
                type="button"
                onClick={() => setHostPinOpen(false)}
                disabled={pinBusy}
                className="rounded-lg px-2 py-1 text-zinc-400 hover:bg-white/10 hover:text-white"
              >
                ✕
              </button>
            </div>
            <p className="text-xs text-zinc-400">
              Informe o PIN do host para editar categorias, álbuns, metadados e escolher o dispositivo de áudio.
            </p>
            <form onSubmit={submitHostPin} className="flex flex-col gap-3">
              <input
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value)}
                type="password"
                inputMode="numeric"
                autoFocus
                placeholder="PIN do host"
                className="rounded-xl bg-white/10 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-accent"
              />
              {pinError && <p className="rounded-lg bg-red-500/15 px-3 py-1.5 text-xs text-red-200">{pinError}</p>}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setHostPinOpen(false)}
                  disabled={pinBusy}
                  className="rounded-xl bg-white/10 px-3 py-2 text-xs font-semibold hover:bg-white/20"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={pinBusy}
                  className="rounded-xl bg-accent px-4 py-2 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-50"
                >
                  {pinBusy ? 'Verificando…' : 'Desbloquear'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {hostPanelOpen && canEditMetadata && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={() => setHostPanelOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="remote-host-panel-title"
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[85vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-3xl border border-white/15 bg-panel p-5 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h2 id="remote-host-panel-title" className="text-base font-bold">
                Saída de áudio e Playback
              </h2>
              <button
                type="button"
                onClick={() => setHostPanelOpen(false)}
                aria-label="Fechar controles do host"
                className="rounded-lg px-2 py-1 text-zinc-400 hover:bg-white/10 hover:text-white"
              >
                ✕
              </button>
            </div>

            {current && (
              <div className="glass flex flex-col gap-2 p-3">
                <p className="truncate text-xs text-zinc-400">
                  Tocando agora: <span className="font-semibold text-white">{current.track.title}</span>
                </p>
                <div className="flex items-center gap-2">
                  {playbackOutput.type === 'spotify' && (
                    <button
                      type="button"
                      disabled={playbackBusy}
                      onClick={() => {
                        setPlaybackBusy(true);
                        void (position.paused ? api.spotifyResume() : api.spotifyPause())
                          .catch((err) => toast.show(describeSpotifyConnectError(err).message, true))
                          .finally(() => setPlaybackBusy(false));
                      }}
                      className="flex-1 rounded-xl bg-white px-3 py-2 text-xs font-semibold text-zinc-900 disabled:opacity-50"
                    >
                      {position.paused ? '▶ Tocar no Spotify' : '❚❚ Pausar Spotify'}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={playbackBusy}
                    onClick={() => {
                      setPlaybackBusy(true);
                      void api
                        .skip()
                        .catch((err) => toast.show(describeSpotifyConnectError(err).message, true))
                        .finally(() => setPlaybackBusy(false));
                    }}
                    className="flex-1 rounded-xl bg-white/10 px-3 py-2 text-xs font-semibold text-white hover:bg-white/20 disabled:opacity-50"
                  >
                    ⏭ Pular faixa
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setHostPanelOpen(false);
                    setPlaylistPickerTrack(playlistTrackFromTrack(current.track));
                  }}
                  className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-left text-xs font-medium text-zinc-200 hover:bg-white/15"
                >
                  + Playlist na faixa atual ({current.track.title})
                </button>
              </div>
            )}

            <SpotifyConnectSelector
              config={config}
              playbackOutput={playbackOutput}
              volume={spotifyVolume}
              onVolumeChange={setSpotifyVolume}
              onToast={toast.show}
            />

            <section className="glass flex flex-col gap-2 p-3">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold">Descoberta inteligente</h3>
                <p className="text-xs text-zinc-400">
                  Sugira e adicione músicas na mesma vibe das últimas faixas tocadas sem bloquear a fila.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setHostPanelOpen(false);
                  setDiscoveryContext(buildDiscoveryContext({ mode: 'vibe' }));
                }}
                className="rounded-xl border border-accent/40 bg-accent/20 px-3 py-2 text-xs font-semibold text-purple-100 transition hover:bg-accent/30"
              >
                ✨ Completar fila na vibe atual
              </button>
            </section>

            <PlaylistManagerPanel
              playlists={hostPlaylists}
              onChanged={() => {
                loadHostPlaylists();
                setCatalogReloadKey((k) => k + 1);
              }}
              onToast={toast.show}
              onOpenPlaylistsTab={() => {
                setHostPanelOpen(false);
                setView('search');
                setSource('local');
                setCatalogTab('playlists');
                setCatalogHistory([{ kind: 'root' }]);
              }}
            />
            <MdnsHostnamePanel
              mdns={mdns ?? config?.mdns}
              onUpdated={(nextMdns) => {
                setMdns(nextMdns);
                setConfig((prev) => (prev ? { ...prev, mdns: nextMdns } : prev));
              }}
              onToast={toast.show}
            />
          </div>
        </div>
      )}
      <TrackMetadataModal
        track={editingTrack}
        categorySuggestions={categorySuggestions}
        onClose={() => setEditingTrack(null)}
        onSaved={handleMetadataSaved}
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
      />
      {toast.node}
    </div>
  );
}
