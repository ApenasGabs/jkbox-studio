import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE tracks (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    album TEXT,
    duration_sec INTEGER,
    thumbnail TEXT,
    youtube_id TEXT,
    spotify_uri TEXT,
    file_path TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    progress REAL NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (source, source_id)
  );
  CREATE INDEX idx_tracks_youtube ON tracks (youtube_id);

  CREATE TABLE queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id TEXT NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
    requester_id TEXT NOT NULL,
    requester_name TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    started_at INTEGER,
    finished_at INTEGER
  );
  CREATE INDEX idx_queue_status ON queue (status);

  CREATE TABLE votes (
    queue_id INTEGER NOT NULL REFERENCES queue (id) ON DELETE CASCADE,
    voter_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (queue_id, voter_id)
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE lyrics (
    track_id TEXT PRIMARY KEY REFERENCES tracks (id) ON DELETE CASCADE,
    synced_lrc TEXT,
    plain_lyrics TEXT,
    instrumental INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    offset_ms INTEGER NOT NULL DEFAULT 0,
    fetched_at INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE tracks ADD COLUMN video_path TEXT;
  `,
  // v4 — catalog metadata (#10). The genre doubles as the Host-managed category.
  `
  ALTER TABLE tracks ADD COLUMN genre TEXT;
  ALTER TABLE tracks ADD COLUMN year INTEGER;
  ALTER TABLE tracks ADD COLUMN track_number INTEGER;
  CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks (album COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks (artist COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_tracks_genre ON tracks (genre COLLATE NOCASE);
  `,
  // v5 — subgenres, manual genre lock, and cached artist genres (#27).
  `
  ALTER TABLE tracks ADD COLUMN subgenre TEXT;
  ALTER TABLE tracks ADD COLUMN genre_manual INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS idx_tracks_subgenre ON tracks (subgenre COLLATE NOCASE);
  CREATE TABLE IF NOT EXISTS artist_genres (
    artist_key TEXT PRIMARY KEY,
    artist_name TEXT NOT NULL,
    genre TEXT,
    subgenre TEXT,
    source TEXT NOT NULL,
    raw_genres TEXT,
    fetched_at INTEGER NOT NULL
  );
  `,
];

export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let version = row.user_version; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export class Settings {
  constructor(private readonly db: Db) {}

  get<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      )
      .run(key, JSON.stringify(value));
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }
}
