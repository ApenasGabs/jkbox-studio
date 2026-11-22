// Mirrors server/src/types.ts (kept minimal on purpose).
export type TrackSource = 'youtube' | 'spotify' | 'local';
export type TrackStatus = 'pending' | 'downloading' | 'ready' | 'error';

export interface Track {
  id: string;
  source: TrackSource;
  sourceId: string;
  title: string;
  artist: string;
  album: string | null;
  durationSec: number | null;
  thumbnail: string | null;
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
  durationSec?: number | null;
  thumbnail?: string | null;
  spotifyUri?: string | null;
  trackId?: string;
  cached?: boolean;
}

export interface QueueEntry {
  id: number;
  trackId: string;
  requesterId: string;
  requesterName: string;
  addedAt: number;
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
  spotify: SpotifyStatus;
}

export type ServerMessage =
  | { type: 'state'; state: JukeboxState }
  | { type: 'progress'; positionSec: number; paused: boolean }
  | { type: 'download'; trackId: string; status: TrackStatus; progress: number; error: string | null };
