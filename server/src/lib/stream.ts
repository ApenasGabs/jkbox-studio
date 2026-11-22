import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';

const MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.opus': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.webm': 'audio/webm',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
};

export function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Parses a single-range "bytes=start-end" header. Returns null when unsatisfiable. */
export function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start: number;
  let end: number;
  if (match[1] === '') {
    // Suffix range: last N bytes.
    const suffix = Number(match[2]);
    if (suffix === 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start > end || start >= size) return null;
  return { start, end };
}

/** Streams an audio file with HTTP Range support so <audio> can seek. */
export function streamFile(req: Request, res: Response, file: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    res.status(404).json({ error: 'Arquivo de áudio não encontrado' });
    return;
  }
  const size = stat.size;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mimeFor(file));
  res.setHeader('Cache-Control', 'public, max-age=86400');

  const header = req.headers.range;
  if (!header) {
    res.setHeader('Content-Length', size);
    if (req.method === 'HEAD') return void res.end();
    fs.createReadStream(file).pipe(res);
    return;
  }
  const range = parseRange(header, size);
  if (!range) {
    res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
    return;
  }
  res.status(206);
  res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
  res.setHeader('Content-Length', range.end - range.start + 1);
  if (req.method === 'HEAD') return void res.end();
  fs.createReadStream(file, range).pipe(res);
}
