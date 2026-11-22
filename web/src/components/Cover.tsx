interface Props {
  src: string | null | undefined;
  alt: string;
  className?: string;
}

export function Cover({ src, alt, className = '' }: Props) {
  if (!src) {
    return (
      <div
        className={`flex items-center justify-center bg-gradient-to-br from-accent/40 to-accent-2/30 text-3xl ${className}`}
        aria-label={alt}
      >
        🎵
      </div>
    );
  }
  return <img src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" className={`object-cover ${className}`} />;
}
