import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import type { PlaylistSummary, Track } from '../types.js';
import type { TrackRepository } from './tracks.js';

const MAX_PLAYLIST_NAME = 80;
const MAX_PLAYLIST_DESC = 300;

export class PlaylistError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

interface PlaylistRow {
  id: string;
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
  track_count: number;
  cover: string | null;
}

interface PlaylistTrackRow {
  track_id: string;
  position: number;
  added_at: number;
}

function toSummary(row: PlaylistRow): PlaylistSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    trackCount: row.track_count,
    cover: row.cover ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new PlaylistError('Nome da playlist deve ser um texto válido', 400);
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new PlaylistError('Informe o nome da playlist', 400);
  }
  if (trimmed.length > MAX_PLAYLIST_NAME) {
    throw new PlaylistError(`Nome da playlist deve ter no máximo ${MAX_PLAYLIST_NAME} caracteres`, 400);
  }
  return trimmed;
}

function normalizeDescription(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new PlaylistError('Descrição da playlist deve ser texto ou null', 400);
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_PLAYLIST_DESC) {
    throw new PlaylistError(`Descrição deve ter no máximo ${MAX_PLAYLIST_DESC} caracteres`, 400);
  }
  return trimmed;
}

const SUMMARY_SELECT = `
  SELECT p.id, p.name, p.description, p.created_at, p.updated_at,
         COUNT(pt.track_id) AS track_count,
         (
           SELECT t2.thumbnail
           FROM playlist_tracks pt2
           JOIN tracks t2 ON t2.id = pt2.track_id
           WHERE pt2.playlist_id = p.id
             AND t2.thumbnail IS NOT NULL
             AND TRIM(t2.thumbnail) <> ''
           ORDER BY pt2.position ASC, pt2.added_at ASC
           LIMIT 1
         ) AS cover
  FROM playlists p
  LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
`;

function isSqliteConstraintError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; errcode?: unknown; message?: unknown };
  if (typeof e.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT')) return true;
  if (typeof e.errcode === 'number' && (e.errcode & 0xff) === 19) return true;
  return (
    typeof e.message === 'string' &&
    /UNIQUE constraint failed|PRIMARY KEY constraint failed|SQLITE_CONSTRAINT/i.test(e.message)
  );
}

/** Manages internal themed playlists and their N:N relationship with tracks. */
export class PlaylistRepository {
  constructor(
    private readonly db: Db,
    private readonly tracks: TrackRepository,
  ) {}

