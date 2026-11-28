import { getClientId } from '../lib/api';
import { computeQueueEtas, formatEta } from '../lib/eta';
import { formatTime } from '../lib/format';
import type { QueueEntry } from '../lib/types';
import type { DownloadInfo } from '../lib/useJukebox';
import { Cover } from './Cover';

interface Props {
  queue: QueueEntry[];
  downloads: Record<string, DownloadInfo>;
  currentRemainingSec?: number | null;
  clientId?: string;
  onVote?: (entry: QueueEntry) => void;
  onRemove?: (entry: QueueEntry) => void;
  onRetry?: (entry: QueueEntry) => void | Promise<unknown>;
  canRemove?: (entry: QueueEntry) => boolean;
  canRetry?: (entry: QueueEntry) => boolean;
  retryingTrackIds?: Record<string, boolean>;
  canManageFailed?: boolean;
  onRetryAllFailed?: () => void | Promise<unknown>;
  onClearFailed?: () => void | Promise<unknown>;
  batchRetryBusy?: boolean;
  batchClearBusy?: boolean;
  compact?: boolean;
}

function readSafeClientId(override?: string): string {
  if (override !== undefined) return override;
  if (typeof window !== 'undefined' && typeof window.localStorage?.getItem === 'function') {
    return getClientId();
  }
  return '';
}

function DownloadStatus({
  entry,
  live,
  retryControl,
}: {
  entry: QueueEntry;
  live?: DownloadInfo;
  retryControl?: React.ReactNode;
}) {
  const status = live?.status ?? entry.track.status;
  const progress = live?.progress ?? entry.track.progress;
  if (status === 'ready') return null;
  if (status === 'error') {
    return (
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-xs text-red-300">falha no download</span>
        {retryControl}
      </div>
    );
  }
  return (
    <div className="mt-1 flex items-center gap-2">
      <div className="h-1 w-24 overflow-hidden rounded-full bg-white/10">
        <div className="h-full bg-accent-2 transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      <span className="text-[10px] text-zinc-400">
        {status === 'pending' ? 'na fila de download' : `baixando ${Math.round(progress * 100)}%`}
      </span>
    </div>
  );
}

export function QueueList({
  queue,
  downloads,
  currentRemainingSec,
  clientId,
  onVote,
  onRemove,
  onRetry,
  canRemove,
  canRetry,
  retryingTrackIds,
  canManageFailed = false,
  onRetryAllFailed,
  onClearFailed,
  batchRetryBusy = false,
  batchClearBusy = false,
  compact,
}: Props) {
  const me = readSafeClientId(clientId);
  if (queue.length === 0) {
    return <p className="py-6 text-center text-sm text-zinc-500">A fila está vazia. Peça uma música! 🎤</p>;
  }
  const etas = currentRemainingSec !== undefined ? computeQueueEtas(queue, currentRemainingSec) : null;
  const failedCount = queue.reduce(
    (count, entry) => ((downloads[entry.trackId]?.status ?? entry.track.status) === 'error' ? count + 1 : count),
    0,
  );
  const showBatchActions = canManageFailed && failedCount > 0 && Boolean(onRetryAllFailed || onClearFailed);

  return (
    <div className="flex flex-col gap-2.5">
      {showBatchActions && (
        <div
          data-testid="queue-failed-actions"
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-400/25 bg-red-500/10 px-3 py-2"
        >
          <span className="text-xs font-medium text-red-200">
            {failedCount === 1 ? '1 faixa com falha no download' : `${failedCount} faixas com falha no download`}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {onRetryAllFailed && (
              <button
                type="button"
                onClick={() => void onRetryAllFailed()}
                disabled={batchRetryBusy || batchClearBusy}
                className="inline-flex shrink-0 items-center whitespace-nowrap rounded-lg border border-amber-300/30 bg-amber-400/15 px-2.5 py-1.5 text-xs font-semibold text-amber-100 transition hover:bg-amber-400/25 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {batchRetryBusy ? '↻ Tentando…' : '↻ Tentar novamente todas com falha'}
              </button>
            )}
            {onClearFailed && (
              <button
                type="button"
                onClick={() => void onClearFailed()}
                disabled={batchClearBusy || batchRetryBusy}
                className="inline-flex shrink-0 items-center whitespace-nowrap rounded-lg border border-red-300/30 bg-red-500/15 px-2.5 py-1.5 text-xs font-semibold text-red-100 transition hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {batchClearBusy ? 'Limpando…' : 'Limpar falhas da fila'}
              </button>
            )}
          </div>
        </div>
      )}
      <ol className="flex flex-col gap-2">
        {queue.map((entry, index) => {
          const voted = entry.voters.includes(me);
          const failed = (downloads[entry.trackId]?.status ?? entry.track.status) === 'error';
          const retrying = Boolean(retryingTrackIds?.[entry.trackId]);
          const allowRetry = failed && Boolean(onRetry) && (canRetry?.(entry) ?? true);
          const etaLabel = etas ? formatEta(etas[index]) : null;
          const retryControl = allowRetry ? (
            <button
              type="button"
              onClick={() => void onRetry!(entry)}
              disabled={retrying || batchRetryBusy}
              aria-label={`Tentar baixar novamente ${entry.track.title}`}
              className="inline-flex shrink-0 items-center whitespace-nowrap rounded-lg border border-amber-300/25 bg-amber-400/10 px-2 py-0.5 text-xs font-medium text-amber-200 transition hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {retrying ? 'tentando…' : 'tentar de novo'}
            </button>
          ) : null;

          return (
            <li key={entry.id} className="flex items-center gap-2.5 rounded-xl bg-white/5 p-2 sm:gap-3">
              <span className="w-5 shrink-0 text-center text-sm text-zinc-500">{index + 1}</span>
              <Cover
                src={entry.track.thumbnail}
                alt={entry.track.title}
                className={`${compact ? 'h-10 w-10' : 'h-11 w-11 sm:h-12 sm:w-12'} shrink-0 rounded-lg`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="min-w-0 flex-1 truncate font-medium">{entry.track.title}</p>
                  {etaLabel && (
                    <span
                      className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium text-zinc-300"
                      title="Tempo estimado de espera"
                    >
                      {etaLabel}
                    </span>
                  )}
                </div>
                <p className="truncate text-xs text-zinc-400">
                  {entry.track.artist || '—'} · {formatTime(entry.track.durationSec)} · pedido por {entry.requesterName}
                </p>
                <DownloadStatus entry={entry} live={downloads[entry.trackId]} retryControl={retryControl} />
              </div>
              <div className="flex shrink-0 items-center gap-1 sm:gap-2">
                {onVote ? (
                  <button
                    type="button"
                    onClick={() => onVote(entry)}
                    disabled={entry.requesterId === me}
                    aria-pressed={voted}
                    className={`flex min-w-11 shrink-0 flex-col items-center rounded-lg px-2 py-1 text-xs transition disabled:opacity-40 sm:min-w-12 ${
                      voted ? 'bg-accent text-white' : 'bg-white/10 hover:bg-white/20'
                    }`}
                  >
                    <span>▲</span>
                    <span className="font-semibold">{entry.votes}</span>
                  </button>
                ) : (
                  entry.votes > 0 && <span className="shrink-0 text-xs text-accent">▲ {entry.votes}</span>
                )}
                {onRemove && (canRemove?.(entry) ?? true) && (
                  <button
                    type="button"
                    onClick={() => onRemove(entry)}
                    aria-label="Remover da fila"
                    className="shrink-0 rounded-lg px-2 py-1 text-zinc-400 hover:bg-white/10 hover:text-red-300"
                  >
                    ✕
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
