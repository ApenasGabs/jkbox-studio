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
  onVote?: (entry: QueueEntry) => void;
  onRemove?: (entry: QueueEntry) => void;
  onRetry?: (entry: QueueEntry) => void;
  canRemove?: (entry: QueueEntry) => boolean;
  compact?: boolean;
}

function DownloadStatus({ entry, live }: { entry: QueueEntry; live?: DownloadInfo }) {
  const status = live?.status ?? entry.track.status;
  const progress = live?.progress ?? entry.track.progress;
  if (status === 'ready') return null;
  if (status === 'error') return <span className="text-xs text-red-300">falha no download</span>;
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

export function QueueList({ queue, downloads, currentRemainingSec, onVote, onRemove, onRetry, canRemove, compact }: Props) {
  const me = getClientId();
  if (queue.length === 0) {
    return <p className="py-6 text-center text-sm text-zinc-500">A fila está vazia. Peça uma música! 🎤</p>;
  }
  const etas = currentRemainingSec !== undefined ? computeQueueEtas(queue, currentRemainingSec) : null;
  return (
    <ol className="flex flex-col gap-2">
      {queue.map((entry, index) => {
        const voted = entry.voters.includes(me);
        const failed = (downloads[entry.trackId]?.status ?? entry.track.status) === 'error';
        const etaLabel = etas ? formatEta(etas[index]) : null;
        return (
          <li key={entry.id} className="flex items-center gap-3 rounded-xl bg-white/5 p-2">
            <span className="w-5 text-center text-sm text-zinc-500">{index + 1}</span>
            <Cover
              src={entry.track.thumbnail}
              alt={entry.track.title}
              className={`${compact ? 'h-10 w-10' : 'h-12 w-12'} shrink-0 rounded-lg`}
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
              <DownloadStatus entry={entry} live={downloads[entry.trackId]} />
            </div>
            {failed && onRetry && (
              <button onClick={() => onRetry(entry)} className="rounded-lg px-2 py-1 text-xs text-amber-200 hover:bg-white/10">
                tentar de novo
              </button>
            )}
            {onVote ? (
              <button
                onClick={() => onVote(entry)}
                disabled={entry.requesterId === me}
                aria-pressed={voted}
                className={`flex min-w-12 flex-col items-center rounded-lg px-2 py-1 text-xs transition disabled:opacity-40 ${
                  voted ? 'bg-accent text-white' : 'bg-white/10 hover:bg-white/20'
                }`}
              >
                <span>▲</span>
                <span className="font-semibold">{entry.votes}</span>
              </button>
            ) : (
              entry.votes > 0 && <span className="text-xs text-accent">▲ {entry.votes}</span>
            )}
            {onRemove && (canRemove?.(entry) ?? true) && (
              <button
                onClick={() => onRemove(entry)}
                aria-label="Remover da fila"
                className="rounded-lg px-2 py-1 text-zinc-400 hover:bg-white/10 hover:text-red-300"
              >
                ✕
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}
