import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { formatTime } from '../lib/format';
import type {
  DiscoveryMode,
  DiscoveryPopulateResponse,
  DiscoverySeedSummary,
  DiscoverySource,
  DiscoveryTarget,
  SearchResult,
} from '../lib/types';
import { Cover } from './Cover';
import { GenreBadges } from './GenreBadges';
import { SourceBadge } from './SourceBadge';

export interface DiscoveryRequestContext {
  mode: DiscoveryMode;
  target: DiscoveryTarget;
  title: string;
  subtitle?: string;
  playlistId?: string;
  category?: string;
  subgenre?: string | null;
}

interface Props {
  context: DiscoveryRequestContext | null;
  onClose: () => void;
  onPopulated: (result: DiscoveryPopulateResponse) => void;
  onToast: (message: string, error?: boolean) => void;
}

const LIMITS = [5, 10, 20] as const;

const SOURCE_LABELS: Record<DiscoverySource, string> = {
  deezer: 'Deezer',
  spotify: 'Spotify',
  youtube: 'YouTube',
};

function trackKey(item: SearchResult): string {
  return `${item.source}:${item.sourceId}`;
}

export function DiscoveryModal({ context, onClose, onPopulated, onToast }: Props) {
  const [limit, setLimit] = useState<5 | 10 | 20>(10);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<SearchResult[]>([]);
  const [seeds, setSeeds] = useState<DiscoverySeedSummary[]>([]);
  const [sourcesUsed, setSourcesUsed] = useState<DiscoverySource[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const abortRef = useRef<AbortController | null>(null);

  const loadSuggestions = useCallback(
    async (ctx: DiscoveryRequestContext, requestedLimit: number) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setError(null);
      try {
        const res = await api.discoverySuggest(
          {
            mode: ctx.mode,
            playlistId: ctx.playlistId,
            category: ctx.category,
            subgenre: ctx.subgenre,
            limit: requestedLimit,
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setSuggestions(res.suggestions);
        setSeeds(res.seeds);
        setSourcesUsed(res.sourcesUsed);
        setSelectedKeys(new Set(res.suggestions.map(trackKey)));
      } catch (err) {
        if ((err as Error).name !== 'AbortError' && !controller.signal.aborted) {
          setError((err as Error).message);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    if (!context) {
      abortRef.current?.abort();
      abortRef.current = null;
      setSuggestions([]);
      setSeeds([]);
      setSourcesUsed([]);
      setSelectedKeys(new Set());
      setError(null);
      setLoading(false);
      setSubmitting(false);
      return;
    }
    void loadSuggestions(context, limit);
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [context, limit, loadSuggestions]);

  useEffect(() => {
    if (!context) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [context, submitting, onClose]);

  if (!context) return null;

  const selectedTracks = suggestions.filter((item) => selectedKeys.has(trackKey(item)));
  const allSelected = suggestions.length > 0 && selectedTracks.length === suggestions.length;

  const toggleTrack = (item: SearchResult) => {
    const key = trackKey(item);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) setSelectedKeys(new Set());
    else setSelectedKeys(new Set(suggestions.map(trackKey)));
  };

  const handleConfirm = async () => {
    if (selectedTracks.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.discoveryPopulate({
        tracks: selectedTracks,
        target: context.target,
        playlistId: context.playlistId,
      });
      const verb =
        context.target === 'queue'
          ? 'enfileirada'
          : context.target === 'playlist'
            ? 'adicionada à playlist'
            : 'adicionada ao acervo';
      const plural = res.added === 1 ? '' : 's';
      const downloadNote =
        res.queuedDownloads > 0
          ? ` (${res.queuedDownloads} download${res.queuedDownloads === 1 ? '' : 's'} em 2º plano)`
          : '';
      onToast(
        res.added > 0
          ? `${res.added} música${plural} ${verb}${plural}${downloadNote} ✨`
          : 'Todas as faixas selecionadas já estavam presentes.',
      );
      onPopulated(res);
      onClose();
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      onToast(msg, true);
    } finally {
      setSubmitting(false);
    }
  };

  const confirmLabel =
    context.target === 'queue'
      ? `Enfileirar ${selectedTracks.length} na fila`
      : context.target === 'playlist'
        ? `Adicionar ${selectedTracks.length} e baixar`
        : `Baixar ${selectedTracks.length} no acervo`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={() => !submitting && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="discovery-modal-title"
        data-kiosk-scope="discovery"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90dvh] w-full max-w-lg flex-col gap-3.5 overflow-hidden rounded-t-3xl border border-white/15 bg-panel p-4 shadow-2xl sm:rounded-3xl sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="discovery-modal-title" className="text-lg font-bold leading-tight text-white">
              ✨ {context.title}
            </h2>
            {context.subtitle && <p className="mt-0.5 truncate text-xs text-zinc-400">{context.subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Fechar recomendações"
            className="shrink-0 rounded-lg px-2 py-1 text-zinc-400 hover:bg-white/10 hover:text-white disabled:opacity-50"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
          <div className="flex items-center gap-1.5" role="group" aria-label="Quantidade de sugestões">
            <span className="text-xs text-zinc-400">Quantidade:</span>
            {LIMITS.map((option) => {
              const active = limit === option;
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={active}
                  disabled={loading || submitting}
                  onClick={() => setLimit(option)}
                  className={`rounded-full border px-2.5 py-1 text-xs font-semibold transition ${
                    active
                      ? 'border-accent bg-accent text-white shadow-sm'
                      : 'border-white/10 bg-white/5 text-zinc-300 hover:bg-white/15 hover:text-white'
                  } disabled:opacity-50`}
                >
                  {option}
                </button>
              );
            })}
          </div>
          {suggestions.length > 0 && (
            <button
              type="button"
              disabled={loading || submitting}
              onClick={toggleAll}
              className="rounded-lg bg-white/10 px-2.5 py-1 text-xs font-semibold text-zinc-200 transition hover:bg-white/20 disabled:opacity-50"
            >
              {allSelected ? 'Desmarcar todas' : 'Selecionar todas'}
            </button>
          )}
        </div>

        {(seeds.length > 0 || sourcesUsed.length > 0) && !loading && (
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-400">
            {seeds.length > 0 && (
              <span className="truncate">
                Baseado em:{' '}
                <strong className="text-zinc-200">
                  {seeds
                    .slice(0, 3)
                    .map((s) => s.artist || s.title)
                    .filter(Boolean)
                    .join(', ')}
                </strong>
              </span>
            )}
            {sourcesUsed.length > 0 && (
              <span className="ml-auto shrink-0 rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-zinc-300">
                Fontes: {sourcesUsed.map((s) => SOURCE_LABELS[s]).join(' · ')}
              </span>
            )}
          </div>
        )}

        {error && (
          <div className="flex items-center justify-between gap-2 rounded-xl bg-red-500/15 px-3 py-2 text-xs text-red-200">
            <span className="min-w-0 flex-1">{error}</span>
            <button
              type="button"
              onClick={() => void loadSuggestions(context, limit)}
              className="shrink-0 rounded-lg bg-white/10 px-2.5 py-1 font-semibold text-white hover:bg-white/20"
            >
              Tentar novamente
            </button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {loading ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <span className="animate-pulse text-2xl">✨</span>
              <p className="text-sm font-medium text-zinc-300">Buscando faixas na mesma vibe…</p>
              <p className="text-xs text-zinc-500">Consultando Deezer, Spotify e YouTube sem repetir o acervo.</p>
            </div>
          ) : suggestions.length === 0 ? (
            <div className="glass flex flex-col items-center gap-2 px-5 py-8 text-center">
              <span className="text-3xl">🎧</span>
              <p className="text-sm font-semibold">Nenhuma recomendação nova encontrada</p>
              <p className="text-xs text-zinc-400">
                As faixas semelhantes encontradas já estão no acervo/fila ou tente novamente em outra semente.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {suggestions.map((item) => {
                const key = trackKey(item);
                const checked = selectedKeys.has(key);
                return (
                  <li key={key}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      disabled={submitting}
                      onClick={() => toggleTrack(item)}
                      className={`flex w-full items-center gap-2.5 rounded-xl border p-2 text-left transition ${
                        checked
                          ? 'border-accent/60 bg-accent/15 text-white'
                          : 'border-white/10 bg-white/5 text-zinc-400 hover:bg-white/10'
                      } disabled:opacity-50`}
                    >
                      <span
                        aria-hidden="true"
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-xs font-bold ${
                          checked ? 'border-accent bg-accent text-white' : 'border-white/25 bg-black/30 text-transparent'
                        }`}
                      >
                        ✓
                      </span>
                      <Cover src={item.thumbnail} alt={item.title} className="h-11 w-11 shrink-0 rounded-lg" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-white">{item.title}</p>
                        <p className="truncate text-xs text-zinc-400">
                          {item.artist || '—'}
                          {item.album ? ` · ${item.album}` : ''}
                          {item.durationSec ? ` · ${formatTime(item.durationSec)}` : ''}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          <SourceBadge source={item.source} />
                          <GenreBadges genre={item.genre} subgenre={item.subgenre} />
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-3">
          <span className="text-xs text-zinc-400">
            {suggestions.length > 0
              ? `${selectedTracks.length} de ${suggestions.length} selecionada${selectedTracks.length === 1 ? '' : 's'}`
              : 'Downloads em 2º plano (baixa prioridade)'}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              data-kiosk-default={suggestions.length === 0 ? 'true' : undefined}
              className="rounded-xl bg-white/10 px-3.5 py-2 text-xs font-semibold text-zinc-200 hover:bg-white/20 disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => void handleConfirm()}
              disabled={loading || submitting || selectedTracks.length === 0}
              data-kiosk-default={suggestions.length > 0 ? 'true' : undefined}
              className="rounded-xl bg-accent px-4 py-2 text-xs font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
            >
              {submitting ? 'Adicionando…' : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