  private runInTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Ignore rollback failure when no transaction is active.
      }
      throw err;
    }
  }

  list(trackId?: string): PlaylistSummary[] {
    const rows = this.db
      .prepare(`${SUMMARY_SELECT} GROUP BY p.id ORDER BY p.name COLLATE NOCASE ASC, p.created_at ASC`)
      .all() as unknown as PlaylistRow[];
    const summaries = rows.map(toSummary);
    const trimmedTrackId = trackId?.trim();
    if (!trimmedTrackId) return summaries;
    const memberRows = this.db
      .prepare('SELECT playlist_id FROM playlist_tracks WHERE track_id = ?')
      .all(trimmedTrackId) as unknown as { playlist_id: string }[];
    const memberIds = new Set(memberRows.map((r) => r.playlist_id));
    return summaries.map((p) => ({ ...p, containsTrack: memberIds.has(p.id) }));
  }

  get(id: string): PlaylistSummary | null {
    const cleanId = id.trim();
    if (!cleanId) return null;
    const row = this.db
      .prepare(`${SUMMARY_SELECT} WHERE p.id = ? GROUP BY p.id`)
      .get(cleanId) as PlaylistRow | undefined;
    return row ? toSummary(row) : null;
  }

  getDetail(id: string): { summary: PlaylistSummary; items: { position: number; addedAt: number; track: Track }[] } | null {
    const summary = this.get(id);
    if (!summary) return null;
    const rows = this.db
      .prepare(
        'SELECT track_id, position, added_at FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC, added_at ASC',
      )
      .all(summary.id) as unknown as PlaylistTrackRow[];
    const items: { position: number; addedAt: number; track: Track }[] = [];
    for (const row of rows) {
      const track = this.tracks.get(row.track_id);
      if (track) {
        items.push({ position: row.position, addedAt: row.added_at, track });
      }
    }
    return { summary, items };
  }

  getTrackIds(playlistId: string): string[] {
    const cleanId = playlistId.trim();
    if (!cleanId) return [];
    const rows = this.db
      .prepare(
        'SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC, added_at ASC',
      )
      .all(cleanId) as unknown as { track_id: string }[];
    return rows.map((r) => r.track_id);
  }

  create(input: { name: unknown; description?: unknown }): PlaylistSummary {
    const name = normalizeName(input.name);
    const description = normalizeDescription(input.description);
    return this.runInTransaction(() => {
      const existing = this.findByName(name);
      if (existing) {
        throw new PlaylistError('Já existe uma playlist com esse nome', 409);
      }
      const id = randomUUID();
      const now = Date.now();
      try {
        this.db
          .prepare('INSERT INTO playlists (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(id, name, description, now, now);
      } catch (err) {
        if (isSqliteConstraintError(err)) {
          throw new PlaylistError('Já existe uma playlist com esse nome', 409);
        }
        throw err;
      }
      return this.get(id)!;
    });
  }

  update(id: string, input: { name?: unknown; description?: unknown }): PlaylistSummary {
    const hasName = input.name !== undefined;
    const hasDesc = input.description !== undefined;
    if (!hasName && !hasDesc) {
      throw new PlaylistError('Nenhuma alteração informada', 400);
    }

    return this.runInTransaction(() => {
      const current = this.get(id);
      if (!current) throw new PlaylistError('Playlist não encontrada', 404);

      const nextName = hasName ? normalizeName(input.name) : current.name;
      const nextDescription = hasDesc ? normalizeDescription(input.description) : current.description;

      if (hasName) {
        const conflict = this.findByName(nextName, current.id);
        if (conflict) {
          throw new PlaylistError('Já existe outra playlist com esse nome', 409);
        }
      }

      try {
        this.db
          .prepare('UPDATE playlists SET name = ?, description = ?, updated_at = ? WHERE id = ?')
          .run(nextName, nextDescription, Date.now(), current.id);
      } catch (err) {
        if (isSqliteConstraintError(err)) {
          throw new PlaylistError('Já existe outra playlist com esse nome', 409);
        }
        throw err;
      }
      return this.get(current.id)!;
    });
  }

  delete(id: string): boolean {
    const cleanId = id.trim();
    if (!cleanId) return false;
    const result = this.db.prepare('DELETE FROM playlists WHERE id = ?').run(cleanId);
    return result.changes > 0;
  }

  addTrack(playlistId: string, rawTrackId: unknown): { added: boolean; duplicate: boolean; playlist: PlaylistSummary } {
    if (typeof rawTrackId !== 'string' || !rawTrackId.trim()) {
      throw new PlaylistError('trackId obrigatório', 400);
    }
    const trackId = rawTrackId.trim();

    return this.runInTransaction(() => {
      const playlist = this.get(playlistId);
      if (!playlist) throw new PlaylistError('Playlist não encontrada', 404);
      const track = this.tracks.get(trackId);
      if (!track) throw new PlaylistError('Faixa não encontrada', 404);

      const existing = this.db
        .prepare('SELECT 1 FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?')
        .get(playlist.id, track.id);
      if (existing) {
        return { added: false, duplicate: true, playlist };
      }

      const maxRow = this.db
        .prepare('SELECT COALESCE(MAX(position), 0) AS maxPos FROM playlist_tracks WHERE playlist_id = ?')
        .get(playlist.id) as { maxPos: number };
      const now = Date.now();
      try {
        this.db
          .prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)')
          .run(playlist.id, track.id, maxRow.maxPos + 1, now);
      } catch (err) {
        if (isSqliteConstraintError(err)) {
          const alreadyInserted = this.db
            .prepare('SELECT 1 FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?')
            .get(playlist.id, track.id);
          if (alreadyInserted) {
            return { added: false, duplicate: true, playlist: this.get(playlist.id)! };
          }
          throw new PlaylistError('Não foi possível vincular a faixa à playlist', 409);
        }
        throw err;
      }
      this.db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now, playlist.id);
      return { added: true, duplicate: false, playlist: this.get(playlist.id)! };
    });
  }

  removeTrack(playlistId: string, rawTrackId: unknown): void {
    if (typeof rawTrackId !== 'string' || !rawTrackId.trim()) {
      throw new PlaylistError('trackId obrigatório', 400);
    }
    const trackId = rawTrackId.trim();
    this.runInTransaction(() => {
      const playlist = this.get(playlistId);
      if (!playlist) throw new PlaylistError('Playlist não encontrada', 404);
      const result = this.db
        .prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?')
        .run(playlist.id, trackId);
      if (result.changes === 0) {
        throw new PlaylistError('Faixa não encontrada nesta playlist', 404);
      }
      this.db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), playlist.id);
    });
  }

  private findByName(name: string, excludeId?: string): { id: string } | undefined {
    const target = name.trim().toLocaleLowerCase('pt-BR');
    const rows = this.db.prepare('SELECT id, name FROM playlists').all() as unknown as { id: string; name: string }[];
    return rows.find((row) => row.id !== excludeId && row.name.trim().toLocaleLowerCase('pt-BR') === target);
  }
}
