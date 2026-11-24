import { randomBytes } from 'node:crypto';
import type { Config } from '../config.js';
import type { Settings } from '../db.js';
import { artistsMatch, normalizeArtistForMatch } from '../lib/artistMatch.js';
import { SPOTIFY_ID_RE } from '../lib/validate.js';
import type { SearchResult, SpotifyDevice, SpotifyPlaybackState } from '../types.js';
import type { ExtractedPlaylist } from './ytdlp.js';

const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';
const PLAYBACK_SCOPES = ['user-read-playback-state', 'user-modify-playback-state'] as const;
const SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-public',
  'playlist-modify-private',
  ...PLAYBACK_SCOPES,
];

interface UserTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope?: string;
}

interface SpotifyTrack {
  id: string;
  uri: string;
  name: string;
  duration_ms?: number | null;
  artists: { id?: string; name: string }[];
  album?: { name: string; release_date?: string; images?: { url: string; width?: number }[] };
  type?: string;
}

interface SpotifyArtist {
  id: string;
  name: string;
  genres?: string[];
}

interface SpotifyApiDevice {
  id: string | null;
  is_active: boolean;
  is_private_session?: boolean;
  is_restricted: boolean;
  name: string;
  type: string;
  volume_percent: number | null;
  supports_volume?: boolean;
}

interface SpotifyApiPlaybackState {
  device?: SpotifyApiDevice | null;
  is_playing?: boolean;
  progress_ms?: number | null;
  item?: SpotifyTrack | null;
}

interface PlaylistEntry {
  item?: SpotifyTrack | null;
  track?: SpotifyTrack | null;
}

interface SpotifyPlaylistPage {
  items?: PlaylistEntry[];
  next?: string | null;
  total?: number;
}

interface SpotifyPlaylistMeta {
  id?: string;
  name?: string;
  description?: string | null;
  images?: { url: string; width?: number }[];
  tracks?: SpotifyPlaylistPage;
  items?: SpotifyPlaylistPage;
}

function mapPlaylistEntries(entries: PlaylistEntry[]): SearchResult[] {
  const results: SearchResult[] = [];
  for (const entry of entries) {
    const track = entry.item ?? entry.track;
    if (track && track.id && (track.type ?? 'track') === 'track') {
      results.push(spotifyTrackToResult(track));
    }
  }
  return results;
}

export type SpotifyErrorCode = 'PREMIUM_REQUIRED' | 'NO_ACTIVE_DEVICE' | 'INSUFFICIENT_SCOPE' | (string & {});

export class SpotifyError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly code?: SpotifyErrorCode,
  ) {
    super(message);
  }
}

export type FetchFn = typeof fetch;

function mapDevice(device: SpotifyApiDevice): SpotifyDevice {
  return {
    id: device.id ?? '',
    name: device.name,
    type: device.type,
    isActive: Boolean(device.is_active),
    isRestricted: Boolean(device.is_restricted),
    volumePercent: typeof device.volume_percent === 'number' ? device.volume_percent : null,
    supportsVolume: device.supports_volume ?? true,
  };
}

function hasPlaybackScopes(tokens: UserTokens | null): boolean {
  if (!tokens?.scope) return false;
  const granted = new Set(tokens.scope.split(/\s+/).filter(Boolean));
  return PLAYBACK_SCOPES.every((scope) => granted.has(scope));
}

export function spotifyTrackToResult(track: SpotifyTrack): SearchResult {
  const images = track.album?.images ?? [];
  const durationSec =
    typeof track.duration_ms === 'number' && Number.isFinite(track.duration_ms) && track.duration_ms >= 0
      ? Math.round(track.duration_ms / 1000)
      : null;
  return {
    source: 'spotify',
    sourceId: track.id,
    title: track.name,
    artist: (track.artists ?? []).map((a) => a.name).join(', '),
    album: track.album?.name ?? null,
    durationSec,
    thumbnail: [...images].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ?? null,
    spotifyUri: track.uri,
  };
}

/**
 * Spotify Web API integration. Everything degrades gracefully: when credentials are missing,
 * `configured` is false and callers simply hide Spotify features.
 */
export class SpotifyService {
  private appToken: { token: string; expiresAt: number } | null = null;
  private readonly pendingStates = new Map<string, number>();

