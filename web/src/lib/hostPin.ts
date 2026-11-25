/** Main Controller (Host) PIN helpers shared by Kiosk (`/`) and Remote (`/remote`). */

/** Builds the exclusive Main Controller link (`/remote?pin=<PIN>`) from the guest remote URL. */
export function buildHostControllerUrl(remoteUrl: string, pin: string): string {
  try {
    const url = new URL(remoteUrl);
    url.searchParams.set('pin', pin);
    return url.toString();
  } catch {
    const sep = remoteUrl.includes('?') ? '&' : '?';
    return `${remoteUrl}${sep}pin=${encodeURIComponent(pin)}`;
  }
}

export interface PinUrlEnv {
  location: Pick<Location, 'href'>;
  history: Pick<History, 'replaceState' | 'state'>;
}

/**
 * Reads `?pin=` from the address bar and removes it right away (history.replaceState), so the PIN
 * never lingers in the URL/screenshots/history. Returns the trimmed PIN or null.
 */
export function takePinFromUrl(env: PinUrlEnv = window): string | null {
  let url: URL;
  try {
    url = new URL(env.location.href);
  } catch {
    return null;
  }
  if (!url.searchParams.has('pin')) return null;
  const pin = (url.searchParams.get('pin') ?? '').trim();
  url.searchParams.delete('pin');
  const query = url.searchParams.toString();
  env.history.replaceState(env.history.state, '', `${url.pathname}${query ? `?${query}` : ''}${url.hash}`);
  return pin || null;
}

export interface ActivatePinDeps {
  getPin: () => string;
  setPin: (pin: string) => void;
  verify: (pin: string) => Promise<{ ok: boolean }>;
}

/**
 * Validates a PIN against `POST /api/host/verify`; only persists it in localStorage when valid.
 * Keeps the previous PIN on failure so a stale/bad QR never logs the Host out.
 */
export async function activateHostPin(pin: string, deps: ActivatePinDeps): Promise<boolean> {
  const previous = deps.getPin();
  try {
    const { ok } = await deps.verify(pin);
    if (ok) deps.setPin(pin);
    else deps.setPin(previous);
    return ok;
  } catch {
    deps.setPin(previous);
    return false;
  }
}
