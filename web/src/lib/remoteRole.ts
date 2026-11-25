/** Main Controller (Host) vs Guest on `/remote`. */
export type RemoteRole = 'host' | 'guest';

export type RemoteHostTab = 'player' | 'autodj' | 'spotify' | 'library';

export const REMOTE_HOST_TABS: { id: RemoteHostTab; label: string }[] = [
  { id: 'player', label: '🎛 Player & TV' },
  { id: 'autodj', label: '🤖 Auto-DJ' },
  { id: 'spotify', label: '🟢 Spotify' },
  { id: 'library', label: '📚 Acervo & Rede' },
];

/**
 * Guests only search, request, vote, follow queue/lyrics and react. Host powers require a verified
 * PIN, unless the Host explicitly disabled the PIN (hostPinRequired=false). While the config is
 * still loading everybody is treated as a Guest, so Host controls never flash for guests.
 */
export function resolveRemoteRole(config: { hostPinRequired: boolean } | null, hostVerified: boolean): RemoteRole {
  if (!config) return 'guest';
  if (!config.hostPinRequired) return 'host';
  return hostVerified ? 'host' : 'guest';
}
