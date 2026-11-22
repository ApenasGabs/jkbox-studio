import type { AppConfig, JukeboxState, SearchResult, SpotifyStatus, TrackLyrics } from './types';

const CLIENT_KEY = 'jkbox.clientId';
const NAME_KEY = 'jkbox.name';
const PIN_KEY = 'jkbox.hostPin';

function randomId(): string {
  // crypto.randomUUID requires a secure context, which plain-HTTP LAN access isn't.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function getClientId(): string {
  let id = localStorage.getItem(CLIENT_KEY);
  if (!id) {
    id = randomId();
    localStorage.setItem(CLIENT_KEY, id);
  }
  return id;
}

export const getName = () => localStorage.getItem(NAME_KEY) ?? '';
export const setName = (name: string) => localStorage.setItem(NAME_KEY, name);
export const getHostPin = () => localStorage.getItem(PIN_KEY) ?? '';
export const setHostPin = (pin: string) => localStorage.setItem(PIN_KEY, pin);

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const pin = getHostPin();
  if (pin) headers['x-host-pin'] = pin;
  const res = await fetch(path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? `Erro ${res.status}`, res.status);
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export type SearchSource = 'all' | 'youtube' | 'spotify' | 'local';

export const api = {
  config: () => request<AppConfig>('/api/config'),
  state: () => request<JukeboxState>('/api/state'),
  search: (q: string, source: SearchSource, signal?: AbortSignal) =>
    request<{ results: SearchResult[]; errors: Record<string, string> }>(
      `/api/search?${new URLSearchParams({ q, source })}`,
      { signal },
    ),
  library: (q = '') => request<{ results: SearchResult[] }>(`/api/library?${new URLSearchParams({ q })}`),
  enqueue: (result: SearchResult) =>
    post<{ duplicate: boolean; cached: boolean }>('/api/queue', { result, clientId: getClientId(), name: getName() }),
  vote: (queueId: number) => post<{ voted: boolean }>(`/api/queue/${queueId}/vote`, { clientId: getClientId() }),
  remove: (queueId: number) =>
    request<void>(`/api/queue/${queueId}`, { method: 'DELETE', body: JSON.stringify({ clientId: getClientId() }) }),
  skip: () => post<JukeboxState>('/api/player/skip'),
  ended: (queueId: number) => post<JukeboxState>('/api/player/ended', { queueId }),
  retry: (trackId: string) => post<{ cached: boolean }>(`/api/tracks/${trackId}/retry`),
  lyrics: (trackId: string, signal?: AbortSignal) =>
    request<TrackLyrics>(`/api/tracks/${encodeURIComponent(trackId)}/lyrics`, { signal }),
  updateLyricsOffset: (trackId: string, offsetMs: number) =>
    request<TrackLyrics>(`/api/tracks/${encodeURIComponent(trackId)}/lyrics/offset`, {
      method: 'PATCH',
      body: JSON.stringify({ offsetMs }),
    }),
  verifyPin: () => post<{ ok: boolean }>('/api/host/verify'),
  updateHostSettings: (settings: { autoDjEnabled: boolean }) =>
    request<{ autoDjEnabled: boolean }>('/api/host/settings', {
      method: 'PATCH',
      body: JSON.stringify(settings),
    }),
  rescanLibrary: () => post<{ added: number }>('/api/library/rescan'),
  spotifySync: () => post<SpotifyStatus & { synced: number }>('/api/spotify/sync'),
  spotifyLinkPlaylist: (playlist: string) => post<SpotifyStatus>('/api/spotify/playlist', { playlist }),
  spotifyImport: () => post<{ imported: number }>('/api/spotify/import'),
  spotifyDisconnect: () => post<SpotifyStatus>('/api/spotify/disconnect'),
  streamUrl: (trackId: string) => `/api/tracks/${encodeURIComponent(trackId)}/stream`,
  videoUrl: (trackId: string) => `/api/tracks/${encodeURIComponent(trackId)}/video`,
  spotifyAuthUrl: () => {
    const pin = getHostPin();
    return `/api/spotify/auth${pin ? `?${new URLSearchParams({ pin })}` : ''}`;
  },
};
