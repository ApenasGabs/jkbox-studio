import type { TrackSource } from '../lib/types';

const LABELS: Record<TrackSource, { label: string; className: string }> = {
  youtube: { label: 'YouTube', className: 'bg-red-500/20 text-red-300' },
  spotify: { label: 'Spotify', className: 'bg-green-500/20 text-green-300' },
  local: { label: 'Acervo', className: 'bg-sky-500/20 text-sky-300' },
};

export function SourceBadge({ source, cached }: { source: TrackSource; cached?: boolean }) {
  const { label, className } = LABELS[source];
  return (
    <span className="inline-flex gap-1">
      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${className}`}>{label}</span>
      {cached && source !== 'local' && (
        <span className="rounded-full bg-amber-400/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-200">
          no disco
        </span>
      )}
    </span>
  );
}
