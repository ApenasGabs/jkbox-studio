import fs from 'node:fs';
import path from 'node:path';
import type { TrackRepository } from './tracks.js';

export const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.aac', '.opus', '.ogg', '.oga', '.webm', '.wav', '.flac']);

/** "Artist - Title" → { artist, title }; falls back to the bare file name as title. */
export function parseFileName(file: string): { artist: string; title: string } {
  const base = path.basename(file, path.extname(file)).replace(/_/g, ' ').trim();
  const match = base.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return match ? { artist: match[1].trim(), title: match[2].trim() } : { artist: '', title: base };
}

function* walk(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) yield full;
  }
}

/**
 * Imports audio files dropped manually into the music directory (the "Acervo Local").
 * Files already known to the database (including our own downloads) are skipped.
 * Returns the number of newly imported files.
 */
export function scanLibrary(tracks: TrackRepository, musicDir: string): number {
  const known = tracks.allFilePaths();
  let added = 0;
  for (const file of walk(musicDir)) {
    if (known.has(file)) continue;
    // Skip partial yt-dlp downloads (<uuid>.webm before conversion, .part files, etc.).
    if (/^[0-9a-f-]{36}\./i.test(path.basename(file))) continue;
    const { artist, title } = parseFileName(file);
    tracks.insertLocal(file, title, artist);
    added++;
  }
  return added;
}
