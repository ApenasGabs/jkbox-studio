import type {
  AppConfig,
  AutoDjMode,
  CatalogAlbum,
  CatalogArtist,
  CatalogArtistDetail,
  CatalogCategory,
  CatalogSubcategory,
  JukeboxState,
  PlaybackOutput,
  QueueEntry,
  SearchResult,
  SpotifyDevice,
  SpotifyStatus,
  Track,
  TrackLyrics,
  TrackMetadataPatch,
} from './types';

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
    readonly code?: string,
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
  if (!res.ok) throw new ApiError(body.error ?? `Erro ${res.status}`, res.status, body.code);
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
  library: (q = '', signal?: AbortSignal) =>
    request<{ results: SearchResult[] }>(`/api/library?${new URLSearchParams({ q })}`, { signal }),
  catalogCategories: (signal?: AbortSignal) =>
    request<{ categories: CatalogCategory[] }>('/api/catalog/categories', { signal }),
  catalogCategoryTracks: (name: string, subgenre?: string | null, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (subgenre?.trim()) query.set('subgenre', subgenre.trim());
    const qs = query.toString();
    return request<{ category: string; subcategories?: CatalogSubcategory[]; tracks: SearchResult[] }>(
      `/api/catalog/categories/${encodeURIComponent(name)}/tracks${qs ? `?${qs}` : ''}`,
      { signal },
    );
  },
  catalogAlbums: (params?: { q?: string; category?: string }, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (params?.q?.trim()) query.set('q', params.q.trim());
    if (params?.category?.trim()) query.set('category', params.category.trim());
    const qs = query.toString();
    return request<{ albums: CatalogAlbum[] }>(`/api/catalog/albums${qs ? `?${qs}` : ''}`, { signal });
  },
  catalogAlbumTracks: (name: string, artist?: string, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (artist?.trim()) query.set('artist', artist.trim());
    const qs = query.toString();
    return request<{ album: string; artist: string | null; tracks: SearchResult[] }>(
      `/api/catalog/albums/${encodeURIComponent(name)}/tracks${qs ? `?${qs}` : ''}`,
      { signal },
    );
  },
  catalogArtists: (signal?: AbortSignal) =>
    request<{ artists: CatalogArtist[] }>('/api/catalog/artists', { signal }),
  catalogArtist: (name: string, signal?: AbortSignal) =>
    request<CatalogArtistDetail>(`/api/catalog/artists/${encodeURIComponent(name)}`, { signal }),
  updateTrackMetadata: (trackId: string, patch: TrackMetadataPatch) =>
    request<Track>(`/api/tracks/${encodeURIComponent(trackId)}/metadata`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  enqueue: (result: SearchResult) =>
    post<{ duplicate: boolean; cached: boolean }>('/api/queue', { result, clientId: getClientId(), name: getName() }),
  vote: (queueId: number) => post<{ voted: boolean }>(`/api/queue/${queueId}/vote`, { clientId: getClientId() }),
  remove: (queueId: number) =>
    request<void>(`/api/queue/${queueId}`, { method: 'DELETE', body: JSON.stringify({ clientId: getClientId() }) }),
  history: (limit = 30) =>
    request<{ history: QueueEntry[] }>(`/api/history?${new URLSearchParams({ limit: String(limit) })}`),
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
  updateAutoDjConfig: (settings: {
    enabled?: boolean;
    mode?: AutoDjMode;
    category?: string | null;
    subgenre?: string | null;
  }) =>
    post<{
      autoDjEnabled: boolean;
      autoDjMode: AutoDjMode;
      autoDjCategory: string | null;
      autoDjSubgenre: string | null;
    }>('/api/config/autodj', settings),
  rescanLibrary: () => post<{ added: number }>('/api/library/rescan'),
  autocategorizeLibrary: () =>
    post<{ processed: number; updated: number; skippedManual: number; failed: number }>('/api/library/autocategorize'),
  spotifySync: () => post<SpotifyStatus & { synced: number }>('/api/spotify/sync'),
  spotifyLinkPlaylist: (playlist: string) => post<SpotifyStatus>('/api/spotify/playlist', { playlist }),
  spotifyImport: () => post<{ imported: number }>('/api/spotify/import'),
  spotifyDisconnect: () => post<SpotifyStatus>('/api/spotify/disconnect'),
  spotifyDevices: () => request<{ devices: SpotifyDevice[]; playbackOutput: PlaybackOutput }>('/api/spotify/devices'),
  setSpotifyDevice: (deviceId: string | null) =>
    post<{ playbackOutput: PlaybackOutput }>('/api/spotify/device', { deviceId }),
  spotifyPause: () => post<{ ok: boolean; paused: boolean }>('/api/spotify/player/pause'),
  spotifyResume: () => post<{ ok: boolean; paused: boolean }>('/api/spotify/player/resume'),
  spotifySetVolume: (volume: number) => post<{ ok: boolean; volume: number }>('/api/spotify/player/volume', { volume }),
  streamUrl: (trackId: string) => `/api/tracks/${encodeURIComponent(trackId)}/stream`,
  videoUrl: (trackId: string) => `/api/tracks/${encodeURIComponent(trackId)}/video`,
  spotifyAuthUrl: () => {
    const pin = getHostPin();
    return `/api/spotify/auth${pin ? `?${new URLSearchParams({ pin })}` : ''}`;
  },
};
