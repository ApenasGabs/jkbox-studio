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
  /** YouTube video id used to fetch the audio (equal to sourceId for YouTube tracks). */
  youtubeId: string | null;
  spotifyUri: string | null;
  filePath: string | null;
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
  durationSec?: number | null;
  thumbnail?: string | null;
  spotifyUri?: string | null;
  /** Id of an already-stored track (local library / cached). */
  trackId?: string;
  cached?: boolean;
}

export type QueueStatus = 'queued' | 'playing' | 'played' | 'removed';

export interface QueueItem {
  id: number;
  trackId: string;
  requesterId: string;
  requesterName: string;
  addedAt: number;
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
