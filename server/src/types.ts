export type TrackSource = 'youtube' | 'spotify' | 'local' | 'deezer';
export type TrackStatus = 'pending' | 'downloading' | 'ready' | 'error';

export interface Track {
  id: string;
  source: TrackSource;
  sourceId: string;
  title: string;
  artist: string;
  album: string | null;
  /** Genre / Host-managed category. */
  genre: string | null;
  /** Subcategory / specific style (e.g. Funk Mandelão, Pagode 90). */
  subgenre: string | null;
  /** True when the Host manually edited genre/subgenre (protected from auto-categorization). */
  genreManual: boolean;
  year: number | null;
  trackNumber: number | null;
  durationSec: number | null;
  thumbnail: string | null;
  /** YouTube video id used to fetch the audio (equal to sourceId for YouTube tracks). */
  youtubeId: string | null;
  spotifyUri: string | null;
  filePath: string | null;
  videoPath: string | null;
  status: TrackStatus;
  progress: number;
  error: string | null;
  createdAt: number;
}

/** A search result that can be enqueued. Not necessarily stored yet. */
export interface SearchResult {
  source: TrackSource;
  sourceId: string;
  title: string;
  artist: string;
  album?: string | null;
  genre?: string | null;
  subgenre?: string | null;
  year?: number | null;
  trackNumber?: number | null;
  durationSec?: number | null;
  thumbnail?: string | null;
  spotifyUri?: string | null;
  /** Id of an already-stored track (local library / cached). */
  trackId?: string;
  cached?: boolean;
}

/** Editable catalog metadata of a track (PATCH /api/tracks/:id/metadata). */
export interface TrackMetadataPatch {
  title?: string;
  artist?: string;
  album?: string | null;
  genre?: string | null;
  subgenre?: string | null;
  year?: number | null;
  trackNumber?: number | null;
}

export interface CatalogSubcategory {
  name: string;
  trackCount: number;
  cover: string | null;
}

export interface CatalogCategory {
  name: string;
  trackCount: number;
  albumCount: number;
  artistCount: number;
  cover: string | null;
  subcategories?: CatalogSubcategory[];
}

export type AutoDjMode = 'vibe' | 'category' | 'playlist' | 'random';

export interface AutoDjConfig {
  enabled: boolean;
  mode: AutoDjMode;
  category: string | null;
  subgenre: string | null;
  playlistId: string | null;
}

export type PlaylistSource = 'youtube' | 'spotify';

export interface PlaylistSummary {
  id: string;
  name: string;
  description: string | null;
  source?: PlaylistSource | null;
  sourceId?: string | null;
  thumbnail?: string | null;
  trackCount: number;
  cover: string | null;
  createdAt: number;
  updatedAt: number;
  containsTrack?: boolean;
}

export interface PlaylistTrackResult extends SearchResult {
  position: number;
  addedAt: number;
}

export interface PlaylistDetail extends PlaylistSummary {
  tracks: PlaylistTrackResult[];
}

export interface PlaylistImportResult {
  playlist: PlaylistSummary;
  created: boolean;
  imported: number;
  alreadyCached: number;
  queued: number;
  downloading: number;
  skipped: number;
  tracks: PlaylistTrackResult[];
}

export interface CatalogAlbum {
  name: string;
  artist: string;
  genre: string | null;
  year: number | null;
  trackCount: number;
  totalDurationSec: number;
  cover: string | null;
}

export interface CatalogArtist {
  name: string;
  albumCount: number;
  trackCount: number;
  cover: string | null;
}

export interface CatalogArtistDetail extends CatalogArtist {
  albums: CatalogAlbum[];
  tracks: Track[];
}

export type QueueStatus = 'queued' | 'playing' | 'played' | 'removed';

export const REACTION_EMOJIS = ['🔥', '👏', '❤️', '🎤', '🎉'] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

export interface QueueItem {
  id: number;
  trackId: string;
  requesterId: string;
  requesterName: string;
  addedAt: number;
  finishedAt?: number | null;
  status: QueueStatus;
  votes: number;
  voters: string[];
}

export interface QueueEntryView extends QueueItem {
  track: Track;
}

export interface NowPlaying {
  item: QueueEntryView;
  startedAt: number;
  positionSec: number;
  paused: boolean;
}

export interface JukeboxState {
  nowPlaying: NowPlaying | null;
  queue: QueueEntryView[];
}

export interface SpotifyDevice {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  isRestricted: boolean;
  volumePercent: number | null;
  supportsVolume: boolean;
}

export interface SpotifyPlaybackState {
  isPlaying: boolean;
  progressMs: number;
  device: SpotifyDevice | null;
  trackUri: string | null;
  trackId: string | null;
  durationMs: number | null;
  track: SearchResult | null;
}

export type PlaybackOutput =
  | { type: 'local' }
  | { type: 'spotify'; deviceId: string; deviceName: string };

export type LyricsSource = 'lrclib' | 'local' | 'none';

export interface TrackLyrics {
  trackId: string;
  syncedLrc: string | null;
  plainLyrics: string | null;
  instrumental: boolean;
  source: LyricsSource;
  offsetMs: number;
  fetchedAt: number;
}

export type DiscoveryMode = 'playlist' | 'category' | 'vibe';
export type DiscoveryTarget = 'library' | 'playlist' | 'queue';
export type DiscoverySource = 'deezer' | 'spotify' | 'youtube';

export interface DiscoverySeedSummary {
  title: string;
  artist: string;
  genre: string | null;
  subgenre: string | null;
}

export interface DiscoverySuggestResponse {
  mode: DiscoveryMode;
  seeds: DiscoverySeedSummary[];
  sourcesUsed: DiscoverySource[];
  suggestions: SearchResult[];
}

export interface DiscoveryPopulateResponse {
  target: DiscoveryTarget;
  playlistId?: string;
  total: number;
  added: number;
  duplicates: number;
  queuedDownloads: number;
  tracks: Track[];
}
