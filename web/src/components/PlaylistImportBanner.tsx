import {
  type DetectedPlaylistLink,
  formatPlaylistImportSummary,
  type PlaylistImportErrorInfo,
} from '../lib/playlistImport';
import type { PlaylistImportResult, PlaylistSummary } from '../lib/types';
import { Cover } from './Cover';
import { SourceBadge } from './SourceBadge';

interface DetectedCardProps {
  detected: DetectedPlaylistLink;
  importing: boolean;
  onImport: () => void;
}

export function PlaylistImportDetectedCard({ detected, importing, onImport }: DetectedCardProps) {
  const platformName = detected.source === 'youtube' ? 'YouTube' : 'Spotify';
  return (
    <div
      data-testid="playlist-import-detected"
      className="glass flex flex-col gap-2.5 border border-accent/35 bg-accent/10 p-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <SourceBadge source={detected.source} />
          <p className="text-sm font-semibold text-white">Playlist do {platformName} detectada</p>
        </div>
        <p className="mt-0.5 text-xs text-zinc-300">
          Salva no catálogo para tocar depois, baixa as faixas em segundo plano e adiciona à fila.
        </p>
      </div>
      <button
        type="button"
        disabled={importing}
        onClick={onImport}
        className="shrink-0 rounded-xl bg-accent px-4 py-2 text-xs font-semibold text-white shadow transition hover:brightness-110 disabled:cursor-wait disabled:opacity-60 sm:text-sm"
      >
        {importing ? 'Importando…' : 'Importar Playlist'}
      </button>
    </div>
  );
}

interface FeedbackProps {
  result: PlaylistImportResult | null;
  error: PlaylistImportErrorInfo | null;
  onOpenPlaylist?: (playlist: PlaylistSummary) => void;
  onDismissResult: () => void;
  onDismissError: () => void;
}

export function PlaylistImportFeedback({
  result,
  error,
  onOpenPlaylist,
  onDismissResult,
  onDismissError,
}: FeedbackProps) {
  if (!result && !error) return null;

  const summary = result ? formatPlaylistImportSummary(result) : null;
  const coverSrc = result ? (result.playlist.cover ?? result.playlist.thumbnail ?? null) : null;

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <div
          role="alert"
          data-testid="playlist-import-error"
          className="flex items-start justify-between gap-3 rounded-2xl border border-red-400/30 bg-red-500/15 p-3 text-red-100"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs font-bold uppercase tracking-wide text-red-200">{error.title}</p>
              {error.status != null && (
                <span className="rounded-full bg-red-500/25 px-2 py-0.5 text-[10px] font-semibold text-red-200">
                  HTTP {error.status}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-red-100/90">{error.message}</p>
          </div>
          <button
            type="button"
            onClick={onDismissError}
            aria-label="Fechar erro de importação"
            className="shrink-0 rounded-lg px-2 py-1 text-xs text-red-200 hover:bg-red-500/25"
          >
            ✕
          </button>
        </div>
      )}

      {result && summary && (
        <div
          role="status"
          data-testid="playlist-import-summary"
          className="flex items-start justify-between gap-3 rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-3 text-emerald-50"
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <Cover
              src={coverSrc}
              alt={result.playlist.name}
              className="h-12 w-12 shrink-0 rounded-xl"
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <p className="truncate text-sm font-semibold text-white">{summary.headline}</p>
                {result.playlist.source && <SourceBadge source={result.playlist.source} />}
              </div>
              <p className="mt-0.5 text-xs text-emerald-200/90">{summary.counts}</p>
              {onOpenPlaylist && (
                <button
                  type="button"
                  onClick={() => onOpenPlaylist(result.playlist)}
                  className="mt-1.5 rounded-lg border border-emerald-300/30 bg-emerald-500/20 px-2.5 py-1 text-[11px] font-semibold text-emerald-100 transition hover:bg-emerald-500/30"
                >
                  Abrir no Catálogo →
                </button>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onDismissResult}
            aria-label="Fechar resumo da importação"
            className="shrink-0 rounded-lg px-2 py-1 text-xs text-emerald-200 hover:bg-emerald-500/20"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
