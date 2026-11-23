import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import {
  createFfprobe,
  folderMetadata,
  parseFileName,
  parseProbeOutput,
  parseTrackFileName,
  resolveMetadata,
  scanLibrary,
  type MetadataProbe,
} from '../src/services/library.js';
import { setup } from './helpers.js';

function write(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x');
}

describe('local library', () => {
  it('parses "Artist - Title" file names', () => {
    expect(parseFileName('/m/Queen - Bohemian Rhapsody.mp3')).toEqual({ artist: 'Queen', title: 'Bohemian Rhapsody' });
    expect(parseFileName('/m/just_a_song.flac')).toEqual({ artist: '', title: 'just a song' });
  });

  it('strips leading track numbers from file names', () => {
    expect(parseTrackFileName('/m/01 - Música.mp3')).toEqual({ artist: '', title: 'Música', trackNumber: 1 });
    expect(parseTrackFileName('/m/12. Queen - Innuendo.mp3')).toEqual({ artist: 'Queen', title: 'Innuendo', trackNumber: 12 });
    expect(parseTrackFileName('/m/Queen - Innuendo.mp3')).toEqual({ artist: 'Queen', title: 'Innuendo', trackNumber: null });
  });

  it('imports dropped files once and makes them searchable', async () => {
    const { config, jukebox } = setup();
    fs.mkdirSync(path.join(config.musicDir, 'rock'), { recursive: true });
    fs.writeFileSync(path.join(config.musicDir, 'rock', 'Queen - Bohemian Rhapsody.mp3'), 'x');
    fs.writeFileSync(path.join(config.musicDir, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(config.musicDir, '0f8fad5b-d9cb-469f-a165-70867728950e.webm'), 'x');

    expect(await scanLibrary(jukebox.tracks, config.musicDir, { probe: null })).toBe(1);
    expect(await scanLibrary(jukebox.tracks, config.musicDir, { probe: null })).toBe(0);
    const [track] = jukebox.tracks.searchLibrary('bohemian');
    expect(track).toMatchObject({ source: 'local', artist: 'Queen', status: 'ready', genre: 'rock' });
  });
});

describe('metadata extraction', () => {
  it('parses ffprobe JSON (case-insensitive tags, stream tags, track "3/12", dates)', () => {
    const json = JSON.stringify({
      streams: [{ tags: { GENRE: 'Rock' } }],
      format: {
        duration: '354.32',
        tags: { TITLE: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera', date: '1975-10-31', track: '11/12' },
      },
    });
    expect(parseProbeOutput(json)).toEqual({
      title: 'Bohemian Rhapsody',
      artist: 'Queen',
      album: 'A Night at the Opera',
      genre: 'Rock',
      year: 1975,
      trackNumber: 11,
      durationSec: 354,
    });
    expect(parseProbeOutput('not json')).toBeNull();
    expect(parseProbeOutput(JSON.stringify({ format: { tags: { album_artist: 'VA', track: 'x' } } }))).toMatchObject({
      artist: 'VA',
      trackNumber: null,
      year: null,
      durationSec: null,
    });
  });

  it('infers category/artist/album from the folder structure', () => {
    const dir = '/music';
    expect(folderMetadata('/music/MPB/Djavan/Luz/01 - Sina.mp3', dir)).toEqual({ genre: 'MPB', artist: 'Djavan', album: 'Luz' });
    expect(folderMetadata('/music/Djavan/Luz/01 - Sina.mp3', dir)).toEqual({ genre: null, artist: 'Djavan', album: 'Luz' });
    expect(folderMetadata('/music/MPB/Sina.mp3', dir)).toEqual({ genre: 'MPB', artist: null, album: null });
    expect(folderMetadata('/music/Sina.mp3', dir)).toEqual({ genre: null, artist: null, album: null });
    expect(folderMetadata('/elsewhere/Sina.mp3', dir)).toEqual({ genre: null, artist: null, album: null });
  });

  it('prefers tags, then folders, then the file name', () => {
    const file = '/music/MPB/Djavan/Luz/03 - Sina.mp3';
    expect(resolveMetadata(file, '/music', null)).toEqual({
      title: 'Sina',
      artist: 'Djavan',
      album: 'Luz',
      genre: 'MPB',
      year: null,
      trackNumber: 3,
      durationSec: null,
    });
    expect(resolveMetadata(file, '/music', { title: 'Sina (Ao Vivo)', genre: 'Pop', year: 1982, trackNumber: 7 })).toMatchObject({
      title: 'Sina (Ao Vivo)',
      artist: 'Djavan',
      genre: 'Pop',
      year: 1982,
      trackNumber: 7,
    });
  });

  it('scanLibrary stores probed tags and survives probe failures', async () => {
    const { config, jukebox } = setup();
    const tagged = path.join(config.musicDir, 'inbox', 'a.mp3');
    const broken = path.join(config.musicDir, 'Rock', 'Queen', 'Innuendo', '02 - Headlong.mp3');
    write(tagged);
    write(broken);
    const probe: MetadataProbe = async (file) => {
      if (file === broken) throw new Error('corrupt');
      return { title: 'Tagged', artist: 'Tag Artist', album: 'Tag Album', genre: 'Jazz', year: 2001, trackNumber: 4, durationSec: 200 };
    };
    expect(await scanLibrary(jukebox.tracks, config.musicDir, { probe })).toBe(2);
    expect(jukebox.tracks.findByFilePath(tagged)).toMatchObject({
      title: 'Tagged',
      artist: 'Tag Artist',
      album: 'Tag Album',
      genre: 'Jazz',
      year: 2001,
      trackNumber: 4,
      durationSec: 200,
    });
    expect(jukebox.tracks.findByFilePath(broken)).toMatchObject({
      title: 'Headlong',
      artist: 'Queen',
      album: 'Innuendo',
      genre: 'Rock',
      trackNumber: 2,
    });
  });

  it('ffprobe probe resolves null and disables itself when the binary is missing', async () => {
    const probe = createFfprobe('/nonexistent/ffprobe-bin');
    expect(await probe('/tmp/whatever.mp3')).toBeNull();
    expect(probe.available).toBe(false);
  });
});

describe('migration v4', () => {
  it('upgrades an existing v3 database without losing rows', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jkbox-mig-')), 'jkbox.db');
    // Build a v3 database with the old schema and one row.
    const v3 = openDb(':memory:');
    const legacySchema = (v3.prepare("SELECT sql FROM sqlite_master WHERE name = 'tracks'").get() as { sql: string }).sql;
    v3.close();
    const raw = new DatabaseSync(file);
    raw.exec(
      legacySchema
        .replace(/,\s*genre TEXT/, '')
        .replace(/,\s*subgenre TEXT/, '')
        .replace(/,\s*genre_manual INTEGER NOT NULL DEFAULT 0/, '')
        .replace(/,\s*year INTEGER/, '')
        .replace(/,\s*track_number INTEGER/, '') + ';',
    );
    raw.exec(`INSERT INTO tracks (id, source, source_id, title, created_at) VALUES ('t1', 'local', '/a.mp3', 'Old', 1)`);
    raw.exec('CREATE TABLE queue (id INTEGER PRIMARY KEY); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    raw.exec('PRAGMA user_version = 3');
    raw.close();

    const db = openDb(file);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(7);
    const cols = (db.prepare('PRAGMA table_info(tracks)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['genre', 'subgenre', 'genre_manual', 'year', 'track_number', 'video_path']));
    const playlistCols = (db.prepare('PRAGMA table_info(playlists)').all() as { name: string }[]).map((c) => c.name);
    expect(playlistCols).toEqual(expect.arrayContaining(['source', 'source_id', 'thumbnail']));
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name);
    expect(indexes).toEqual(expect.arrayContaining(['idx_tracks_album', 'idx_tracks_artist', 'idx_tracks_genre', 'idx_tracks_subgenre']));
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['artist_genres', 'playlists', 'playlist_tracks']));
    expect(db.prepare("SELECT title, genre, subgenre, genre_manual FROM tracks WHERE id = 't1'").get()).toEqual({
      title: 'Old',
      genre: null,
      subgenre: null,
      genre_manual: 0,
    });
    db.close();
  });
});
