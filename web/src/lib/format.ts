export function formatTime(totalSec: number | null | undefined): string {
  if (totalSec == null || !Number.isFinite(totalSec) || totalSec < 0) return '--:--';
  const sec = Math.floor(totalSec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** URL the guests should open on their phones. */
export function remoteUrl(publicUrl: string | null, origin: string = window.location.origin): string {
  return `${(publicUrl || origin).replace(/\/+$/, '')}/remote`;
}

export function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.');
  } catch {
    return false;
  }
}
