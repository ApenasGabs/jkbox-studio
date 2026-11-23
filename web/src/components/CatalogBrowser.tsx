import { type FormEvent, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import {
  type CatalogRoute,
  type CatalogTab,
  type DiscoverSimilarRequest,
  type EditableTrack,
  editableFromResult,
  formatAlbumCount,
  formatAlbumMeta,
  formatTrackCount,
  getCategoryTheme,
  type PlaylistPickerTrack,
  playlistTrackFromResult,
  splitUncategorizedTracks,
} from '../lib/catalog';
import { formatTime } from '../lib/format';
import { applyKaraokeFilter } from '../lib/karaoke';
import type {
  CatalogAlbum,
  CatalogArtist,
  CatalogArtistDetail,
  CatalogCategory,
  CatalogSubcategory,
  PlaylistDetail,
  PlaylistSummary,
  SearchResult,
} from '../lib/types';
import { Cover } from './Cover';
import { SourceBadge } from './SourceBadge';

const SUB_TABS: { id: CatalogTab; label: string }[] = [
  { id: 'categories', label: 'Categorias' },
  { id: 'playlists', label: 'Playlists' },
  { id: 'albums', label: 'Álbuns' },
  { id: 'artists', label: 'Artistas' },
  { id: 'all', label: 'Todas' },
];

export type { DiscoverSimilarRequest };

interface Props {
  tab: CatalogTab;
  onTabChange: (tab: CatalogTab) => void;
  history: CatalogRoute[];
  onHistoryChange: (next: CatalogRoute[]) => void;
  filterQuery?: string;
  onClearFilter?: () => void;
  karaoke?: boolean;
  reloadKey: number;
  addingKey: string | null;
  onAdd: (result: SearchResult) => void;
  onAddAlbum?: (results: SearchResult[], albumName: string) => Promise<void>;
  onAddPlaylist?: (playlist: PlaylistSummary, shuffle: boolean) => Promise<void>;
  onAddToPlaylist?: (track: PlaylistPickerTrack) => void;
  onDiscoverSimilar?: (req: DiscoverSimilarRequest) => void;
  onImportPlaylist?: (url: string) => Promise<boolean>;
  importingPlaylist?: boolean;
  canEditMetadata: boolean;
  canEnqueueAlbum?: boolean;
  onEditTrack: (track: EditableTrack) => void;
  onCategoriesLoaded?: (categories: CatalogCategory[]) => void;
  onPlaylistsLoaded?: (playlists: PlaylistSummary[]) => void;
  onPlaylistsChanged?: () => void;
  onToast?: (message: string, error?: boolean) => void;
}

export function CatalogBrowser({
  tab,
  onTabChange,
  history,
  onHistoryChange,
  filterQuery = '',
  onClearFilter,
  karaoke = false,
  reloadKey,
  addingKey,
  onAdd,
  onAddAlbum,
  onAddPlaylist,
  onAddToPlaylist,
  onDiscoverSimilar,
  onImportPlaylist,
  importingPlaylist = false,
  canEditMetadata,
  canEnqueueAlbum = false,
  onEditTrack,
  onCategoriesLoaded,
  onPlaylistsLoaded,
  onPlaylistsChanged,
  onToast,
}: Props) {
  const route = history[history.length - 1] ?? { kind: 'root' };
  const normalizedFilter = filterQuery.trim().toLowerCase();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingAlbum, setAddingAlbum] = useState(false);
  const [addingPlaylistMode, setAddingPlaylistMode] = useState<'order' | 'shuffle' | null>(null);
  const [creatingPlaylistOpen, setCreatingPlaylistOpen] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [newPlaylistDesc, setNewPlaylistDesc] = useState('');
  const [importingPlaylistOpen, setImportingPlaylistOpen] = useState(false);
  const [importPlaylistUrl, setImportPlaylistUrl] = useState('');
  const [playlistBusy, setPlaylistBusy] = useState(false);
  const [editingPlaylistOpen, setEditingPlaylistOpen] = useState(false);
  const [editPlaylistName, setEditPlaylistName] = useState('');
  const [editPlaylistDesc, setEditPlaylistDesc] = useState('');
  const [confirmDeletePlaylist, setConfirmDeletePlaylist] = useState(false);
  const [removingTrackId, setRemovingTrackId] = useState<string | null>(null);

  const [categories, setCategories] = useState<CatalogCategory[]>([]);
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [uncategorized, setUncategorized] = useState<{ count: number; cover: string | null; tracks: SearchResult[] }>({
    count: 0,
    cover: null,
    tracks: [],
  });
  const [albums, setAlbums] = useState<CatalogAlbum[]>([]);
  const [artists, setArtists] = useState<CatalogArtist[]>([]);
  const [allTracks, setAllTracks] = useState<SearchResult[]>([]);
  const [detailTracks, setDetailTracks] = useState<SearchResult[]>([]);
  const [detailSubcategories, setDetailSubcategories] = useState<CatalogSubcategory[]>([]);
  const [artistDetail, setArtistDetail] = useState<CatalogArtistDetail | null>(null);
  const [playlistDetail, setPlaylistDetail] = useState<PlaylistDetail | null>(null);
  const prevCategoryKeyRef = useRef<string | null>(null);

  const pushRoute = (next: CatalogRoute) => onHistoryChange([...history, next]);
  const replaceTopRoute = (next: CatalogRoute) => {
    if (history.length <= 1) onHistoryChange([next]);
    else onHistoryChange([...history.slice(0, -1), next]);
  };
  const goBack = () => {
    if (history.length > 1) onHistoryChange(history.slice(0, -1));
    else onHistoryChange([{ kind: 'root' }]);
  };

  useEffect(() => {
    const categoryKey = route.kind === 'category' ? (route.uncategorized ? '__uncategorized__' : route.name) : null;
    if (prevCategoryKeyRef.current !== categoryKey) {
      prevCategoryKeyRef.current = categoryKey;
      setDetailSubcategories([]);
      if (route.kind === 'category') setDetailTracks([]);
    }
    if (route.kind === 'root' && (tab === 'albums' || tab === 'all')) return;

    const controller = new AbortController();
    const { signal } = controller;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        if (route.kind === 'category') {
          if (route.uncategorized) {
            const lib = await api.library('', signal);
            setDetailSubcategories([]);
            setDetailTracks(splitUncategorizedTracks(lib.results).tracks);
          } else {
            const res = await api.catalogCategoryTracks(route.name, route.subgenre ?? null, signal);
            setDetailSubcategories(res.subcategories ?? []);
            setDetailTracks(res.tracks);
          }
          return;
        }

        if (route.kind === 'album') {
          const res = await api.catalogAlbumTracks(route.name, route.artist, signal);
          setDetailTracks(res.tracks);
          return;
        }

        if (route.kind === 'artist') {
          setArtistDetail(null);
          const res = await api.catalogArtist(route.name, signal);
          setArtistDetail(res);
          return;
        }

        if (route.kind === 'playlist') {
          setPlaylistDetail(null);
          setEditingPlaylistOpen(false);
          setConfirmDeletePlaylist(false);
          const res = await api.playlist(route.id, signal);
          setPlaylistDetail(res);
          return;
        }

        // Root sub-tabs with local filtering
        if (tab === 'categories') {
          const [catRes, libRes] = await Promise.all([api.catalogCategories(signal), api.library('', signal)]);
          const uncat = splitUncategorizedTracks(libRes.results);
          setCategories(catRes.categories);
          setUncategorized({ count: uncat.tracks.length, cover: uncat.cover, tracks: uncat.tracks });
          onCategoriesLoaded?.(catRes.categories);
        } else if (tab === 'playlists') {
          const res = await api.playlists(undefined, signal);
          setPlaylists(res.playlists);
          onPlaylistsLoaded?.(res.playlists);
        } else if (tab === 'artists') {
          const res = await api.catalogArtists(signal);
          setArtists(res.artists);
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError((err as Error).message);
        }
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    };

    void load();
    return () => controller.abort();
  }, [route, tab, reloadKey]);

  useEffect(() => {
    if (route.kind !== 'root' || (tab !== 'albums' && tab !== 'all')) return;
    const controller = new AbortController();
    const { signal } = controller;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        if (tab === 'albums') {
          const res = await api.catalogAlbums({ q: filterQuery }, signal);
          setAlbums(res.albums);
        } else {
          const q = karaoke ? applyKaraokeFilter(filterQuery, true) : filterQuery;
          const res = await api.library(q, signal);
          setAllTracks(res.results);
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError((err as Error).message);
        }
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    };

    void load();
    return () => controller.abort();
  }, [route.kind, tab, filterQuery, karaoke, reloadKey]);

  const filterTracksLocally = (items: SearchResult[]) => {
    if (!normalizedFilter) return items;
    return items.filter((item) =>
      [item.title, item.artist, item.album ?? '', item.genre ?? '', item.subgenre ?? ''].some((v) =>
        v.toLowerCase().includes(normalizedFilter),
      ),
    );
  };

  const handleCreatePlaylist = async (e: FormEvent) => {
    e.preventDefault();
    const name = newPlaylistName.trim();
    if (!name) {
      onToast?.('Informe o nome da playlist', true);
      return;
    }
    setPlaylistBusy(true);
    try {
      const created = await api.createPlaylist({ name, description: newPlaylistDesc.trim() || null });
      setNewPlaylistName('');
      setNewPlaylistDesc('');
      setCreatingPlaylistOpen(false);
      onToast?.(`Playlist "${created.name}" criada`);
      onPlaylistsChanged?.();
      pushRoute({ kind: 'playlist', id: created.id, name: created.name });
    } catch (err) {
      onToast?.((err as Error).message, true);
    } finally {
      setPlaylistBusy(false);
    }
  };

  const handleImportPlaylistForm = async (e: FormEvent) => {
    e.preventDefault();
    if (!onImportPlaylist || importingPlaylist) return;
    const url = importPlaylistUrl.trim();
    if (!url) {
      onToast?.('Cole o link da playlist do YouTube ou Spotify', true);
      return;
    }
    const ok = await onImportPlaylist(url);
    if (ok) {
      setImportPlaylistUrl('');
      setImportingPlaylistOpen(false);
    }
  };

  const handleSavePlaylistEdit = async (e: FormEvent) => {
    e.preventDefault();
    if (!playlistDetail) return;
    const name = editPlaylistName.trim();
    if (!name) {
      onToast?.('Informe o nome da playlist', true);
      return;
    }
    setPlaylistBusy(true);
    try {
      const updated = await api.updatePlaylist(playlistDetail.id, {
        name,
        description: editPlaylistDesc.trim() || null,
      });
      setPlaylistDetail((prev) => (prev ? { ...prev, ...updated } : prev));
      setEditingPlaylistOpen(false);
      onToast?.(`Playlist "${updated.name}" atualizada`);
      onPlaylistsChanged?.();
    } catch (err) {
      onToast?.((err as Error).message, true);
    } finally {
      setPlaylistBusy(false);
    }
  };

  const handleDeletePlaylist = async () => {
    if (!playlistDetail) return;
    setPlaylistBusy(true);
    try {
      await api.deletePlaylist(playlistDetail.id);
      onToast?.(`Playlist "${playlistDetail.name}" excluída`);
      setConfirmDeletePlaylist(false);
      onPlaylistsChanged?.();
      goBack();
    } catch (err) {
      onToast?.((err as Error).message, true);
    } finally {
      setPlaylistBusy(false);
    }
  };

  const handleRemoveFromPlaylist = async (playlistId: string, result: SearchResult) => {
    if (!result.trackId) return;
    setRemovingTrackId(result.trackId);
    try {
      await api.removeTrackFromPlaylist(playlistId, result.trackId);
      setPlaylistDetail((prev) => {
        if (!prev || prev.id !== playlistId) return prev;
        const nextTracks = prev.tracks.filter((t) => t.trackId !== result.trackId);
        return {
          ...prev,
          trackCount: nextTracks.length,
          cover: nextTracks.find((t) => Boolean(t.thumbnail))?.thumbnail ?? null,
          tracks: nextTracks,
        };
      });
      onToast?.(`"${result.title}" removida da playlist`);
      onPlaylistsChanged?.();
    } catch (err) {
      onToast?.((err as Error).message, true);
    } finally {
      setRemovingTrackId(null);
    }
  };

  const renderTrackRow = (result: SearchResult, index?: number, showTrackNumber = false, removePlaylistId?: string) => {
    const key = `${result.source}:${result.sourceId}`;
    const editable = canEditMetadata ? editableFromResult(result) : null;
    const playlistTrack = canEditMetadata && onAddToPlaylist ? playlistTrackFromResult(result) : null;
    const orderNum = showTrackNumber
      ? removePlaylistId
        ? index != null
          ? index + 1
          : null
        : (result.trackNumber ?? (index != null ? index + 1 : null))
      : null;

    return (
      <li key={key} className="flex items-center gap-2.5 rounded-xl bg-white/5 p-2 sm:gap-3">
        {showTrackNumber ? (
          <span className="w-6 shrink-0 text-right text-xs font-semibold tabular-nums text-zinc-500">
            {orderNum ?? '—'}
          </span>
        ) : (
          <Cover src={result.thumbnail} alt={result.title} className="h-12 w-12 shrink-0 rounded-lg" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{result.title}</p>
          <p className="truncate text-xs text-zinc-400">
            {result.artist || '—'}
            {!showTrackNumber && result.album ? ` · ${result.album}` : ''}
            {' · '}
            {formatTime(result.durationSec)}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <SourceBadge source={result.source} cached={result.cached} />
            {result.genre && (
              <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-medium text-zinc-300">
                {result.genre}
              </span>
            )}
            {result.subgenre && (
              <span className="rounded-full border border-accent/30 bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-purple-200">
                {result.subgenre}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {editable && (
            <button
              type="button"
              onClick={() => onEditTrack(editable)}
              aria-label={`Editar metadados de ${result.title}`}
              title="Editar categoria, álbum ou metadados"
              className="rounded-xl border border-white/10 bg-white/5 px-2 py-2 text-xs font-semibold text-zinc-300 transition hover:bg-white/15 hover:text-white"
            >
              ✎
            </button>
          )}
          {playlistTrack && !removePlaylistId && (
            <button
              type="button"
              onClick={() => onAddToPlaylist?.(playlistTrack)}
              aria-label={`Adicionar ${result.title} à playlist`}
              title="Adicionar à playlist"
              className="rounded-xl border border-white/10 bg-white/5 px-2.5 py-2 text-xs font-semibold text-zinc-200 transition hover:bg-white/15 hover:text-white"
            >
              <span className="sm:hidden">+ PL</span>
              <span className="hidden sm:inline">+ Playlist</span>
            </button>
          )}
          {removePlaylistId && canEditMetadata && result.trackId && (
            <button
              type="button"
              disabled={removingTrackId === result.trackId}
              onClick={() => void handleRemoveFromPlaylist(removePlaylistId, result)}
              aria-label={`Remover ${result.title} da playlist`}
              title="Remover desta playlist"
              className="rounded-xl border border-red-400/25 bg-red-500/10 px-2.5 py-2 text-xs font-semibold text-red-200 transition hover:bg-red-500/25 disabled:opacity-50"
            >
              {removingTrackId === result.trackId ? '…' : '✕'}
            </button>
          )}
          <button
            type="button"
            onClick={() => onAdd(result)}
            disabled={addingKey === key}
            className="rounded-xl bg-white px-3 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-200 disabled:opacity-50"
          >
            {addingKey === key ? '…' : '+ Fila'}
          </button>
        </div>
      </li>
    );
  };

  const renderBreadcrumb = (title: string, trail: string) => (
    <div className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          data-kiosk-default={route.kind !== 'root' ? 'true' : undefined}
          onClick={goBack}
          className="shrink-0 rounded-xl border border-white/10 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-white/20"
        >
          ← Voltar
        </button>
        <div className="min-w-0">
          <p className="truncate text-[11px] uppercase tracking-wider text-zinc-400">{trail}</p>
          <h3 className="truncate text-base font-bold">{title}</h3>
        </div>
      </div>
    </div>
  );

  const visibleCategories = normalizedFilter
    ? categories.filter((c) => c.name.toLowerCase().includes(normalizedFilter))
    : categories;
  const visiblePlaylists = normalizedFilter
    ? playlists.filter(
        (p) =>
          p.name.toLowerCase().includes(normalizedFilter) ||
          (p.description?.toLowerCase().includes(normalizedFilter) ?? false),
      )
    : playlists;
  const showUncategorized =
    uncategorized.count > 0 && (!normalizedFilter || 'sem categoria'.includes(normalizedFilter));

  const visibleArtists = normalizedFilter
    ? artists.filter((a) => a.name.toLowerCase().includes(normalizedFilter))
    : artists;

  const activeAlbumSummary =
    route.kind === 'album'
      ? albums.find(
          (a) =>
            a.name.toLowerCase() === route.name.toLowerCase() &&
            (!route.artist || a.artist.toLowerCase() === route.artist.toLowerCase()),
        ) ??
        artistDetail?.albums.find(
          (a) =>
            a.name.toLowerCase() === route.name.toLowerCase() &&
            (!route.artist || a.artist.toLowerCase() === route.artist.toLowerCase()),
        )
      : undefined;

  return (
    <div className="flex flex-col gap-3">
      {/* Sub-navegação rápida do catálogo */}
      <div
        role="tablist"
        aria-label="Navegação do acervo"
        className="grid grid-cols-3 gap-1 rounded-xl border border-white/10 bg-white/5 p-1 sm:grid-cols-5"
      >
        {SUB_TABS.map((item) => {
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-kiosk-default={route.kind === 'root' && active ? 'true' : undefined}
              onClick={() => {
                onTabChange(item.id);
                onHistoryChange([{ kind: 'root' }]);
              }}
              className={`truncate rounded-lg px-2 py-1.5 text-[11px] font-semibold transition sm:text-xs ${
                active ? 'bg-accent text-white shadow' : 'text-zinc-300 hover:bg-white/10 hover:text-white'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      {normalizedFilter && (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-accent/25 bg-accent/10 px-3 py-1.5 text-xs text-purple-100">
          <span className="truncate">
            Filtrando por <strong>“{filterQuery.trim()}”</strong>
          </span>
          {onClearFilter && (
            <button
              type="button"
              onClick={onClearFilter}
              className="shrink-0 rounded-lg bg-white/10 px-2 py-0.5 text-[11px] font-semibold hover:bg-white/20"
            >
              Limpar ✕
            </button>
          )}
        </div>
      )}

      {error && <p className="rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}

      {route.kind === 'category' ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            {renderBreadcrumb(
              route.uncategorized ? 'Sem Categoria' : route.subgenre ? `${route.name} · ${route.subgenre}` : route.name,
              'Acervo · Categorias',
            )}
            {!route.uncategorized && canEditMetadata && onDiscoverSimilar && (
              <button
                type="button"
                onClick={() =>
                  onDiscoverSimilar({
                    mode: 'category',
                    category: route.name,
                    subgenre: route.subgenre ?? null,
                    label: route.subgenre ? `${route.name} · ${route.subgenre}` : route.name,
                  })
                }
                className="shrink-0 rounded-xl border border-accent/40 bg-accent/20 px-3 py-1.5 text-xs font-semibold text-purple-100 transition hover:bg-accent/30"
              >
                ✨ Popular semelhantes
              </button>
            )}
          </div>
          {!route.uncategorized && detailSubcategories.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filtrar por subcategoria">
              <button
                type="button"
                aria-pressed={!route.subgenre}
                onClick={() => replaceTopRoute({ kind: 'category', name: route.name, subgenre: null })}
                className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                  !route.subgenre
                    ? 'border-accent bg-accent text-white shadow-sm'
                    : 'border-white/10 bg-white/5 text-zinc-300 hover:bg-white/15 hover:text-white'
                }`}
              >
                Todas
              </button>
              {detailSubcategories.map((sub) => {
                const active = route.subgenre?.toLowerCase() === sub.name.toLowerCase();
                return (
                  <button
                    key={sub.name}
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      replaceTopRoute({
                        kind: 'category',
                        name: route.name,
                        subgenre: active ? null : sub.name,
                      })
                    }
                    className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                      active
                        ? 'border-accent bg-accent text-white shadow-sm'
                        : 'border-white/10 bg-white/5 text-zinc-300 hover:bg-white/15 hover:text-white'
                    }`}
                  >
                    {sub.name} ({sub.trackCount})
                  </button>
                );
              })}
            </div>
          )}
          {loading ? (
            <p className="py-8 text-center text-sm text-zinc-500">Carregando músicas…</p>
          ) : (
            (() => {
              const filtered = filterTracksLocally(detailTracks);
              if (filtered.length === 0) {
                return (
                  <div className="glass flex flex-col items-center gap-2 px-5 py-8 text-center">
                    <p className="font-semibold">Nenhuma música encontrada nesta categoria</p>
                    <button
                      type="button"
                      onClick={goBack}
                      className="rounded-xl bg-white/10 px-3 py-1.5 text-xs font-semibold hover:bg-white/20"
                    >
                      ← Voltar às categorias
                    </button>
                  </div>
                );
              }
              return (
                <ul className="flex flex-col gap-2">
                  {filtered.map((item, idx) => renderTrackRow(item, idx, false))}
                </ul>
              );
            })()
          )}
        </div>
      ) : route.kind === 'album' ? (
        <div className="flex flex-col gap-3">
          {renderBreadcrumb(route.name, 'Acervo · Álbum')}
          {loading ? (
            <p className="py-8 text-center text-sm text-zinc-500">Carregando faixas do álbum…</p>
          ) : (
            (() => {
              const first = detailTracks[0];
              const albumCover = activeAlbumSummary?.cover ?? first?.thumbnail ?? null;
              const albumArtist = route.artist || activeAlbumSummary?.artist || first?.artist || '';
              const albumGenre = activeAlbumSummary?.genre ?? first?.genre ?? null;
              const albumYear = activeAlbumSummary?.year ?? first?.year ?? null;
              const totalSec =
                activeAlbumSummary?.totalDurationSec ??
                detailTracks.reduce((sum, t) => sum + (t.durationSec ?? 0), 0);

              return (
                <>
                  <div className="glass flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
                    <div className="flex min-w-0 items-center gap-3">
                      <Cover src={albumCover} alt={route.name} className="h-20 w-20 shrink-0 rounded-2xl shadow-lg sm:h-24 sm:w-24" />
                      <div className="min-w-0 flex-1">
                        <h4 className="truncate text-lg font-bold leading-tight">{route.name}</h4>
                        {albumArtist ? (
                          <button
                            type="button"
                            onClick={() => pushRoute({ kind: 'artist', name: albumArtist })}
                            className="mt-0.5 max-w-full truncate text-left text-sm font-medium text-accent-2 hover:underline"
                          >
                            {albumArtist}
                          </button>
                        ) : (
                          <p className="mt-0.5 text-sm text-zinc-400">Artista desconhecido</p>
                        )}
                        <p className="mt-1 text-xs text-zinc-400">
                          {[
                            albumGenre,
                            albumYear ? String(albumYear) : null,
                            formatTrackCount(detailTracks.length),
                            totalSec > 0 ? formatTime(totalSec) : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      </div>
                    </div>
                    {canEnqueueAlbum && onAddAlbum && detailTracks.length > 1 && (
                      <button
                        type="button"
                        disabled={addingAlbum}
                        onClick={async () => {
                          setAddingAlbum(true);
                          try {
                            await onAddAlbum(detailTracks, route.name);
                          } finally {
                            setAddingAlbum(false);
                          }
                        }}
                        className="shrink-0 rounded-xl bg-accent px-3.5 py-2 text-xs font-semibold text-white transition hover:brightness-110 disabled:opacity-50 sm:text-sm"
                      >
                        {addingAlbum ? 'Enfileirando…' : `+ Álbum na fila (${detailTracks.length})`}
                      </button>
                    )}
                  </div>

                  {detailTracks.length === 0 ? (
                    <p className="py-8 text-center text-sm text-zinc-500">Nenhuma faixa encontrada neste álbum.</p>
                  ) : (
                    <ol className="flex flex-col gap-2">
                      {filterTracksLocally(detailTracks).map((item, idx) => renderTrackRow(item, idx, true))}
                    </ol>
                  )}
                </>
              );
            })()
          )}
        </div>
      ) : route.kind === 'artist' ? (
        <div className="flex flex-col gap-4">
          {renderBreadcrumb(route.name, 'Acervo · Artista')}
          {loading ? (
            <p className="py-8 text-center text-sm text-zinc-500">Carregando artista…</p>
          ) : !artistDetail ? (
            <div className="glass flex flex-col items-center gap-2 px-5 py-8 text-center">
              <p className="font-semibold">Artista não encontrado</p>
              <button
                type="button"
                onClick={goBack}
                className="rounded-xl bg-white/10 px-3 py-1.5 text-xs font-semibold hover:bg-white/20"
              >
                ← Voltar
              </button>
            </div>
          ) : (
            <>
              <div className="glass flex items-center gap-3 p-3 sm:p-4">
                <Cover src={artistDetail.cover} alt={artistDetail.name} className="h-16 w-16 shrink-0 rounded-full shadow-lg sm:h-20 sm:w-20" />
                <div className="min-w-0">
                  <h4 className="truncate text-lg font-bold">{artistDetail.name}</h4>
                  <p className="text-xs text-zinc-400">
                    {artistDetail.albumCount > 0 ? `${formatAlbumCount(artistDetail.albumCount)} · ` : ''}
                    {formatTrackCount(artistDetail.trackCount)}
                  </p>
                </div>
              </div>

              {artistDetail.albums.length > 0 && (
                <div className="flex flex-col gap-2">
                  <h5 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Álbuns</h5>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                    {artistDetail.albums.map((album) => (
                      <button
                        key={`${album.name}:${album.artist}`}
                        type="button"
                        onClick={() => pushRoute({ kind: 'album', name: album.name, artist: album.artist })}
                        className="group flex flex-col rounded-2xl border border-white/10 bg-white/5 p-2.5 text-left transition hover:border-white/25 hover:bg-white/10"
                      >
                        <div className="relative w-full overflow-hidden rounded-xl">
                          <Cover src={album.cover} alt={album.name} className="aspect-square w-full transition duration-300 group-hover:scale-105" />
                          {album.year && (
                            <span className="absolute bottom-1.5 right-1.5 rounded-md bg-black/75 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-200 backdrop-blur-sm">
                              {album.year}
                            </span>
                          )}
                        </div>
                        <p className="mt-2 truncate text-sm font-semibold">{album.name}</p>
                        <p className="truncate text-xs text-zinc-400">{formatAlbumMeta(album)}</p>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-2">
                <h5 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Músicas</h5>
                <ul className="flex flex-col gap-2">
                  {filterTracksLocally(artistDetail.tracks).map((item, idx) => renderTrackRow(item, idx, false))}
                </ul>
              </div>
            </>
          )}
        </div>
      ) : route.kind === 'playlist' ? (
        <div className="flex flex-col gap-3">
          {renderBreadcrumb(playlistDetail?.name ?? route.name ?? 'Playlist', 'Acervo · Playlists')}
          {loading ? (
            <p className="py-8 text-center text-sm text-zinc-500">Carregando playlist…</p>
          ) : !playlistDetail ? (
            <div className="glass flex flex-col items-center gap-2 px-5 py-8 text-center">
              <p className="font-semibold">Playlist não encontrada</p>
              <button
                type="button"
                onClick={goBack}
                className="rounded-xl bg-white/10 px-3 py-1.5 text-xs font-semibold hover:bg-white/20"
              >
                ← Voltar às playlists
              </button>
            </div>
          ) : (
            (() => {
              const totalSec = playlistDetail.tracks.reduce((sum, t) => sum + (t.durationSec ?? 0), 0);
              const indexedTracks = playlistDetail.tracks.map((item, idx) => ({ item, playlistIndex: idx }));
              const filteredSet = new Set(filterTracksLocally(playlistDetail.tracks));
              const filtered = indexedTracks.filter(({ item }) => filteredSet.has(item));
              const triggerPlaylistEnqueue = async (shuffle: boolean) => {
                if (!onAddPlaylist) return;
                setAddingPlaylistMode(shuffle ? 'shuffle' : 'order');
                try {
                  await onAddPlaylist(playlistDetail, shuffle);
                } finally {
                  setAddingPlaylistMode(null);
                }
              };

              return (
                <>
                  <div className="glass flex flex-col gap-3 p-3 sm:p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 items-center gap-3">
                        <Cover
                          src={playlistDetail.cover ?? playlistDetail.thumbnail}
                          alt={playlistDetail.name}
                          className="h-16 w-16 shrink-0 rounded-2xl shadow-lg sm:h-20 sm:w-20"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h4 className="truncate text-lg font-bold leading-tight">{playlistDetail.name}</h4>
                            {playlistDetail.source && <SourceBadge source={playlistDetail.source} />}
                          </div>
                          {playlistDetail.description && (
                            <p className="mt-0.5 line-clamp-2 text-xs text-zinc-300">{playlistDetail.description}</p>
                          )}
                          <p className="mt-1 text-xs text-zinc-400">
                            {formatTrackCount(playlistDetail.tracks.length)}
                            {totalSec > 0 ? ` · ${formatTime(totalSec)}` : ''}
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {onAddPlaylist && playlistDetail.tracks.length > 0 && (
                          <>
                            <button
                              type="button"
                              disabled={addingPlaylistMode !== null}
                              onClick={() => void triggerPlaylistEnqueue(false)}
                              className="rounded-xl bg-accent px-3 py-2 text-xs font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
                            >
                              {addingPlaylistMode === 'order'
                                ? 'Enfileirando…'
                                : `▶ Enfileirar (${playlistDetail.tracks.length})`}
                            </button>
                            <button
                              type="button"
                              disabled={addingPlaylistMode !== null}
                              onClick={() => void triggerPlaylistEnqueue(true)}
                              className="rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-xs font-semibold text-white transition hover:bg-white/20 disabled:opacity-50"
                            >
                              {addingPlaylistMode === 'shuffle' ? 'Embaralhando…' : '🔀 Embaralhar'}
                            </button>
                          </>
                        )}
                        {canEditMetadata && onDiscoverSimilar && (
                          <button
                            type="button"
                            onClick={() =>
                              onDiscoverSimilar({
                                mode: 'playlist',
                                playlistId: playlistDetail.id,
                                label: playlistDetail.name,
                              })
                            }
                            className="rounded-xl border border-accent/40 bg-accent/20 px-3 py-2 text-xs font-semibold text-purple-100 transition hover:bg-accent/30"
                          >
                            ✨ Popular semelhantes
                          </button>
                        )}
                        {canEditMetadata && !editingPlaylistOpen && !confirmDeletePlaylist && (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setEditPlaylistName(playlistDetail.name);
                                setEditPlaylistDesc(playlistDetail.description ?? '');
                                setEditingPlaylistOpen(true);
                              }}
                              aria-label="Editar playlist"
                              className="rounded-xl border border-white/10 bg-white/5 px-2.5 py-2 text-xs font-semibold text-zinc-200 hover:bg-white/15"
                            >
                              ✎
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeletePlaylist(true)}
                              aria-label="Excluir playlist"
                              className="rounded-xl border border-red-400/25 bg-red-500/10 px-2.5 py-2 text-xs font-semibold text-red-200 hover:bg-red-500/25"
                            >
                              🗑
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {canEditMetadata && editingPlaylistOpen && (
                      <form
                        onSubmit={(e) => void handleSavePlaylistEdit(e)}
                        className="flex flex-col gap-2 border-t border-white/10 pt-3"
                      >
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          <input
                            value={editPlaylistName}
                            onChange={(e) => setEditPlaylistName(e.target.value)}
                            maxLength={80}
                            placeholder="Nome da playlist"
                            className="rounded-xl bg-white/10 px-3 py-2 text-xs text-white outline-none focus:ring-2 focus:ring-accent"
                          />
                          <input
                            value={editPlaylistDesc}
                            onChange={(e) => setEditPlaylistDesc(e.target.value)}
                            maxLength={300}
                            placeholder="Descrição (opcional)"
                            className="rounded-xl bg-white/10 px-3 py-2 text-xs text-white outline-none focus:ring-2 focus:ring-accent"
                          />
                        </div>
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            disabled={playlistBusy}
                            onClick={() => setEditingPlaylistOpen(false)}
                            className="rounded-xl bg-white/10 px-3 py-1.5 text-xs font-semibold hover:bg-white/20"
                          >
                            Cancelar
                          </button>
                          <button
                            type="submit"
                            disabled={playlistBusy}
                            className="rounded-xl bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-50"
                          >
                            {playlistBusy ? 'Salvando…' : 'Salvar'}
                          </button>
                        </div>
                      </form>
                    )}

                    {canEditMetadata && confirmDeletePlaylist && (
                      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-red-400/20 pt-3">
                        <span className="text-xs text-red-200">
                          Excluir a playlist <strong>{playlistDetail.name}</strong>? As músicas continuam no acervo.
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={playlistBusy}
                            onClick={() => setConfirmDeletePlaylist(false)}
                            className="rounded-xl bg-white/10 px-3 py-1.5 text-xs font-semibold hover:bg-white/20"
                          >
                            Cancelar
                          </button>
                          <button
                            type="button"
                            disabled={playlistBusy}
                            onClick={() => void handleDeletePlaylist()}
                            className="rounded-xl bg-red-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-400 disabled:opacity-50"
                          >
                            {playlistBusy ? 'Excluindo…' : 'Confirmar exclusão'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {filtered.length === 0 ? (
                    <div className="glass flex flex-col items-center gap-2 px-5 py-8 text-center">
                      <p className="font-semibold">
                        {playlistDetail.tracks.length === 0
                          ? 'Esta playlist ainda não tem músicas'
                          : 'Nenhuma música desta playlist combina com o filtro'}
                      </p>
                      <p className="text-xs text-zinc-400">
                        {playlistDetail.tracks.length === 0
                          ? 'Use o botão "+ Playlist" nas músicas do acervo ou na faixa tocando agora para preencher.'
                          : 'Limpe o filtro acima para ver todas as faixas.'}
                      </p>
                    </div>
                  ) : (
                    <ol className="flex flex-col gap-2">
                      {filtered.map(({ item, playlistIndex }) =>
                        renderTrackRow(item, playlistIndex, true, playlistDetail.id),
                      )}
                    </ol>
                  )}
                </>
              );
            })()
          )}
        </div>
      ) : tab === 'playlists' ? (
        <div className="flex flex-col gap-3">
          {(canEditMetadata || onImportPlaylist) && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 flex-1 text-xs text-zinc-400">
                  Misture músicas em listas temáticas ou importe playlists públicas do YouTube e Spotify.
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  {onImportPlaylist && (
                    <button
                      type="button"
                      onClick={() => {
                        setCreatingPlaylistOpen(false);
                        setImportingPlaylistOpen((v) => !v);
                      }}
                      className="rounded-xl border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-white/20"
                    >
                      {importingPlaylistOpen ? 'Cancelar' : '📥 Importar link'}
                    </button>
                  )}
                  {canEditMetadata && (
                    <button
                      type="button"
                      onClick={() => {
                        setImportingPlaylistOpen(false);
                        setCreatingPlaylistOpen((v) => !v);
                      }}
                      className="rounded-xl bg-accent px-3 py-1.5 text-xs font-semibold text-white transition hover:brightness-110"
                    >
                      {creatingPlaylistOpen ? 'Cancelar' : '+ Nova playlist'}
                    </button>
                  )}
                </div>
              </div>
              {onImportPlaylist && importingPlaylistOpen && (
                <form
                  onSubmit={(e) => void handleImportPlaylistForm(e)}
                  className="glass flex flex-col gap-2 p-3 sm:flex-row sm:items-center"
                >
                  <input
                    value={importPlaylistUrl}
                    onChange={(e) => setImportPlaylistUrl(e.target.value)}
                    placeholder="Cole o link da playlist do YouTube ou Spotify…"
                    aria-label="URL da playlist para importar"
                    className="min-w-0 flex-1 rounded-xl bg-white/10 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-accent"
                  />
                  <button
                    type="submit"
                    disabled={importingPlaylist || !importPlaylistUrl.trim()}
                    className={`shrink-0 rounded-xl bg-accent px-4 py-2 text-xs font-semibold text-white transition hover:brightness-110 disabled:opacity-60 ${
                      importingPlaylist ? 'disabled:cursor-wait' : 'disabled:cursor-not-allowed'
                    }`}
                  >
                    {importingPlaylist ? 'Importando…' : 'Importar Playlist'}
                  </button>
                </form>
              )}
              {canEditMetadata && creatingPlaylistOpen && (
                <form
                  onSubmit={(e) => void handleCreatePlaylist(e)}
                  className="glass flex flex-col gap-2 p-3"
                >
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <input
                      value={newPlaylistName}
                      onChange={(e) => setNewPlaylistName(e.target.value)}
                      maxLength={80}
                      placeholder="Nome (ex.: Churrasco, Festa)"
                      className="rounded-xl bg-white/10 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-accent"
                    />
                    <input
                      value={newPlaylistDesc}
                      onChange={(e) => setNewPlaylistDesc(e.target.value)}
                      maxLength={300}
                      placeholder="Descrição opcional"
                      className="rounded-xl bg-white/10 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-accent"
                    />
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="submit"
                      disabled={playlistBusy}
                      className="rounded-xl bg-accent px-4 py-2 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-50"
                    >
                      {playlistBusy ? 'Criando…' : 'Criar playlist'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}

          {loading && playlists.length === 0 ? (
            <p className="py-8 text-center text-sm text-zinc-500">Carregando playlists…</p>
          ) : visiblePlaylists.length === 0 ? (
            <div className="glass flex flex-col items-center gap-2 px-6 py-10 text-center">
              <span className="text-3xl">🎧</span>
              <p className="font-semibold">
                {normalizedFilter ? 'Nenhuma playlist combina com a busca' : 'Nenhuma playlist interna criada ainda'}
              </p>
              <p className="text-xs text-zinc-400">
                {normalizedFilter
                  ? 'Tente outro termo ou limpe o filtro acima.'
                  : canEditMetadata
                    ? 'Crie playlists temáticas acima ou usando o botão "+ Playlist" em qualquer faixa.'
                    : 'Peça ao Host para montar playlists temáticas para a festa.'}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {visiblePlaylists.map((pl) => {
                const theme = getCategoryTheme(pl.name);
                const coverSrc = pl.cover ?? pl.thumbnail ?? null;
                return (
                  <button
                    key={pl.id}
                    type="button"
                    onClick={() => pushRoute({ kind: 'playlist', id: pl.id, name: pl.name })}
                    className={`group relative flex min-h-28 flex-col justify-between overflow-hidden rounded-2xl border bg-gradient-to-br p-3.5 text-left shadow-lg transition hover:-translate-y-0.5 ${theme.gradient} ${theme.border}`}
                  >
                    <div className="relative z-10 flex flex-col gap-1 pr-6">
                      <span className="line-clamp-2 text-base font-bold leading-snug text-white">{pl.name}</span>
                      <span className="text-xs text-white/80">{formatTrackCount(pl.trackCount)}</span>
                    </div>
                    <div className="relative z-10 mt-2 flex flex-col gap-1.5 pr-12">
                      {pl.source && (
                        <div>
                          <SourceBadge source={pl.source} />
                        </div>
                      )}
                      {pl.description && (
                        <p className="line-clamp-2 text-[11px] text-white/75">{pl.description}</p>
                      )}
                    </div>
                    {coverSrc && (
                      <img
                        src={coverSrc}
                        alt=""
                        aria-hidden="true"
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="pointer-events-none absolute -bottom-2 -right-2 h-14 w-14 rotate-12 rounded-lg object-cover opacity-80 shadow-xl transition duration-300 group-hover:scale-105"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : tab === 'categories' ? (
        loading && categories.length === 0 ? (
          <p className="py-8 text-center text-sm text-zinc-500">Carregando categorias…</p>
        ) : visibleCategories.length === 0 && !showUncategorized ? (
          <div className="glass flex flex-col items-center gap-2 px-6 py-10 text-center">
            <span className="text-3xl">🗂️</span>
            <p className="font-semibold">
              {normalizedFilter ? 'Nenhuma categoria combina com a busca' : 'Nenhuma música no acervo ainda'}
            </p>
            <p className="text-xs text-zinc-400">
              {normalizedFilter
                ? 'Tente outro termo ou limpe o filtro acima.'
                : 'Baixe músicas pelo YouTube/Spotify ou adicione arquivos na pasta do acervo.'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {visibleCategories.map((cat) => {
              const theme = getCategoryTheme(cat.name);
              return (
                <button
                  key={cat.name}
                  type="button"
                  onClick={() => pushRoute({ kind: 'category', name: cat.name })}
                  className={`group relative flex min-h-28 flex-col justify-between overflow-hidden rounded-2xl border bg-gradient-to-br p-3.5 text-left shadow-lg transition hover:-translate-y-0.5 ${theme.gradient} ${theme.border}`}
                >
                  <div className="relative z-10 flex flex-col gap-1 pr-6">
                    <span className="line-clamp-2 text-base font-bold leading-snug text-white">{cat.name}</span>
                    <span className="text-xs text-white/80">{formatTrackCount(cat.trackCount)}</span>
                  </div>
                  <div className="relative z-10 mt-3 flex flex-wrap items-center gap-1">
                    {cat.albumCount > 0 && (
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${theme.badge}`}>
                        {formatAlbumCount(cat.albumCount)}
                      </span>
                    )}
                    {(cat.subcategories?.length ?? 0) > 0 && (
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${theme.badge}`}>
                        {cat.subcategories!.length}{' '}
                        {cat.subcategories!.length === 1 ? 'subcategoria' : 'subcategorias'}
                      </span>
                    )}
                  </div>
                  {cat.cover && (
                    <img
                      src={cat.cover}
                      alt=""
                      aria-hidden="true"
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      className="pointer-events-none absolute -bottom-2 -right-2 h-14 w-14 rotate-12 rounded-lg object-cover opacity-80 shadow-xl transition duration-300 group-hover:scale-105"
                    />
                  )}
                </button>
              );
            })}
            {showUncategorized && (
              <button
                type="button"
                onClick={() => pushRoute({ kind: 'category', name: 'Sem Categoria', uncategorized: true })}
                className={`group relative flex min-h-28 flex-col justify-between overflow-hidden rounded-2xl border bg-gradient-to-br p-3.5 text-left shadow-lg transition hover:-translate-y-0.5 ${getCategoryTheme('Sem Categoria', true).gradient} ${getCategoryTheme('Sem Categoria', true).border}`}
              >
                <div className="relative z-10 flex flex-col gap-1 pr-6">
                  <span className="line-clamp-2 text-base font-bold leading-snug text-zinc-100">Sem Categoria</span>
                  <span className="text-xs text-zinc-300">{formatTrackCount(uncategorized.count)}</span>
                </div>
                <span className="relative z-10 mt-3 w-fit rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-medium text-zinc-300">
                  A organizar
                </span>
                {uncategorized.cover && (
                  <img
                    src={uncategorized.cover}
                    alt=""
                    aria-hidden="true"
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="pointer-events-none absolute -bottom-2 -right-2 h-14 w-14 rotate-12 rounded-lg object-cover opacity-60 shadow-xl"
                  />
                )}
              </button>
            )}
          </div>
        )
      ) : tab === 'albums' ? (
        loading && albums.length === 0 ? (
          <p className="py-8 text-center text-sm text-zinc-500">Carregando álbuns…</p>
        ) : albums.length === 0 ? (
          <div className="glass flex flex-col items-center gap-2 px-6 py-10 text-center">
            <span className="text-3xl">💿</span>
            <p className="font-semibold">
              {normalizedFilter ? 'Nenhum álbum encontrado' : 'Nenhum álbum catalogado ainda'}
            </p>
            <p className="text-xs text-zinc-400">
              {normalizedFilter
                ? 'Tente buscar outro álbum ou artista.'
                : 'Músicas com metadados de álbum aparecem aqui com suas capas.'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {albums.map((album) => (
              <button
                key={`${album.name}:${album.artist}`}
                type="button"
                onClick={() => pushRoute({ kind: 'album', name: album.name, artist: album.artist })}
                className="group flex flex-col rounded-2xl border border-white/10 bg-white/5 p-2.5 text-left transition hover:border-white/25 hover:bg-white/10"
              >
                <div className="relative w-full overflow-hidden rounded-xl">
                  <Cover
                    src={album.cover}
                    alt={album.name}
                    className="aspect-square w-full transition duration-300 group-hover:scale-105"
                  />
                  {album.year && (
                    <span className="absolute bottom-1.5 right-1.5 rounded-md bg-black/75 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-200 backdrop-blur-sm">
                      {album.year}
                    </span>
                  )}
                </div>
                <p className="mt-2 truncate text-sm font-semibold text-white">{album.name}</p>
                <p className="truncate text-xs text-zinc-400">{album.artist || 'Artista desconhecido'}</p>
                <p className="mt-0.5 truncate text-[11px] text-zinc-500">{formatAlbumMeta(album)}</p>
              </button>
            ))}
          </div>
        )
      ) : tab === 'artists' ? (
        loading && artists.length === 0 ? (
          <p className="py-8 text-center text-sm text-zinc-500">Carregando artistas…</p>
        ) : visibleArtists.length === 0 ? (
          <div className="glass flex flex-col items-center gap-2 px-6 py-10 text-center">
            <span className="text-3xl">🎙️</span>
            <p className="font-semibold">
              {normalizedFilter ? 'Nenhum artista encontrado' : 'Nenhum artista no acervo ainda'}
            </p>
            <p className="text-xs text-zinc-400">
              {normalizedFilter ? 'Tente outro nome.' : 'Artistas das músicas do acervo aparecem aqui.'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {visibleArtists.map((artist) => (
              <button
                key={artist.name}
                type="button"
                onClick={() => pushRoute({ kind: 'artist', name: artist.name })}
                className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-3 text-left transition hover:border-white/25 hover:bg-white/10"
              >
                <Cover src={artist.cover} alt={artist.name} className="h-14 w-14 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-white">{artist.name}</p>
                  <p className="truncate text-xs text-zinc-400">
                    {artist.albumCount > 0 ? `${formatAlbumCount(artist.albumCount)} · ` : ''}
                    {formatTrackCount(artist.trackCount)}
                  </p>
                </div>
                <span className="shrink-0 text-sm text-zinc-500">›</span>
              </button>
            ))}
          </div>
        )
      ) : loading && allTracks.length === 0 ? (
        <p className="py-8 text-center text-sm text-zinc-500">Carregando acervo…</p>
      ) : allTracks.length === 0 ? (
        <div className="glass flex flex-col items-center gap-2 px-6 py-10 text-center">
          <span className="text-3xl">🎵</span>
          <p className="font-semibold">Nenhuma música encontrada no acervo</p>
          <p className="text-xs text-zinc-400">
            {normalizedFilter ? 'Tente buscar outro termo.' : 'As músicas baixadas ou locais aparecem aqui.'}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {allTracks.map((item, idx) => renderTrackRow(item, idx, false))}
        </ul>
      )}
    </div>
  );
}
