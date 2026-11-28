import { isLoopback } from './format';
import { type RemoteRole, resolveRemoteRole } from './remoteRole';
import type { KioskCommand } from './types';

export const EMBEDDED_GUEST_RETURN_LABEL = '✕ Voltar para a TV (Kiosk)';
export const STANDALONE_KIOSK_RETURN_LABEL = '← Voltar ao Kiosk';
export const STANDALONE_KIOSK_RETURN_HREF = '/';

/** Returns true when `href` carries `?from=kiosk` (case-insensitive). */
export const hasFromKioskQuery = (href: string): boolean => {
  const trimmed = href.trim();
  if (!trimmed || !URL.canParse(trimmed, 'http://jkbox.invalid')) return false;
  const parsed = new URL(trimmed, 'http://jkbox.invalid');
  return parsed.searchParams.get('from')?.trim().toLowerCase() === 'kiosk';
};

/**
 * Determines whether standalone `/remote` should display the fixed `← Voltar ao Kiosk`
 * safety link (true on loopback `127.*`, `localhost`, `[::1]`, or `?from=kiosk`;
 * false for regular guests opening `/remote` over LAN IP or `.local` mDNS).
 */
export const shouldShowReturnToKiosk = (href: string): boolean => {
  const trimmed = href.trim();
  if (!trimmed) return false;
  return isLoopback(trimmed) || hasFromKioskQuery(trimmed);
};

/**
 * Resolves the effective role on `/remote`, forcing `'guest'` whenever rendered
 * as an embedded overlay inside `<Kiosk />` so guests on the TV never inherit Host powers.
 */
export const resolveEffectiveRemoteRole = (
  config: { hostPinRequired: boolean } | null,
  hostVerified: boolean,
  embedded = false,
): RemoteRole => (embedded ? 'guest' : resolveRemoteRole(config, hostVerified));

/**
 * Computes the next `guestModeOpen` state when `<Kiosk />` receives a Kiosk input command
 * (`Esc` / `BACK` from keyboard, gamepad or `jkbox-buttons` long-press `SELECT`, or `MENU`).
 */
export const resolveGuestModeAfterCommand = (guestModeOpen: boolean, command: KioskCommand): boolean => {
  if (!guestModeOpen) return false;
  if (command === 'BACK' || command === 'MENU') return false;
  return true;
};
