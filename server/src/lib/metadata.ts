import type { TrackMetadataPatch } from '../types.js';

const TEXT_LIMITS = { title: 200, artist: 200, album: 200, genre: 100, subgenre: 100 } as const;
const ALLOWED = new Set(['title', 'artist', 'album', 'genre', 'subgenre', 'year', 'trackNumber']);

export type MetadataPatchResult = { ok: true; patch: TrackMetadataPatch } | { ok: false; error: string };

/** Validates the Host payload of PATCH /api/tracks/:id/metadata. */
export function parseMetadataPatch(input: unknown): MetadataPatchResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'Payload inválido' };
  const raw = input as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !ALLOWED.has(key));
  if (unknown.length > 0) return { ok: false, error: `Campos não permitidos: ${unknown.join(', ')}` };

  const patch: TrackMetadataPatch = {};
  for (const key of ['title', 'artist', 'album', 'genre', 'subgenre'] as const) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (value === null && (key === 'album' || key === 'genre' || key === 'subgenre')) {
      patch[key] = null;
      continue;
    }
    if (typeof value !== 'string') return { ok: false, error: `${key} deve ser texto` };
    const text = value.trim();
    if (text.length > TEXT_LIMITS[key]) return { ok: false, error: `${key} excede ${TEXT_LIMITS[key]} caracteres` };
    if (key === 'title') {
      if (!text) return { ok: false, error: 'title não pode ser vazio' };
      patch.title = text;
    } else if (key === 'artist') {
      patch.artist = text;
    } else {
      patch[key] = text || null;
    }
  }

  const ints = { year: [1000, 2100], trackNumber: [1, 999] } as const;
  for (const key of ['year', 'trackNumber'] as const) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (value === null) {
      patch[key] = null;
      continue;
    }
    const [min, max] = ints[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      return { ok: false, error: `${key} deve ser um inteiro entre ${min} e ${max}` };
    }
    patch[key] = value;
  }

  if (Object.keys(patch).length === 0) return { ok: false, error: 'Nenhum campo para atualizar' };
  return { ok: true, patch };
}