  constructor(
    private readonly config: Config['spotify'],
    private readonly settings: Settings,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  get configured(): boolean {
    return !!(this.config.clientId && this.config.clientSecret);
  }

  get connected(): boolean {
    return this.configured && !!this.settings.get<UserTokens>('spotify_tokens');
  }

  get playbackAuthorized(): boolean {
    return this.configured && hasPlaybackScopes(this.settings.get<UserTokens>('spotify_tokens'));
  }

  get playlistId(): string | null {
    return this.settings.get<string>('spotify_playlist_id');
  }

  status() {
    const playlistId = this.playlistId;
    return {
      configured: this.configured,
      connected: this.connected,
      playbackAuthorized: this.playbackAuthorized,
      playlistId,
      playlistUrl: playlistId ? `https://open.spotify.com/playlist/${playlistId}` : null,
      redirectUri: this.configured ? this.config.redirectUri : null,
    };
  }

  private requireConfigured(): void {
    if (!this.configured) {
      throw new SpotifyError('Spotify não configurado (defina SPOTIFY_CLIENT_ID e SPOTIFY_CLIENT_SECRET)', 503);
    }
  }

  getAuthUrl(): string {
    this.requireConfigured();
    const state = randomBytes(16).toString('hex');
    this.pendingStates.set(state, Date.now() + 10 * 60_000);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      scope: SCOPES.join(' '),
      redirect_uri: this.config.redirectUri,
      state,
    });
    return `${ACCOUNTS}/authorize?${params}`;
  }

  async handleCallback(code: string, state: string): Promise<void> {
    this.requireConfigured();
    const expires = this.pendingStates.get(state);
    this.pendingStates.delete(state);
    if (!expires || expires < Date.now()) throw new SpotifyError('Estado OAuth inválido ou expirado', 400);
    const data = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
    });
    this.saveUserTokens(data);
  }

  disconnect(): void {
    this.settings.delete('spotify_tokens');
  }

  async search(query: string, limit = 10): Promise<SearchResult[]> {
    this.requireConfigured();
    // Development-mode apps are capped at 10 results per page.
    const params = new URLSearchParams({ q: query, type: 'track', limit: String(Math.min(limit, 10)) });
    const data = await this.api<{ tracks: { items: SpotifyTrack[] } }>(`/search?${params}`);
    return data.tracks.items.filter(Boolean).map(spotifyTrackToResult);
  }

  async getTrack(id: string): Promise<SearchResult> {
    this.requireConfigured();
    return spotifyTrackToResult(await this.api<SpotifyTrack>(`/tracks/${encodeURIComponent(id)}`));
  }

  /** Fetches Spotify artist genres (and album release year) for a track ID using app or user auth. */
  async getTrackArtistGenres(id: string): Promise<{ genres: string[]; year: number | null; artistName?: string }> {
    this.requireConfigured();
    const track = await this.api<SpotifyTrack>(`/tracks/${encodeURIComponent(id)}`);
    const yearMatch = track.album?.release_date?.match(/^(\d{4})\b/);
    const year = yearMatch ? Number(yearMatch[1]) : null;
    const primaryArtist = track.artists?.[0];
    if (!primaryArtist?.id) return { genres: [], year, artistName: primaryArtist?.name };
    const artist = await this.api<SpotifyArtist>(`/artists/${encodeURIComponent(primaryArtist.id)}`);
    return {
      genres: Array.isArray(artist.genres) ? artist.genres : [],
      year: year && year >= 1000 && year <= 2100 ? year : null,
      artistName: artist.name || primaryArtist.name,
    };
  }

  /** Searches Spotify artists by name and returns genres for the closest strict match. */
  async searchArtistGenres(artistName: string): Promise<string[]> {
    this.requireConfigured();
    const query = artistName.trim();
    if (!query) return [];
    const params = new URLSearchParams({ q: query, type: 'artist', limit: '3' });
    const data = await this.api<{ artists?: { items?: SpotifyArtist[] } }>(`/search?${params}`);
    const items = (data.artists?.items ?? []).filter(Boolean);
    if (items.length === 0) return [];
    const normalizedTarget = normalizeArtistForMatch(query);
    const exact = items.find((a) => normalizeArtistForMatch(a.name) === normalizedTarget);
    const matched = exact ?? items.find((a) => artistsMatch([query], a.name));
    if (!matched) return [];
    return Array.isArray(matched.genres) ? matched.genres : [];
  }

  async getAlbumTracks(id: string, limit = 50): Promise<SearchResult[]> {
    const details = await this.getAlbumDetails(id, limit);
    return details.tracks.slice(0, limit);
  }

  /** Fetches album metadata and up to `limit` tracks (preserving real `totalCount`). */
  async getAlbumDetails(id: string, limit = 500): Promise<ExtractedPlaylist> {
    this.requireConfigured();
    if (!SPOTIFY_ID_RE.test(id)) throw new SpotifyError('ID de álbum do Spotify inválido', 400);
    const album = await this.api<{
      name: string;
      artists?: { name: string }[];
      images?: { url: string; width?: number }[];
      total_tracks?: number;
      tracks: { items: SpotifyTrack[]; next?: string | null; total?: number };
    }>(`/albums/${encodeURIComponent(id)}`, {}, 'any');

    const title = album.name?.trim() || `Álbum Spotify (${id})`;
    const artistNames = (album.artists ?? []).map((a) => a.name).filter(Boolean).join(', ');
    const description = artistNames ? `Álbum · ${artistNames}` : null;
    const thumbnail = [...(album.images ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ?? null;
    const totalCount =
      typeof album.total_tracks === 'number' && Number.isFinite(album.total_tracks)
        ? album.total_tracks
        : typeof album.tracks?.total === 'number' && Number.isFinite(album.tracks.total)
          ? album.tracks.total
          : null;

    const maxTracks = Math.max(1, limit);
    const items: SpotifyTrack[] = [...(album.tracks?.items ?? [])];
    let nextPath = album.tracks?.next ? album.tracks.next.replace(API, '') : null;
    while (nextPath && items.length < maxTracks) {
      const page = await this.api<{ items?: SpotifyTrack[]; next?: string | null }>(nextPath, {}, 'any');
      items.push(...(page.items ?? []));
      nextPath = page.next ? page.next.replace(API, '') : null;
    }

    const tracks = items
      .slice(0, maxTracks)
      .map((t) => spotifyTrackToResult({ ...t, album: { name: title, images: album.images } }));

    return {
      title,
      description,
      thumbnail: thumbnail ?? tracks[0]?.thumbnail ?? null,
      totalCount: totalCount ?? tracks.length,
      tracks,
    };
  }

  /** Requires user OAuth: Spotify only returns items for playlists the user owns or collaborates on. */
  async getPlaylistTracks(id: string, limit = 100): Promise<SearchResult[]> {
    this.requireConfigured();
    return this.fetchPlaylistItems(id, limit, 'user');
  }

  /**
   * Public embed fallback for Spotify editorial/algorithmic playlists (e.g. `37i9dQZF1...` Radios/Mixes)
   * that Spotify's Web API blocks with 404 for third-party apps.
   */
  private async fetchPlaylistFromPublicEmbed(id: string, limit: number): Promise<ExtractedPlaylist | null> {
    try {
      const res = await this.fetchFn(`https://open.spotify.com/embed/playlist/${encodeURIComponent(id)}`, {
        headers: { 'user-agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return null;
      const html = await res.text();
      const match = html.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json">([\s\S]*?)<\/script>/);
      if (!match?.[1]) return null;

      const parsed = JSON.parse(match[1]) as {
        props?: {
          pageProps?: {
            state?: {
              data?: {
                entity?: {
                  name?: string;
                  subtitle?: string;
                  coverArt?: { sources?: { url?: string; width?: number }[] };
                  trackList?: {
                    uri?: string;
                    title?: string;
                    subtitle?: string;
                    duration?: number;
                    entityType?: string;
                  }[];
                };
              };
            };
          };
        };
      };

      const entity = parsed?.props?.pageProps?.state?.data?.entity;
      const list = entity?.trackList;
      if (!entity || !Array.isArray(list) || list.length === 0) return null;

      const title = entity.name?.trim() || `Playlist Spotify (${id})`;
      const description = entity.subtitle?.trim() || null;
      const covers = (entity.coverArt?.sources ?? []).filter((s): s is { url: string; width?: number } => Boolean(s.url));
      const thumbnail = [...covers].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ?? null;

      const fetchLimit = Math.max(1, limit) + 1;
      const tracks: SearchResult[] = [];
      for (const item of list) {
        if (tracks.length >= fetchLimit) break;
        const uriMatch = item.uri?.match(/^spotify:track:([A-Za-z0-9]+)$/);
        const trackTitle = item.title?.trim();
        if (!uriMatch || !trackTitle) continue;
        const artist = (item.subtitle ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
        const durationSec =
          typeof item.duration === 'number' && Number.isFinite(item.duration) && item.duration > 0
            ? Math.round(item.duration / 1000)
            : null;
        tracks.push({
          source: 'spotify',
          sourceId: uriMatch[1]!,
          title: trackTitle,
          artist,
          album: null,
          durationSec,
          thumbnail,
          spotifyUri: item.uri!,
        });
      }

      if (tracks.length === 0) return null;
      return {
        title,
        description,
        thumbnail,
        totalCount: list.length,
        tracks,
      };
    } catch {
      return null;
    }
  }

  /** Fetches playlist metadata and up to `limit` tracks (preserving real `totalCount`). */
  async getPlaylistDetails(id: string, limit = 500): Promise<ExtractedPlaylist> {
    this.requireConfigured();
    if (!SPOTIFY_ID_RE.test(id)) throw new SpotifyError('ID de playlist do Spotify inválido', 400);

    let meta: SpotifyPlaylistMeta;
    try {
      meta = await this.api<SpotifyPlaylistMeta>(`/playlists/${encodeURIComponent(id)}`, {}, 'any');
    } catch (err) {
      if (err instanceof SpotifyError && (err.status === 404 || err.status === 403)) {
        const embedded = await this.fetchPlaylistFromPublicEmbed(id, limit);
        if (embedded) return embedded;
        if (id.startsWith('37i9dQZF1')) {
          throw new SpotifyError(
            'Rádio/Mix oficial do Spotify indisponível via API. Salve as faixas em uma playlist sua no Spotify e cole o link dela.',
            404,
            'SPOTIFY_EDITORIAL_BLOCKED',
          );
        }
      }
      throw err;
    }

    const title = meta.name?.trim() || `Playlist Spotify (${id})`;
    const description = meta.description?.trim() || null;
    const thumbnail = [...(meta.images ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ?? null;
    const inlinePage = meta.tracks ?? meta.items;
    const metaTotal = typeof inlinePage?.total === 'number' && Number.isFinite(inlinePage.total) ? inlinePage.total : null;

    const maxTracks = Math.max(1, limit);
    let tracks: SearchResult[];
    let pageTotal: number | null = metaTotal;

    if (Array.isArray(inlinePage?.items) && !inlinePage.next) {
      tracks = mapPlaylistEntries(inlinePage.items).slice(0, maxTracks);
    } else {
      const fetched = await this.fetchPlaylistItemsWithTotal(id, maxTracks, 'any');
      tracks = fetched.tracks;
      if (pageTotal === null && fetched.total !== null) pageTotal = fetched.total;
    }

    return {
      title,
      description,
      thumbnail: thumbnail ?? tracks[0]?.thumbnail ?? null,
      totalCount: pageTotal ?? tracks.length,
      tracks,
    };
  }

  private async fetchPlaylistItems(id: string, limit: number, kind: 'user' | 'any'): Promise<SearchResult[]> {
    return (await this.fetchPlaylistItemsWithTotal(id, limit, kind)).tracks;
  }

  private async fetchPlaylistItemsWithTotal(
    id: string,
    limit: number,
    kind: 'user' | 'any',
  ): Promise<{ tracks: SearchResult[]; total: number | null }> {
    const results: SearchResult[] = [];
    let total: number | null = null;
    let path: string | null = `/playlists/${encodeURIComponent(id)}/items?limit=50`;
    while (path && results.length < limit) {
      const page: SpotifyPlaylistPage = await this.api(path, {}, kind);
      if (total === null && typeof page.total === 'number' && Number.isFinite(page.total)) {
        total = page.total;
      }
      results.push(...mapPlaylistEntries(page.items ?? []));
      path = page.next ? page.next.replace(API, '') : null;
    }
    return { tracks: results.slice(0, limit), total };
  }

  async getDevices(): Promise<SpotifyDevice[]> {
    this.requireConfigured();
    const data = await this.api<{ devices?: SpotifyApiDevice[] }>('/me/player/devices', {}, 'user');
    return (data?.devices ?? []).filter((d) => Boolean(d.id)).map(mapDevice);
  }

  async getPlaybackState(): Promise<SpotifyPlaybackState | null> {
    this.requireConfigured();
    const data = await this.api<SpotifyApiPlaybackState | undefined>('/me/player', {}, 'user');
    if (!data) return null;
    const item = data.item;
    const mappedTrack =
      item && item.id && item.name && (item.type ?? 'track') === 'track' ? spotifyTrackToResult(item) : null;
    return {
      isPlaying: Boolean(data.is_playing),
      progressMs: typeof data.progress_ms === 'number' ? Math.max(0, data.progress_ms) : 0,
      device: data.device?.id ? mapDevice(data.device) : null,
      trackUri: item?.uri ?? null,
      trackId: item?.id ?? null,
      durationMs:
        typeof item?.duration_ms === 'number' && Number.isFinite(item.duration_ms) && item.duration_ms >= 0
          ? item.duration_ms
          : null,
      track: mappedTrack,
    };
  }

  async transferPlayback(deviceId: string, play = false): Promise<void> {
    this.requireConfigured();
    await this.api(
      '/me/player',
      {
        method: 'PUT',
        body: JSON.stringify({ device_ids: [deviceId], play }),
      },
      'user',
    );
  }

  async playTrack(uri: string, deviceId?: string, positionMs?: number): Promise<void> {
    this.requireConfigured();
    const query = deviceId ? `?${new URLSearchParams({ device_id: deviceId })}` : '';
    const body: { uris: string[]; position_ms?: number } = { uris: [uri] };
    if (typeof positionMs === 'number' && Number.isFinite(positionMs) && positionMs > 0) {
      body.position_ms = Math.round(positionMs);
    }
    await this.api(
      `/me/player/play${query}`,
      {
        method: 'PUT',
        body: JSON.stringify(body),
      },
      'user',
    );
  }

  async pausePlayback(deviceId?: string): Promise<void> {
    this.requireConfigured();
    const query = deviceId ? `?${new URLSearchParams({ device_id: deviceId })}` : '';
    await this.api(`/me/player/pause${query}`, { method: 'PUT' }, 'user');
  }

  async resumePlayback(deviceId?: string): Promise<void> {
    this.requireConfigured();
    const query = deviceId ? `?${new URLSearchParams({ device_id: deviceId })}` : '';
    await this.api(`/me/player/play${query}`, { method: 'PUT' }, 'user');
  }

  async setVolume(volumePercent: number, deviceId?: string): Promise<void> {
    this.requireConfigured();
    const clamped = Math.max(0, Math.min(100, Math.round(volumePercent)));
    const params = new URLSearchParams({ volume_percent: String(clamped) });
    if (deviceId) params.set('device_id', deviceId);
    await this.api(`/me/player/volume?${params}`, { method: 'PUT' }, 'user');
  }

  /** Creates (or reuses) the shared collaborative playlist for the jukebox session. */
  async ensurePlaylist(): Promise<string> {
    this.requireConfigured();
    if (!this.connected) throw new SpotifyError('Conecte uma conta Spotify primeiro', 409);
    const existing = this.playlistId;
    if (existing) {
      try {
        await this.api(`/playlists/${encodeURIComponent(existing)}?fields=id`, {}, 'user');
        return existing;
      } catch (err) {
        if (!(err instanceof SpotifyError) || err.status !== 404) throw err;
        // Never silently replace a playlist the host linked explicitly.
        if (this.settings.get<boolean>('spotify_playlist_linked')) {
          throw new SpotifyError('A playlist vinculada não foi encontrada no Spotify. Vincule outra ou crie uma nova.', 404);
        }
      }
    }
    const created = await this.api<{ id: string }>(
      '/me/playlists',
      {
        method: 'POST',
        body: JSON.stringify({
          name: this.config.playlistName,
          public: false,
          collaborative: true,
          description: 'Playlist compartilhada da jukebox jkbox-studio 🎶',
        }),
      },
      'user',
    );
    this.settings.set('spotify_playlist_id', created.id);
    this.settings.set('spotify_playlist_linked', false);
    this.settings.set('spotify_seen_uris', []);
    return created.id;
  }

  /**
   * Links an existing playlist (by id) instead of creating a new one. Songs already in it are
   * marked as seen, so only songs added from now on get imported into the queue.
   */
  async linkPlaylist(id: string): Promise<void> {
    this.requireConfigured();
    if (!SPOTIFY_ID_RE.test(id)) throw new SpotifyError('ID de playlist do Spotify inválido', 400);
    if (!this.connected) throw new SpotifyError('Conecte uma conta Spotify primeiro', 409);
    await this.api(`/playlists/${encodeURIComponent(id)}?fields=id`, {}, 'user');
    const current = await this.getPlaylistTracks(id, 500);
    this.settings.set('spotify_playlist_id', id);
    this.settings.set('spotify_playlist_linked', true);
    this.settings.set('spotify_seen_uris', []);
    this.markSeen(current.map((t) => t.spotifyUri).filter((u): u is string => !!u));
  }

  async addToPlaylist(uris: string[]): Promise<void> {
    if (uris.length === 0) return;
    const playlistId = await this.ensurePlaylist();
    for (let i = 0; i < uris.length; i += 100) {
      await this.api(
        `/playlists/${encodeURIComponent(playlistId)}/items`,
        { method: 'POST', body: JSON.stringify({ uris: uris.slice(i, i + 100) }) },
        'user',
      );
    }
    this.markSeen(uris);
  }

  /** Returns playlist tracks that weren't added by the jukebox itself nor imported before. */
  async fetchNewPlaylistTracks(): Promise<SearchResult[]> {
    const playlistId = this.playlistId;
    if (!this.connected || !playlistId) return [];
    const seen = new Set(this.settings.get<string[]>('spotify_seen_uris') ?? []);
    const tracks = await this.getPlaylistTracks(playlistId, 500);
    const fresh = tracks.filter((t) => t.spotifyUri && !seen.has(t.spotifyUri));
    this.markSeen(fresh.map((t) => t.spotifyUri!));
    return fresh;
  }

  private markSeen(uris: string[]): void {
    const seen = new Set(this.settings.get<string[]>('spotify_seen_uris') ?? []);
    uris.forEach((u) => seen.add(u));
    this.settings.set('spotify_seen_uris', [...seen].slice(-5000));
  }

  private saveUserTokens(data: { access_token: string; refresh_token?: string; expires_in: number; scope?: string }): void {
    const previous = this.settings.get<UserTokens>('spotify_tokens');
    const refreshToken = data.refresh_token ?? previous?.refreshToken;
    if (!refreshToken) throw new SpotifyError('Spotify não retornou refresh_token');
    const scope = data.scope ?? previous?.scope;
    this.settings.set('spotify_tokens', {
      accessToken: data.access_token,
      refreshToken,
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
      ...(scope ? { scope } : {}),
    } satisfies UserTokens);
  }

  private async tokenRequest(
    body: Record<string, string>,
  ): Promise<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string }> {
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
    const res = await this.fetchFn(`${ACCOUNTS}/api/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    if (!res.ok) throw new SpotifyError(`Falha na autenticação Spotify (${res.status})`, res.status === 400 ? 401 : 502);
    return (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
  }

  private async accessToken(kind: 'app' | 'user' | 'any'): Promise<string> {
    const tokens = this.settings.get<UserTokens>('spotify_tokens');
    if (tokens && kind !== 'app') {
      if (tokens.expiresAt > Date.now()) return tokens.accessToken;
      this.saveUserTokens(await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken }));
      return this.settings.get<UserTokens>('spotify_tokens')!.accessToken;
    }
    if (kind === 'user') throw new SpotifyError('Conecte uma conta Spotify primeiro', 409);
    if (this.appToken && this.appToken.expiresAt > Date.now()) return this.appToken.token;
    const data = await this.tokenRequest({ grant_type: 'client_credentials' });
    this.appToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
    return this.appToken.token;
  }

  private async api<T>(path: string, init: RequestInit = {}, kind: 'app' | 'user' | 'any' = 'any'): Promise<T> {
    const token = await this.accessToken(kind);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    if (init.body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const res = await this.fetchFn(`${API}${path}`, {
      ...init,
      headers,
    });
    if (!res.ok) {
      let detail = '';
      let reason = '';
      try {
        const body = (await res.json()) as { error?: { message?: string; reason?: string } };
        detail = body.error?.message ?? '';
        reason = body.error?.reason ?? '';
      } catch {
        /* ignore */
      }
      if (reason === 'PREMIUM_REQUIRED' || (res.status === 403 && /premium/i.test(detail))) {
        throw new SpotifyError(
          'Conta Spotify Premium necessária para controlar dispositivos Spotify Connect',
          403,
          'PREMIUM_REQUIRED',
        );
      }
      if (reason === 'NO_ACTIVE_DEVICE' || (res.status === 404 && /no active device|device not found/i.test(detail))) {
        throw new SpotifyError(
          'Nenhum dispositivo Spotify Connect ativo encontrado. Abra o Spotify na caixa de som ou TV.',
          404,
          'NO_ACTIVE_DEVICE',
        );
      }
      if (res.status === 403 && /scope/i.test(detail)) {
        throw new SpotifyError(
          'Permissão de playback ausente no token. Clique em Reconectar Spotify.',
          403,
          'INSUFFICIENT_SCOPE',
        );
      }
      throw new SpotifyError(`Spotify API ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
