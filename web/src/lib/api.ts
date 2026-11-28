import type {
  AppConfig,
  AutoDjMode,
  CatalogAlbum,
  CatalogArtist,
  CatalogArtistDetail,
  CatalogCategory,
  CatalogSubcategory,
  DiscoveryMode,
  DiscoveryPopulateResponse,
  DiscoverySuggestResponse,
  DiscoveryTarget,
  JukeboxState,
  MdnsStatus,
  PlaybackOutput,
  PlaylistDetail,
  PlaylistEnqueueResponse,
  PlaylistImportResult,
  PlaylistSummary,
  QueueEntry,
  SearchResult,
  SpotifyDevice,
  SpotifyStatus,
  Track,
  TrackLyrics,
  TrackMetadataPatch,
  HostPinStatus,
  KioskControl,
  SystemUpdateApplyResult,
  SystemUpdateStatus,
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
  health: () => request<{ ok: boolean; version: string; downloadsActive: number }>('/api/health'),
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
  playlists: (trackId?: string, signal?: AbortSignal) => {
    const qs = trackId?.trim() ? `?${new URLSearchParams({ trackId: trackId.trim() })}` : '';
    return request<{ playlists: PlaylistSummary[] }>(`/api/playlists${qs}`, { signal });
  },
  playlist: (id: string, signal?: AbortSignal) =>
    request<PlaylistDetail>(`/api/playlists/${encodeURIComponent(id)}`, { signal }),
  createPlaylist: (payload: { name: string; description?: string | null }) =>
    post<PlaylistSummary>('/api/playlists', payload),
  updatePlaylist: (id: string, payload: { name?: string; description?: string | null }) =>
    request<PlaylistSummary>(`/api/playlists/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deletePlaylist: (id: string) =>
    request<void>(`/api/playlists/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  addTrackToPlaylist: (playlistId: string, trackId: string) =>
    post<{ added: boolean; duplicate: boolean; playlist: PlaylistSummary }>(
      `/api/playlists/${encodeURIComponent(playlistId)}/tracks`,
      { trackId },
    ),
  removeTrackFromPlaylist: (playlistId: string, trackId: string) =>
    request<void>(`/api/playlists/${encodeURIComponent(playlistId)}/tracks/${encodeURIComponent(trackId)}`, {
      method: 'DELETE',
    }),
  enqueuePlaylist: (playlistId: string, options?: { shuffle?: boolean; count?: number }) =>
    post<PlaylistEnqueueResponse>(`/api/playlists/${encodeURIComponent(playlistId)}/enqueue`, {
      clientId: getClientId(),
      name: getName(),
      ...(options?.shuffle !== undefined ? { shuffle: options.shuffle } : {}),
      ...(options?.count !== undefined ? { count: options.count } : {}),
    }),
  importPlaylist: (
    url: string,
    requester?: { clientId?: string; name?: string; enqueue?: boolean } | string,
  ) => {
    const opts = typeof requester === 'string' ? { name: requester } : (requester ?? {});
    return post<PlaylistImportResult>('/api/playlists/import', {
      url,
      clientId: opts.clientId !== undefined ? opts.clientId : getClientId(),
      name: opts.name !== undefined ? opts.name : getName(),
      ...(opts.enqueue !== undefined ? { enqueue: opts.enqueue } : {}),
    });
  },
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
  retry: (trackId: string) => post<{ cached: boolean }>(`/api/tracks/${encodeURIComponent(trackId)}/retry`),
  retryFailedQueue: () => post<{ retried: number; cached: number }>('/api/queue/retry-failed'),
  clearFailedQueue: () => request<{ removed: number }>('/api/queue/failed', { method: 'DELETE' }),
  lyrics: (trackId: string, signal?: AbortSignal) =>
    request<TrackLyrics>(`/api/tracks/${encodeURIComponent(trackId)}/lyrics`, { signal }),
  updateLyricsOffset: (trackId: string, offsetMs: number) =>
    request<TrackLyrics>(`/api/tracks/${encodeURIComponent(trackId)}/lyrics/offset`, {
      method: 'PATCH',
      body: JSON.stringify({ offsetMs }),
    }),
  verifyPin: (pin?: string) => post<{ ok: boolean }>('/api/host/verify', pin === undefined ? undefined : { pin }),
  hostPinStatus: () => request<HostPinStatus>('/api/host/pin'),
  updateHostPin: (patch: { pin?: string; enabled?: boolean }) =>
    request<HostPinStatus>('/api/host/pin', { method: 'PATCH', body: JSON.stringify(patch) }),
  kioskControl: (control: KioskControl) => post<{ ok: boolean; control: KioskControl }>('/api/kiosk/control', control),
  updateHostSettings: (settings: { autoDjEnabled: boolean }) =>
    request<{ autoDjEnabled: boolean }>('/api/host/settings', {
      method: 'PATCH',
      body: JSON.stringify(settings),
    }),
  updateHostname: (patch: { hostname?: string; useForQr?: boolean }) =>
    request<{ mdns: MdnsStatus }>('/api/config/hostname', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  systemUpdate: (refresh = false) =>
    request<SystemUpdateStatus>(`/api/system/update${refresh ? '?refresh=1' : ''}`),
  applySystemUpdate: () => post<SystemUpdateApplyResult>('/api/system/update/apply'),
  updateAutoDjConfig: (settings: {
    enabled?: boolean;
    mode?: AutoDjMode;
    category?: string | null;
    subgenre?: string | null;
    playlistId?: string | null;
  }) =>
    post<{
      autoDjEnabled: boolean;
      autoDjMode: AutoDjMode;
      autoDjCategory: string | null;
      autoDjSubgenre: string | null;
      autoDjPlaylistId: string | null;
    }>('/api/config/autodj', settings),
  rescanLibrary: () => post<{ added: number }>('/api/library/rescan'),
  autocategorizeLibrary: (options?: { force?: boolean }) =>
    post<{ processed: number; updated: number; skippedManual: number; failed: number }>(
      '/api/library/autocategorize',
      options?.force ? { force: true } : undefined,
    ),
  discoverySuggest: (
    payload: {
      mode: DiscoveryMode;
      playlistId?: string;
      category?: string;
      subgenre?: string | null;
      limit?: number;
    },
    signal?: AbortSignal,
  ) =>
    request<DiscoverySuggestResponse>('/api/discovery/suggest', {
      method: 'POST',
      body: JSON.stringify(payload),
      signal,
    }),
  discoveryPopulate: (payload: {
    tracks: SearchResult[];
    target: DiscoveryTarget;
    playlistId?: string;
  }) =>
    post<DiscoveryPopulateResponse>('/api/discovery/populate', {
      ...payload,
      clientId: getClientId(),
      name: getName(),
    }),
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
