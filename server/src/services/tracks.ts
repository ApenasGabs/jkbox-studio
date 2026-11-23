import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { Db } from '../db.js';
import type {
  CatalogAlbum,
  CatalogArtist,
  CatalogArtistDetail,
  CatalogCategory,
  CatalogSubcategory,
  SearchResult,
  Track,
  TrackMetadataPatch,
  TrackSource,
  TrackStatus,
} from '../types.js';

/** Metadata extracted for a file dropped into the local library. */
export interface LocalTrackMeta {
  title: string;
  artist: string;
  album?: string | null;
  genre?: string | null;
  subgenre?: string | null;
  genreManual?: boolean;
  year?: number | null;
  trackNumber?: number | null;
  durationSec?: number | null;
}

export interface AlbumFilter {
  q?: string;
  category?: string;
  artist?: string;
}

/** Escapes a user string for a `LIKE ... ESCAPE '\\'` pattern. */
function likePattern(query: string): string {
  return `%${query.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Catalog views only expose playable tracks. */
const READY = "status = 'ready'";
/** Album tracks: numbered tracks first (in order), then the rest alphabetically. */
const TRACK_ORDER = 'track_number IS NULL, track_number ASC, title COLLATE NOCASE ASC';

interface TrackRow {
  id: string;
  source: TrackSource;
  source_id: string;
  title: string;
  artist: string;
  album: string | null;
  genre: string | null;
  subgenre: string | null;
  genre_manual: number;
  year: number | null;
  track_number: number | null;
  duration_sec: number | null;
  thumbnail: string | null;
  youtube_id: string | null;
  spotify_uri: string | null;
  file_path: string | null;
  video_path: string | null;
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
    genre: row.genre ?? null,
    subgenre: row.subgenre ?? null,
    genreManual: row.genre_manual === 1,
    year: row.year ?? null,
    trackNumber: row.track_number ?? null,
    durationSec: row.duration_sec,
    thumbnail: row.thumbnail,
    youtubeId: row.youtube_id,
    spotifyUri: row.spotify_uri,
    filePath: row.file_path,
    videoPath: row.video_path,
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

  /** Finds a ready track that already has the audio (and ideally video) for this YouTube video on disk. */
  findReadyByYoutubeId(youtubeId: string): Track | null {
    const row = this.db
      .prepare("SELECT * FROM tracks WHERE youtube_id = ? AND status = 'ready' ORDER BY (video_path IS NOT NULL) DESC LIMIT 1")
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

  insertLocal(filePath: string, meta: LocalTrackMeta): Track {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO tracks (id, source, source_id, title, artist, album, genre, subgenre, genre_manual, year, track_number, duration_sec,
          file_path, status, progress, created_at)
         VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 1, ?)`,
      )
      .run(
        id,
        filePath,
        meta.title,
        meta.artist,
        meta.album ?? null,
        meta.genre ?? null,
        meta.subgenre ?? null,
        meta.genreManual ? 1 : 0,
        meta.year ?? null,
        meta.trackNumber ?? null,
        meta.durationSec ?? null,
        filePath,
        Date.now(),
      );
    return this.get(id)!;
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        Track,
        'status' | 'progress' | 'error' | 'filePath' | 'videoPath' | 'youtubeId' | 'spotifyUri' | 'durationSec' | 'thumbnail' | 'genreManual'
      >
    > &
      TrackMetadataPatch,
  ): void {
    const columns: Record<string, string> = {
      status: 'status',
      progress: 'progress',
      error: 'error',
      filePath: 'file_path',
      videoPath: 'video_path',
      youtubeId: 'youtube_id',
      spotifyUri: 'spotify_uri',
      durationSec: 'duration_sec',
      thumbnail: 'thumbnail',
      title: 'title',
      artist: 'artist',
      album: 'album',
      genre: 'genre',
      subgenre: 'subgenre',
      genreManual: 'genre_manual',
      year: 'year',
      trackNumber: 'track_number',
    };
    const entries = Object.entries(patch).filter(([key, value]) => key in columns && value !== undefined);
    if (entries.length === 0) return;
    const sql = `UPDATE tracks SET ${entries.map(([key]) => `${columns[key]} = ?`).join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(
      ...entries.map(([key, value]) => {
        if (key === 'genreManual') return value ? 1 : 0;
        return (value ?? null) as string | number | null;
      }),
      id,
    );
  }

  /** True when the track's audio file is available on disk. */
  isCached(track: Track): boolean {
    return track.status === 'ready' && !!track.filePath && fs.existsSync(track.filePath);
  }

  /** True when the track's MP4 video file is available on disk. */
  isVideoCached(track: Track): boolean {
    return track.status === 'ready' && !!track.videoPath && fs.existsSync(track.videoPath);
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

  /** Returns all ready tracks whose audio file currently exists on disk. */
  listCached(): Track[] {
    const rows = this.db
      .prepare("SELECT * FROM tracks WHERE status = 'ready' AND file_path IS NOT NULL ORDER BY created_at DESC")
      .all() as unknown as TrackRow[];
    return rows.map(toTrack).filter((track) => this.isCached(track));
  }

  // --- Catalog (#10, #27) --------------------------------------------------

  /** Genres/categories of playable tracks with counts, subcategories and a representative cover. */
  listCategories(): CatalogCategory[] {
    const rows = this.db
      .prepare(
        `SELECT MIN(TRIM(genre)) AS name, COUNT(*) AS trackCount,
                COUNT(DISTINCT LOWER(NULLIF(TRIM(album), ''))) AS albumCount,
                COUNT(DISTINCT LOWER(NULLIF(TRIM(artist), ''))) AS artistCount,
                MAX(thumbnail) AS cover
           FROM tracks
          WHERE ${READY} AND genre IS NOT NULL AND TRIM(genre) <> ''
          GROUP BY LOWER(TRIM(genre))
          ORDER BY name COLLATE NOCASE`,
      )
      .all() as unknown as Omit<CatalogCategory, 'subcategories'>[];

    const subRows = this.db
      .prepare(
        `SELECT LOWER(TRIM(genre)) AS genreKey, MIN(TRIM(subgenre)) AS name, COUNT(*) AS trackCount,
                MAX(thumbnail) AS cover
           FROM tracks
          WHERE ${READY}
            AND genre IS NOT NULL AND TRIM(genre) <> ''
            AND subgenre IS NOT NULL AND TRIM(subgenre) <> ''
          GROUP BY LOWER(TRIM(genre)), LOWER(TRIM(subgenre))
          ORDER BY trackCount DESC, name COLLATE NOCASE`,
      )
      .all() as unknown as { genreKey: string; name: string; trackCount: number; cover: string | null }[];

    const subsByGenre = new Map<string, CatalogSubcategory[]>();
    for (const sub of subRows) {
      const list = subsByGenre.get(sub.genreKey) ?? [];
      list.push({ name: sub.name, trackCount: sub.trackCount, cover: sub.cover ?? null });
      subsByGenre.set(sub.genreKey, list);
    }

    return rows.map((r) => ({
      ...r,
      cover: r.cover ?? null,
      subcategories: subsByGenre.get(r.name.trim().toLowerCase()) ?? [],
    }));
  }

  subcategoriesForCategory(name: string): CatalogSubcategory[] {
    const rows = this.db
      .prepare(
        `SELECT MIN(TRIM(subgenre)) AS name, COUNT(*) AS trackCount, MAX(thumbnail) AS cover
           FROM tracks
          WHERE ${READY}
            AND LOWER(TRIM(genre)) = LOWER(TRIM(?))
            AND subgenre IS NOT NULL AND TRIM(subgenre) <> ''
          GROUP BY LOWER(TRIM(subgenre))
          ORDER BY trackCount DESC, name COLLATE NOCASE`,
      )
      .all(name) as unknown as CatalogSubcategory[];
    return rows.map((r) => ({ ...r, cover: r.cover ?? null }));
  }

  tracksByCategory(name: string, subgenre?: string): Track[] {
    const params: string[] = [name];
    let subFilter = '';
    const trimmedSub = subgenre?.trim();
    if (trimmedSub) {
      if (trimmedSub === '__none__') {
        subFilter = "AND (subgenre IS NULL OR TRIM(subgenre) = '')";
      } else {
        subFilter = 'AND LOWER(TRIM(subgenre)) = LOWER(TRIM(?))';
        params.push(trimmedSub);
      }
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM tracks WHERE ${READY} AND LOWER(TRIM(genre)) = LOWER(TRIM(?)) ${subFilter}
          ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, ${TRACK_ORDER}`,
      )
      .all(...params) as unknown as TrackRow[];
    return rows.map(toTrack);
  }

  /** Returns ready tracks eligible for auto-categorization (never overwrites `genre_manual = 1`). */
  listTracksForAutocategorize(): { candidates: Track[]; skippedManual: number } {
    const rows = this.db
      .prepare(
        `SELECT * FROM tracks
          WHERE ${READY}
            AND genre_manual = 0
            AND (genre IS NULL OR TRIM(genre) = '' OR subgenre IS NULL OR TRIM(subgenre) = '')
          ORDER BY created_at DESC`,
      )
      .all() as unknown as TrackRow[];
    const skippedRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM tracks
          WHERE ${READY} AND genre_manual = 1`,
      )
      .get() as { count: number };
    return { candidates: rows.map(toTrack), skippedManual: skippedRow.count };
  }

  /** Albums grouped by (album, artist), optionally filtered by text, category or artist. */
  listAlbums(filter: AlbumFilter = {}): CatalogAlbum[] {
    const where = [READY, "album IS NOT NULL AND TRIM(album) <> ''"];
    const params: string[] = [];
    if (filter.q?.trim()) {
      where.push("(album LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\')");
      const q = likePattern(filter.q);
      params.push(q, q);
    }
    if (filter.category?.trim()) {
      where.push('LOWER(TRIM(genre)) = LOWER(TRIM(?))');
      params.push(filter.category);
    }
    if (filter.artist?.trim()) {
      where.push('LOWER(TRIM(artist)) = LOWER(TRIM(?))');
      params.push(filter.artist);
    }
    const rows = this.db
      .prepare(
        `SELECT MIN(TRIM(album)) AS name, MIN(TRIM(artist)) AS artist, MIN(NULLIF(TRIM(genre), '')) AS genre,
                MAX(year) AS year, COUNT(*) AS trackCount, COALESCE(SUM(duration_sec), 0) AS totalDurationSec,
                MAX(thumbnail) AS cover
           FROM tracks
          WHERE ${where.join(' AND ')}
          GROUP BY LOWER(TRIM(album)), LOWER(TRIM(artist))
          ORDER BY name COLLATE NOCASE, artist COLLATE NOCASE`,
      )
      .all(...params) as unknown as CatalogAlbum[];
    return rows.map((r) => ({ ...r, genre: r.genre ?? null, year: r.year ?? null, cover: r.cover ?? null }));
  }

  albumTracks(name: string, artist?: string): Track[] {
    const params = [name];
    let artistFilter = '';
    if (artist?.trim()) {
      artistFilter = 'AND LOWER(TRIM(artist)) = LOWER(TRIM(?))';
      params.push(artist);
    }
    const rows = this.db
      .prepare(`SELECT * FROM tracks WHERE ${READY} AND LOWER(TRIM(album)) = LOWER(TRIM(?)) ${artistFilter} ORDER BY ${TRACK_ORDER}`)
      .all(...params) as unknown as TrackRow[];
    return rows.map(toTrack);
  }

  listArtists(): CatalogArtist[] {
    const rows = this.db
      .prepare(
        `SELECT MIN(TRIM(artist)) AS name, COUNT(DISTINCT LOWER(NULLIF(TRIM(album), ''))) AS albumCount,
                COUNT(*) AS trackCount, MAX(thumbnail) AS cover
           FROM tracks
          WHERE ${READY} AND TRIM(artist) <> ''
          GROUP BY LOWER(TRIM(artist))
          ORDER BY name COLLATE NOCASE`,
      )
      .all() as unknown as CatalogArtist[];
    return rows.map((r) => ({ ...r, cover: r.cover ?? null }));
  }

  /** Artist summary plus their albums and tracks; null when the artist has no playable track. */
  getArtist(name: string): CatalogArtistDetail | null {
    const rows = this.db
      .prepare(
        `SELECT * FROM tracks WHERE ${READY} AND TRIM(artist) <> '' AND LOWER(TRIM(artist)) = LOWER(TRIM(?))
          ORDER BY album COLLATE NOCASE, ${TRACK_ORDER}`,
      )
      .all(name) as unknown as TrackRow[];
    if (rows.length === 0) return null;
    const tracks = rows.map(toTrack);
    const albums = this.listAlbums({ artist: name });
    return {
      name: tracks[0].artist.trim(),
      albumCount: albums.length,
      trackCount: tracks.length,
      cover: tracks.map((t) => t.thumbnail).filter((t): t is string => !!t).sort().at(-1) ?? null,
      albums,
      tracks,
    };
  }
}
