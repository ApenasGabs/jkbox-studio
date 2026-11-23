interface GenreBadgesProps {
  genre?: string | null;
  subgenre?: string | null;
  variant?: 'kiosk-hero' | 'kiosk-compact' | 'remote';
}

export function GenreBadges({ genre, subgenre, variant = 'remote' }: GenreBadgesProps) {
  if (!genre && !subgenre) return null;

  if (variant === 'remote') {
    return (
      <>
        {genre && (
          <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-medium text-zinc-300">{genre}</span>
        )}
        {subgenre && (
          <span className="rounded-full border border-accent/30 bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-purple-200">
            {subgenre}
          </span>
        )}
      </>
    );
  }

  const sizeClass = variant === 'kiosk-hero' ? 'px-2.5 py-0.5 text-xs' : 'px-2 py-0.5 text-[11px]';
  return (
    <>
      {genre && (
        <span className={`rounded-full border border-accent/35 bg-accent/15 font-medium text-purple-200 ${sizeClass}`}>
          {genre}
        </span>
      )}
      {subgenre && (
        <span className={`rounded-full border border-white/15 bg-white/10 font-medium text-zinc-200 ${sizeClass}`}>
          {subgenre}
        </span>
      )}
    </>
  );
}
