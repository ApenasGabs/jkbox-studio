import type { AppConfig, MdnsStatus } from './types';

export function formatTime(totalSec: number | null | undefined): string {
  if (totalSec == null || !Number.isFinite(totalSec) || totalSec < 0) return '--:--';
  const sec = Math.floor(totalSec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export type QrAddressMode = 'mdns' | 'ip';

export type QrConfigInput = (Pick<AppConfig, 'publicUrl'> & { lanUrl?: string | null }) | null | undefined;
export type QrMdnsInput = Pick<MdnsStatus, 'enabled' | 'useForQr' | 'url'> | null | undefined;

export interface RemoteAccessTargets {
  qrUrl: string;
  activeMode: 'mdns' | 'ip' | 'custom';
  mdnsRemoteUrl: string | null;
  ipRemoteUrl: string | null;
  alternateUrl: string | null;
  canToggleMode: boolean;
}

/** URL the guests should open on their phones. */
export const remoteUrl = (publicUrl: string | null, origin: string = window.location.origin): string =>
  `${(publicUrl || origin).replace(/\/+$/, '')}/remote`;

/**
 * Resolves the QR code target URL:
 * - Never returns a loopback URL (`127.0.0.1` / `localhost`) when `lanUrl` or `mdns.url` is available.
 * - Supports explicit 1-click override (`preferredMode`: `'mdns'` | `'ip'`).
 */
export const resolveRemoteQrUrl = (
  config: QrConfigInput,
  mdns: QrMdnsInput,
  origin: string = window.location.origin,
  preferredMode?: QrAddressMode | null,
): string => {
  const mdnsBase = mdns?.enabled && mdns.url ? mdns.url.trim().replace(/\/+$/, '') : null;
  const lanBase = config?.lanUrl && !isLoopback(config.lanUrl) ? config.lanUrl.trim().replace(/\/+$/, '') : null;
  const publicBase =
    config?.publicUrl && !isLoopback(config.publicUrl) ? config.publicUrl.trim().replace(/\/+$/, '') : null;
  const safeOrigin = !isLoopback(origin) ? origin.trim().replace(/\/+$/, '') : null;

  let baseUrl: string | null = null;
  if (preferredMode === 'mdns') {
    baseUrl = mdnsBase ?? lanBase ?? publicBase ?? safeOrigin;
  } else if (preferredMode === 'ip') {
    baseUrl = lanBase ?? publicBase ?? safeOrigin ?? mdnsBase;
  } else if (mdns?.useForQr && mdnsBase) {
    baseUrl = mdnsBase;
  } else {
    baseUrl = publicBase ?? lanBase ?? safeOrigin ?? mdnsBase;
  }

  return remoteUrl(baseUrl ?? config?.publicUrl ?? null, origin);
};

/** Computes primary QR URL, `.local` URL, direct LAN IP URL, and 1-click toggle metadata for the Kiosk. */
export const resolveRemoteAccessUrls = (
  config: QrConfigInput,
  mdns: QrMdnsInput,
  origin: string = window.location.origin,
  preferredMode?: QrAddressMode | null,
): RemoteAccessTargets => {
  const qrUrl = resolveRemoteQrUrl(config, mdns, origin, preferredMode);
  const mdnsRemoteUrl = mdns?.enabled && mdns.url ? remoteUrl(mdns.url, origin) : null;
  const ipRemoteUrl = config?.lanUrl && !isLoopback(config.lanUrl) ? remoteUrl(config.lanUrl, origin) : null;
  const canToggleMode = Boolean(mdnsRemoteUrl && ipRemoteUrl && mdnsRemoteUrl !== ipRemoteUrl);

  const activeMode: 'mdns' | 'ip' | 'custom' =
    mdnsRemoteUrl && qrUrl === mdnsRemoteUrl
      ? 'mdns'
      : ipRemoteUrl && qrUrl === ipRemoteUrl
        ? 'ip'
        : 'custom';

  const rawAlternate =
    activeMode === 'mdns'
      ? ipRemoteUrl
      : activeMode === 'ip'
        ? mdnsRemoteUrl
        : (ipRemoteUrl ?? mdnsRemoteUrl);

  return {
    qrUrl,
    activeMode,
    mdnsRemoteUrl,
    ipRemoteUrl,
    alternateUrl: rawAlternate && rawAlternate !== qrUrl ? rawAlternate : null,
    canToggleMode,
  };
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
