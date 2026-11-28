// Mirrors server/src/types.ts (kept minimal on purpose).
export type TrackSource = 'youtube' | 'spotify' | 'local' | 'deezer';
export type TrackStatus = 'pending' | 'downloading' | 'ready' | 'error';
export type VideoMode = 'off' | 'cache' | 'embed';

export interface Track {
  id: string;
  source: TrackSource;
  sourceId: string;
  title: string;
  artist: string;
  album: string | null;
  genre?: string | null;
  subgenre?: string | null;
  genreManual?: boolean;
  year?: number | null;
  trackNumber?: number | null;
  durationSec: number | null;
  thumbnail: string | null;
  youtubeId?: string | null;
  videoPath?: string | null;
  status: TrackStatus;
  progress: number;
  error: string | null;
}

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
  trackId?: string;
  cached?: boolean;
}

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
  truncated?: boolean;
  totalRemote?: number;
  tracks: PlaylistTrackResult[];
}

export interface PlaylistEnqueueResponse {
  playlistId: string;
  playlistName: string;
  total: number;
  enqueued: number;
  duplicates: number;
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
  tracks: SearchResult[];
}

export const REACTION_EMOJIS = ['🔥', '👏', '❤️', '🎤', '🎉'] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

export interface QueueEntry {
  id: number;
  trackId: string;
  requesterId: string;
  requesterName: string;
  addedAt: number;
  finishedAt?: number | null;
  votes: number;
  voters: string[];
  track: Track;
}

export interface NowPlaying {
  item: QueueEntry;
  startedAt: number;
  positionSec: number;
  paused: boolean;
}

export interface JukeboxState {
  nowPlaying: NowPlaying | null;
  queue: QueueEntry[];
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

export type PlaybackOutput =
  | { type: 'local' }
  | { type: 'spotify'; deviceId: string; deviceName: string };

export interface SpotifyStatus {
  configured: boolean;
  connected: boolean;
  playbackAuthorized: boolean;
  playlistId: string | null;
  playlistUrl: string | null;
  redirectUri: string | null;
}

export type MdnsMode = 'os-helper' | 'embedded' | 'disabled';

export interface MdnsStatus {
  hostname: string;
  fqdn: string;
  url: string;
  enabled: boolean;
  active: boolean;
  mode: MdnsMode;
  useForQr: boolean;
  dockerBridgeHint: boolean;
  lastError: string | null;
}

export interface NetworkInfo {
  publicUrl: string | null;
  lanIps: string[];
  lanUrl: string | null;
  publicUrlWarning: string | null;
}

export interface AutoDjConfig {
  enabled: boolean;
  mode: AutoDjMode;
  category: string | null;
  subgenre: string | null;
  playlistId: string | null;
}

export interface AppConfig {
  publicUrl: string | null;
  lanIps?: string[];
  lanUrl?: string | null;
  publicUrlWarning?: string | null;
  hostPinRequired: boolean;
  audioFormat: string;
  videoMode: VideoMode;
  autoDjEnabled: boolean;
  autoDjMode?: AutoDjMode;
  autoDjCategory?: string | null;
  autoDjSubgenre?: string | null;
  autoDjPlaylistId?: string | null;
  playbackOutput: PlaybackOutput;
  spotify: SpotifyStatus;
  mdns?: MdnsStatus | null;
}

export type LyricsSource = 'lrclib' | 'local' | 'none';

export interface LyricsPrefetchSummary {
  total: number;
  alreadyCached: number;
  found: number;
  empty: number;
  transient: number;
}

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

export const KIOSK_COMMANDS = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'SELECT', 'PLAY', 'BACK', 'MENU', 'SKIP'] as const;
export type KioskCommand = (typeof KIOSK_COMMANDS)[number];
export type KioskInputPhase = 'press' | 'down' | 'up';

export interface KioskInputEvent {
  command: KioskCommand;
  phase: KioskInputPhase;
  source?: string;
}

export type ServerMessage =
  | { type: 'state'; state: JukeboxState; playbackOutput?: PlaybackOutput; autoDj?: AutoDjConfig }
  | { type: 'progress'; positionSec: number; paused: boolean }
  | { type: 'download'; trackId: string; status: TrackStatus; progress: number; error: string | null }
  | { type: 'lyrics_offset'; trackId: string; offsetMs: number }
  | { type: 'reaction'; emoji: ReactionEmoji; senderName?: string }
  | { type: 'notice'; message: string; error?: boolean }
  | { type: 'input'; command: KioskCommand; phase?: KioskInputPhase; source?: string }
  | { type: 'mdns'; mdns: MdnsStatus }
  | { type: 'network'; network: NetworkInfo }
  | { type: 'kiosk_control'; control: KioskControl };

export type HostPinSource = 'env' | 'auto' | 'none';

export interface HostPinStatus {
  pin: string;
  source: HostPinSource;
  enabled: boolean;
  editable: boolean;
}

export type KioskStageView = 'cover' | 'lyrics' | 'video' | 'cinema';

export type KioskControl =
  | { action: 'play' }
  | { action: 'pause' }
  | { action: 'toggle' }
  | { action: 'volume'; value: number }
  | { action: 'stage'; value: KioskStageView }
  | { action: 'reactions'; value: boolean };
