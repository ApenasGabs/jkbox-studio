import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import {
  type CatalogRoute,
  type CatalogTab,
  type EditableTrack,
  editableFromResult,
  formatAlbumCount,
  formatAlbumMeta,
  formatTrackCount,
  getCategoryTheme,
  splitUncategorizedTracks,
} from '../lib/catalog';
import { formatTime } from '../lib/format';
import { applyKaraokeFilter } from '../lib/karaoke';
import type { CatalogAlbum, CatalogArtist, CatalogArtistDetail, CatalogCategory, SearchResult } from '../lib/types';
import { Cover } from './Cover';
import { SourceBadge } from './SourceBadge';

const SUB_TABS: { id: CatalogTab; label: string }[] = [
  { id: 'categories', label: 'Categorias' },
  { id: 'albums', label: 'Álbuns' },
  { id: 'artists', label: 'Artistas' },
  { id: 'all', label: 'Todas' },
];

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
  canEditMetadata: boolean;
  canEnqueueAlbum?: boolean;
  onEditTrack: (track: EditableTrack) => void;
  onCategoriesLoaded?: (categories: CatalogCategory[]) => void;
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
  canEditMetadata,
  canEnqueueAlbum = false,
  onEditTrack,
  onCategoriesLoaded,
}: Props) {
  const route = history[history.length - 1] ?? { kind: 'root' };
  const normalizedFilter = filterQuery.trim().toLowerCase();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingAlbum, setAddingAlbum] = useState(false);

  const [categories, setCategories] = useState<CatalogCategory[]>([]);
  const [uncategorized, setUncategorized] = useState<{ count: number; cover: string | null; tracks: SearchResult[] }>({
    count: 0,
    cover: null,
    tracks: [],
  });
  const [albums, setAlbums] = useState<CatalogAlbum[]>([]);
  const [artists, setArtists] = useState<CatalogArtist[]>([]);
  const [allTracks, setAllTracks] = useState<SearchResult[]>([]);
  const [detailTracks, setDetailTracks] = useState<SearchResult[]>([]);
  const [artistDetail, setArtistDetail] = useState<CatalogArtistDetail | null>(null);

  const pushRoute = (next: CatalogRoute) => onHistoryChange([...history, next]);
  const goBack = () => {
    if (history.length > 1) onHistoryChange(history.slice(0, -1));
    else onHistoryChange([{ kind: 'root' }]);
  };

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        if (route.kind === 'category') {
          if (route.uncategorized) {
            const lib = await api.library('', signal);
            setDetailTracks(splitUncategorizedTracks(lib.results).tracks);
          } else {
            const res = await api.catalogCategoryTracks(route.name, signal);
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

        // Root sub-tabs
        if (tab === 'categories') {
          const [catRes, libRes] = await Promise.all([api.catalogCategories(signal), api.library('', signal)]);
          const uncat = splitUncategorizedTracks(libRes.results);
          setCategories(catRes.categories);
          setUncategorized({ count: uncat.tracks.length, cover: uncat.cover, tracks: uncat.tracks });
          onCategoriesLoaded?.(catRes.categories);
        } else if (tab === 'albums') {
          const res = await api.catalogAlbums({ q: filterQuery }, signal);
          setAlbums(res.albums);
        } else if (tab === 'artists') {
          const res = await api.catalogArtists(signal);
          setArtists(res.artists);
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
  }, [route, tab, filterQuery, karaoke, reloadKey]);

  const filterTracksLocally = (items: SearchResult[]) => {
    if (!normalizedFilter) return items;
    return items.filter((item) =>
      [item.title, item.artist, item.album ?? '', item.genre ?? ''].some((v) => v.toLowerCase().includes(normalizedFilter)),
    );
  };

  const renderTrackRow = (result: SearchResult, index?: number, showTrackNumber = false) => {
    const key = `${result.source}:${result.sourceId}`;
    const editable = canEditMetadata ? editableFromResult(result) : null;
    const orderNum = showTrackNumber ? (result.trackNumber ?? (index != null ? index + 1 : null)) : null;

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
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {editable && (
            <button
              type="button"
              onClick={() => onEditTrack(editable)}
              aria-label={`Editar metadados de ${result.title}`}
              title="Editar categoria, álbum ou metadados"
              className="rounded-xl border border-white/10 bg-white/5 px-2.5 py-2 text-xs font-semibold text-zinc-300 transition hover:bg-white/15 hover:text-white"
            >
              ✎
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
        className="grid grid-cols-4 gap-1 rounded-xl border border-white/10 bg-white/5 p-1"
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
          {renderBreadcrumb(
            route.uncategorized ? 'Sem Categoria' : route.name,
            'Acervo · Categorias',
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
