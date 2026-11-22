import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { LocalTrackMeta, TrackRepository } from './tracks.js';

export const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.aac', '.opus', '.ogg', '.oga', '.webm', '.wav', '.flac']);

const MAX_TEXT = 200;
const FFPROBE_TIMEOUT_MS = 10_000;

/** Metadata read from the file's embedded tags (all optional). */
export interface ProbedMetadata {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  genre?: string | null;
  year?: number | null;
  trackNumber?: number | null;
  durationSec?: number | null;
}

/** Reads embedded tags of a media file; resolves null when unavailable. */
export type MetadataProbe = (file: string) => Promise<ProbedMetadata | null>;

/** "Artist - Title" → { artist, title }; falls back to the bare file name as title. */
export function parseFileName(file: string): { artist: string; title: string } {
  const base = path.basename(file, path.extname(file)).replace(/_/g, ' ').trim();
  const match = base.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return match ? { artist: match[1].trim(), title: match[2].trim() } : { artist: '', title: base };
}

/** Like parseFileName, but first strips a leading track number ("01 - Song", "02. Song", "3 Song"). */
export function parseTrackFileName(file: string): { artist: string; title: string; trackNumber: number | null } {
  const base = path.basename(file, path.extname(file)).replace(/_/g, ' ').trim();
  const numbered = base.match(/^(\d{1,3})(?:\s*[-–—.)]\s*|\s+)(.+)$/);
  if (numbered) {
    const { artist, title } = parseFileName(numbered[2] + path.extname(file));
    return { artist, title, trackNumber: positiveInt(numbered[1], 999) };
  }
  return { ...parseFileName(file), trackNumber: null };
}

function clean(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim().slice(0, MAX_TEXT);
  return text || null;
}

function positiveInt(value: unknown, max: number): number | null {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= max ? parsed : null;
}

/** "2019", "2019-05-01", "2019/05" → 2019. */
function parseYear(value: unknown): number | null {
  const match = String(value ?? '').match(/\b(\d{4})\b/);
  if (!match) return null;
  const year = Number(match[1]);
  return year >= 1000 && year <= 2100 ? year : null;
}

/** Parses `ffprobe -print_format json -show_format -show_streams` output. */
export function parseProbeOutput(json: string): ProbedMetadata | null {
  let data: { format?: { tags?: Record<string, unknown>; duration?: string }; streams?: { tags?: Record<string, unknown> }[] };
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  // Tag keys vary in case between containers (ID3 "TITLE", Vorbis "title", ...); stream tags fill the gaps (Ogg/Opus).
  const tags: Record<string, unknown> = {};
  for (const source of [...(data.streams ?? []).map((s) => s?.tags), data.format?.tags]) {
    if (!source || typeof source !== 'object') continue;
    for (const [key, value] of Object.entries(source)) tags[key.toLowerCase()] = value;
  }
  const duration = Number(data.format?.duration);
  return {
    title: clean(tags.title),
    artist: clean(tags.artist) ?? clean(tags.album_artist) ?? clean(tags.albumartist),
    album: clean(tags.album),
    genre: clean(tags.genre),
    year: parseYear(tags.date ?? tags.year ?? tags.originaldate),
    trackNumber: positiveInt(String(tags.track ?? tags.tracknumber ?? '').split('/')[0], 999),
    durationSec: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
  };
}

/**
 * Probe backed by `ffprobe` (shipped with ffmpeg). Uses execFile (no shell) with a timeout.
 * Resolves null on any failure so the scan can fall back to folders / file name.
 */
export function createFfprobe(bin = 'ffprobe', timeoutMs = FFPROBE_TIMEOUT_MS): MetadataProbe & { available: boolean } {
  const probe = ((file: string) =>
    new Promise<ProbedMetadata | null>((resolve) => {
      if (!probe.available) return resolve(null);
      execFile(
        bin,
        ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', '--', file],
        { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (err, stdout) => {
          if (err) {
            // Binary missing: stop trying for the rest of the process.
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') probe.available = false;
            return resolve(null);
          }
          resolve(parseProbeOutput(stdout));
        },
      );
    })) as MetadataProbe & { available: boolean };
  probe.available = true;
  return probe;
}

/**
 * Infers catalog fields from the folder structure relative to the music dir:
 * `<Categoria>/<Artista>/<Álbum>/01 - Música.mp3` (deeper levels are ignored),
 * `<Artista>/<Álbum>/file`, or `<Categoria>/file`.
 */
export function folderMetadata(file: string, musicDir: string): { genre: string | null; artist: string | null; album: string | null } {
  const rel = path.relative(musicDir, path.dirname(file));
  const parts = !rel || rel.startsWith('..') || path.isAbsolute(rel) ? [] : rel.split(path.sep).map(clean);
  if (parts.length >= 3) return { genre: parts[0], artist: parts[1], album: parts[2] };
  if (parts.length === 2) return { genre: null, artist: parts[0], album: parts[1] };
  if (parts.length === 1) return { genre: parts[0], artist: null, album: null };
  return { genre: null, artist: null, album: null };
}

/** Merges tags > folder structure > file name into the stored metadata. */
export function resolveMetadata(file: string, musicDir: string, probed: ProbedMetadata | null): LocalTrackMeta {
  const fromName = parseTrackFileName(file);
  const fromFolder = folderMetadata(file, musicDir);
  return {
    title: probed?.title || fromName.title,
    artist: probed?.artist || fromFolder.artist || fromName.artist,
    album: probed?.album || fromFolder.album,
    genre: probed?.genre || fromFolder.genre,
    year: probed?.year ?? null,
    trackNumber: probed?.trackNumber ?? fromName.trackNumber,
    durationSec: probed?.durationSec ?? null,
  };
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

const defaultProbe = createFfprobe();

export interface ScanOptions {
  /** Tag reader; defaults to ffprobe. Pass `null` to rely only on folders / file names. */
  probe?: MetadataProbe | null;
}

/**
 * Imports audio files dropped manually into the music directory (the "Acervo Local"),
 * reading tags with ffprobe and falling back to the folder structure and file name.
 * Files already known to the database (including our own downloads) are skipped.
 * Returns the number of newly imported files.
 */
export async function scanLibrary(tracks: TrackRepository, musicDir: string, options: ScanOptions = {}): Promise<number> {
  const probe = options.probe === undefined ? defaultProbe : options.probe;
  const known = tracks.allFilePaths();
  let added = 0;
  for (const file of walk(musicDir)) {
    if (known.has(file)) continue;
    // Skip partial yt-dlp downloads (<uuid>.webm before conversion, .part files, etc.).
    if (/^[0-9a-f-]{36}\./i.test(path.basename(file))) continue;
    let probed: ProbedMetadata | null = null;
    if (probe) {
      try {
        probed = await probe(file);
      } catch {
        probed = null;
      }
    }
    // Re-check after the async probe: a concurrent scan may have imported it meanwhile.
    if (tracks.findByFilePath(file)) continue;
    tracks.insertLocal(file, resolveMetadata(file, musicDir, probed));
    known.add(file);
    added++;
  }
  return added;
}
