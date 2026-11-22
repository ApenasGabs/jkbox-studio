import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { Db } from '../db.js';
import type { SearchResult, Track, TrackSource, TrackStatus } from '../types.js';

interface TrackRow {
  id: string;
  source: TrackSource;
  source_id: string;
  title: string;
  artist: string;
  album: string | null;
  duration_sec: number | null;
  thumbnail: string | null;
  youtube_id: string | null;
  spotify_uri: string | null;
  file_path: string | null;
  status: TrackStatus;
  progress: number;
  error: string | null;
  created_at: number;
}

function toTrack(row: TrackRow): Track {
  return {
    id: row.id,
    source: row.source,
    sourceId: row.source_id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    durationSec: row.duration_sec,
    thumbnail: row.thumbnail,
    youtubeId: row.youtube_id,
    spotifyUri: row.spotify_uri,
    filePath: row.file_path,
    status: row.status,
    progress: row.progress,
    error: row.error,
    createdAt: row.created_at,
  };
}

export class TrackRepository {
  constructor(private readonly db: Db) {}

  get(id: string): Track | null {
    const row = this.db.prepare('SELECT * FROM tracks WHERE id = ?').get(id) as TrackRow | undefined;
    return row ? toTrack(row) : null;
  }

  findBySource(source: TrackSource, sourceId: string): Track | null {
    const row = this.db
      .prepare('SELECT * FROM tracks WHERE source = ? AND source_id = ?')
      .get(source, sourceId) as TrackRow | undefined;
    return row ? toTrack(row) : null;
  }

  /** Finds a ready track that already has the audio for this YouTube video on disk. */
  findReadyByYoutubeId(youtubeId: string): Track | null {
    const row = this.db
      .prepare("SELECT * FROM tracks WHERE youtube_id = ? AND status = 'ready' LIMIT 1")
      .get(youtubeId) as TrackRow | undefined;
    return row ? toTrack(row) : null;
  }

  findByFilePath(filePath: string): Track | null {
    const row = this.db.prepare('SELECT * FROM tracks WHERE file_path = ?').get(filePath) as
      | TrackRow
      | undefined;
    return row ? toTrack(row) : null;
  }

  /** Returns the existing track for a search result or creates a new pending one. */
  upsertFromResult(result: SearchResult): Track {
    const existing = this.findBySource(result.source, result.sourceId);
    if (existing) return existing;
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO tracks (id, source, source_id, title, artist, album, duration_sec, thumbnail,
          youtube_id, spotify_uri, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        id,
        result.source,
        result.sourceId,
        result.title,
        result.artist ?? '',
        result.album ?? null,
        result.durationSec ?? null,
        result.thumbnail ?? null,
        result.source === 'youtube' ? result.sourceId : null,
        result.spotifyUri ?? null,
        Date.now(),
      );
    return this.get(id)!;
  }

  insertLocal(filePath: string, title: string, artist: string): Track {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO tracks (id, source, source_id, title, artist, file_path, status, progress, created_at)
         VALUES (?, 'local', ?, ?, ?, ?, 'ready', 1, ?)`,
      )
      .run(id, filePath, title, artist, filePath, Date.now());
    return this.get(id)!;
  }

  update(
    id: string,
    patch: Partial<Pick<Track, 'status' | 'progress' | 'error' | 'filePath' | 'youtubeId' | 'durationSec' | 'thumbnail'>>,
  ): void {
    const columns: Record<string, string> = {
      status: 'status',
      progress: 'progress',
      error: 'error',
      filePath: 'file_path',
      youtubeId: 'youtube_id',
      durationSec: 'duration_sec',
      thumbnail: 'thumbnail',
    };
    const entries = Object.entries(patch).filter(([key]) => key in columns);
    if (entries.length === 0) return;
    const sql = `UPDATE tracks SET ${entries.map(([key]) => `${columns[key]} = ?`).join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...entries.map(([, value]) => (value ?? null) as string | number | null), id);
  }

  /** True when the track's audio file is available on disk. */
  isCached(track: Track): boolean {
    return track.status === 'ready' && !!track.filePath && fs.existsSync(track.filePath);
  }

  /** Searches downloaded/local tracks (the "Acervo Local"). */
  searchLibrary(query: string, limit = 50): Track[] {
    const q = `%${query.trim().replace(/[%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM tracks WHERE status = 'ready'
           AND (title LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\' OR album LIKE ? ESCAPE '\\')
         ORDER BY title COLLATE NOCASE LIMIT ?`,
      )
      .all(q, q, q, limit) as unknown as TrackRow[];
    return rows.map(toTrack);
  }

  listActiveDownloads(): Track[] {
    const rows = this.db
      .prepare("SELECT * FROM tracks WHERE status IN ('pending', 'downloading') ORDER BY created_at")
      .all() as unknown as TrackRow[];
    return rows.map(toTrack);
  }

  allFilePaths(): Set<string> {
    const rows = this.db
      .prepare('SELECT file_path FROM tracks WHERE file_path IS NOT NULL')
      .all() as unknown as { file_path: string }[];
    return new Set(rows.map((r) => r.file_path));
  }
}
