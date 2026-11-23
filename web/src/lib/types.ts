// Mirrors server/src/types.ts (kept minimal on purpose).
export type TrackSource = 'youtube' | 'spotify' | 'local';
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
  year?: number | null;
  trackNumber?: number | null;
}

export interface CatalogCategory {
  name: string;
  trackCount: number;
  albumCount: number;
  artistCount: number;
  cover: string | null;
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

export interface SpotifyStatus {
  configured: boolean;
  connected: boolean;
  playlistId: string | null;
  playlistUrl: string | null;
  redirectUri: string | null;
}

export interface AppConfig {
  publicUrl: string | null;
  hostPinRequired: boolean;
  audioFormat: string;
  videoMode: VideoMode;
  autoDjEnabled: boolean;
  spotify: SpotifyStatus;
}

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

export const KIOSK_COMMANDS = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'SELECT', 'PLAY', 'BACK', 'MENU', 'SKIP'] as const;
export type KioskCommand = (typeof KIOSK_COMMANDS)[number];
export type KioskInputPhase = 'press' | 'down' | 'up';

export interface KioskInputEvent {
  command: KioskCommand;
  phase: KioskInputPhase;
  source?: string;
}

export type ServerMessage =
  | { type: 'state'; state: JukeboxState }
  | { type: 'progress'; positionSec: number; paused: boolean }
  | { type: 'download'; trackId: string; status: TrackStatus; progress: number; error: string | null }
  | { type: 'lyrics_offset'; trackId: string; offsetMs: number }
  | { type: 'reaction'; emoji: ReactionEmoji; senderName?: string }
  | { type: 'input'; command: KioskCommand; phase?: KioskInputPhase; source?: string };
