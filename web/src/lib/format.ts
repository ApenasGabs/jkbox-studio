import type { AppConfig, MdnsStatus } from './types';

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

/** Resolves the QR code target URL, preferring `.local` mDNS when enabled and toggled on. */
export const resolveRemoteQrUrl = (
  config: Pick<AppConfig, 'publicUrl'> | null | undefined,
  mdns: Pick<MdnsStatus, 'enabled' | 'useForQr' | 'url'> | null | undefined,
  origin: string = window.location.origin,
): string => {
  const baseUrl = mdns?.useForQr && mdns.enabled && mdns.url ? mdns.url : (config?.publicUrl ?? null);
  return remoteUrl(baseUrl, origin);
};

export function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.');
  } catch {
    return false;
  }
}

/** CSS `url()` value for an image, or null when it isn't a plain http(s) URL (prevents CSS injection). */
export function cssImageUrl(src: string | null | undefined): string | null {
  if (!src) return null;
  try {
    const url = new URL(src);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `url(${JSON.stringify(url.href)})`;
  } catch {
    return null;
  }
}
