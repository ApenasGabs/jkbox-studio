import { randomBytes } from 'node:crypto';
import type { Config } from '../config.js';
import type { Settings } from '../db.js';
import { SPOTIFY_ID_RE } from '../lib/validate.js';
import type { SearchResult } from '../types.js';

const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';
const SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-public',
  'playlist-modify-private',
];

interface UserTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface SpotifyTrack {
  id: string;
  uri: string;
  name: string;
  duration_ms: number;
  artists: { name: string }[];
  album?: { name: string; images?: { url: string; width?: number }[] };
  type?: string;
}

interface PlaylistEntry {
  item?: SpotifyTrack | null;
  track?: SpotifyTrack | null;
}

export class SpotifyError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

export type FetchFn = typeof fetch;

export function spotifyTrackToResult(track: SpotifyTrack): SearchResult {
  const images = track.album?.images ?? [];
  return {
    source: 'spotify',
    sourceId: track.id,
    title: track.name,
    artist: track.artists.map((a) => a.name).join(', '),
    album: track.album?.name ?? null,
    durationSec: Math.round(track.duration_ms / 1000),
    thumbnail: [...images].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ?? null,
    spotifyUri: track.uri,
  };
}

/** Query used to find the matching audio on YouTube (spotDL approach). */
export function youtubeQueryFor(result: { title: string; artist: string }): string {
  return `${result.artist} - ${result.title} audio`.trim();
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

  get playlistId(): string | null {
    return this.settings.get<string>('spotify_playlist_id');
  }

  status() {
    const playlistId = this.playlistId;
    return {
      configured: this.configured,
      connected: this.connected,
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

  async getAlbumTracks(id: string, limit = 50): Promise<SearchResult[]> {
    this.requireConfigured();
    const album = await this.api<{ name: string; images: { url: string }[]; tracks: { items: SpotifyTrack[] } }>(
      `/albums/${encodeURIComponent(id)}`,
    );
    return album.tracks.items.slice(0, limit).map((t) =>
      spotifyTrackToResult({ ...t, album: { name: album.name, images: album.images } }),
    );
  }

  /** Requires user OAuth: Spotify only returns items for playlists the user owns or collaborates on. */
  async getPlaylistTracks(id: string, limit = 100): Promise<SearchResult[]> {
    this.requireConfigured();
    const results: SearchResult[] = [];
    let path: string | null = `/playlists/${encodeURIComponent(id)}/items?limit=50`;
    while (path && results.length < limit) {
      const page: { items: PlaylistEntry[]; next: string | null } = await this.api(path, {}, 'user');
      for (const entry of page.items) {
        const track = entry.item ?? entry.track;
        if (track && track.id && (track.type ?? 'track') === 'track') results.push(spotifyTrackToResult(track));
      }
      path = page.next ? page.next.replace(API, '') : null;
    }
    return results.slice(0, limit);
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

  private saveUserTokens(data: { access_token: string; refresh_token?: string; expires_in: number }): void {
    const previous = this.settings.get<UserTokens>('spotify_tokens');
    const refreshToken = data.refresh_token ?? previous?.refreshToken;
    if (!refreshToken) throw new SpotifyError('Spotify não retornou refresh_token');
    this.settings.set('spotify_tokens', {
      accessToken: data.access_token,
      refreshToken,
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    } satisfies UserTokens);
  }

  private async tokenRequest(
    body: Record<string, string>,
  ): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
    const res = await this.fetchFn(`${ACCOUNTS}/api/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    if (!res.ok) throw new SpotifyError(`Falha na autenticação Spotify (${res.status})`, res.status === 400 ? 401 : 502);
    return (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
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
    const res = await this.fetchFn(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? '';
      } catch {
        /* ignore */
      }
      throw new SpotifyError(`Spotify API ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
