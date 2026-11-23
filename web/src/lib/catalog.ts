import { formatTime } from './format';
import type {
  CatalogAlbum,
  CatalogCategory,
  DiscoveryMode,
  DiscoveryTarget,
  SearchResult,
  Track,
  TrackMetadataPatch,
} from './types';

export interface DiscoverSimilarRequest {
  mode: 'category' | 'playlist';
  category?: string;
  subgenre?: string | null;
  playlistId?: string;
  label: string;
}

export interface DiscoveryRequestContext {
  mode: DiscoveryMode;
  target: DiscoveryTarget;
  title: string;
  subtitle?: string;
  playlistId?: string;
  category?: string;
  subgenre?: string | null;
}

/** Builds a `DiscoveryRequestContext` for catalog (`category`/`playlist`) or host (`vibe`) discovery triggers. */
export function buildDiscoveryContext(req: DiscoverSimilarRequest | { mode: 'vibe' }): DiscoveryRequestContext {
  if (req.mode === 'vibe') {
    return {
      mode: 'vibe',
      target: 'queue',
      title: 'Completar fila na vibe atual',
      subtitle: 'Recomendações baseadas nas últimas faixas tocadas',
    };
  }
  if (req.mode === 'playlist') {
    return {
      mode: 'playlist',
      target: 'playlist',
      playlistId: req.playlistId,
      title: 'Popular semelhantes',
      subtitle: `Playlist: ${req.label}`,
    };
  }
  return {
    mode: 'category',
    target: 'library',
    category: req.category,
    subgenre: req.subgenre ?? null,
    title: 'Popular semelhantes',
    subtitle: req.label,
  };
}

export type CatalogTab = 'categories' | 'playlists' | 'albums' | 'artists' | 'all';

export type CatalogRoute =
  | { kind: 'root' }
  | { kind: 'category'; name: string; subgenre?: string | null; uncategorized?: boolean }
  | { kind: 'playlist'; id: string; name?: string }
  | { kind: 'album'; name: string; artist: string }
  | { kind: 'artist'; name: string };

export interface PlaylistPickerTrack {
  id: string;
  title: string;
  artist: string;
  thumbnail: string | null;
}

export interface EditableTrack {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  genre: string | null;
  subgenre: string | null;
  year: number | null;
  trackNumber: number | null;
  thumbnail: string | null;
}

export interface MetadataFormValues {
  title: string;
  artist: string;
  album: string;
  genre: string;
  subgenre: string;
  year: string;
  trackNumber: string;
}

export interface CategoryTheme {
  gradient: string;
  border: string;
  badge: string;
}

const CATEGORY_THEMES: readonly CategoryTheme[] = [
  {
    gradient: 'from-violet-950 via-purple-900/90 to-fuchsia-950',
    border: 'border-purple-400/25 hover:border-purple-300/50',
    badge: 'bg-purple-400/20 text-purple-200',
  },
  {
    gradient: 'from-cyan-950 via-sky-900/90 to-indigo-950',
    border: 'border-cyan-400/25 hover:border-cyan-300/50',
    badge: 'bg-cyan-400/20 text-cyan-200',
  },
  {
    gradient: 'from-emerald-950 via-teal-900/90 to-cyan-950',
    border: 'border-emerald-400/25 hover:border-emerald-300/50',
    badge: 'bg-emerald-400/20 text-emerald-200',
  },
  {
    gradient: 'from-rose-950 via-pink-900/90 to-purple-950',
    border: 'border-rose-400/25 hover:border-rose-300/50',
    badge: 'bg-rose-400/20 text-rose-200',
  },
  {
    gradient: 'from-amber-950 via-orange-900/85 to-rose-950',
    border: 'border-amber-400/25 hover:border-amber-300/50',
    badge: 'bg-amber-400/20 text-amber-200',
  },
  {
    gradient: 'from-indigo-950 via-blue-900/90 to-violet-950',
    border: 'border-indigo-400/25 hover:border-indigo-300/50',
    badge: 'bg-indigo-400/20 text-indigo-200',
  },
];

const UNCATEGORIZED_THEME: CategoryTheme = {
  gradient: 'from-zinc-900 via-slate-900 to-zinc-950',
  border: 'border-white/15 hover:border-white/30',
  badge: 'bg-white/10 text-zinc-300',
};

export const DEFAULT_CATEGORY_SUGGESTIONS = [
  'Samba & Pagode',
  'Sertanejo',
  'Funk',
  'Gospel',
  'Rock',
  'MPB',
  'Pop',
  'Forró & Piseiro',
  'Rap & Trap',
  'Eletrônica',
  'Reggae',
  'Flashback',
  'Karaokê',
] as const;

export const SUBCATEGORY_SUGGESTIONS_BY_CATEGORY: Record<string, readonly string[]> = {
  funk: ['Funk Anos 2000', 'Funk Mandelão', 'Funk Bruxaria', 'Funk Melody', 'Funk Ostentação', 'Funk Pop'],
  'samba & pagode': ['Pagode 90', 'Pagode Atual', 'Samba Raiz'],
  pagode: ['Pagode 90', 'Pagode Atual', 'Samba Raiz'],
  sertanejo: ['Sertanejo Raiz', 'Sertanejo Universitário', 'Feminejo', 'Agronejo'],
  gospel: ['Louvor & Adoração', 'Gospel Pentecostal', 'Gospel Jovem'],
  rock: ['Rock Nacional', 'Rock Clássico', 'Pop Rock', 'Metal & Hard Rock'],
  mpb: ['MPB Clássica', 'Bossa Nova', 'Nova MPB'],
  pop: ['Pop Nacional', 'Pop Internacional'],
  'forró & piseiro': ['Piseiro', 'Forró Eletrônico', 'Forró Tradicional'],
  'rap & trap': ['Rap Nacional', 'Trap BR', 'Hip Hop Internacional'],
  eletrônica: ['EDM & House', 'Brazilian Bass', 'Psytrance & Techno'],
  reggae: ['Reggae Nacional', 'Reggae Roots'],
  flashback: ['Flashback 70s/80s', 'Flashback 90s/2000s'],
};

export function getSubcategorySuggestions(genre: string): string[] {
  const key = genre.trim().toLowerCase();
  if (!key) return [];
  return [...(SUBCATEGORY_SUGGESTIONS_BY_CATEGORY[key] ?? [])];
}

export function getCategoryTheme(name: string, uncategorized = false): CategoryTheme {
  if (uncategorized) return UNCATEGORIZED_THEME;
  const normalized = name.trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  return CATEGORY_THEMES[hash % CATEGORY_THEMES.length];
}

export function mergeCategorySuggestions(categories: CatalogCategory[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const name of [...categories.map((c) => c.name), ...DEFAULT_CATEGORY_SUGGESTIONS]) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(trimmed);
  }
  return merged;
}

export function splitUncategorizedTracks(results: SearchResult[]): {
  tracks: SearchResult[];
  cover: string | null;
} {
  const tracks = results.filter((r) => !r.genre || !r.genre.trim());
  const cover = tracks.find((t) => Boolean(t.thumbnail))?.thumbnail ?? null;
  return { tracks, cover };
}

export function editableFromTrack(track: Track): EditableTrack {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album ?? null,
    genre: track.genre ?? null,
    subgenre: track.subgenre ?? null,
    year: track.year ?? null,
    trackNumber: track.trackNumber ?? null,
    thumbnail: track.thumbnail,
  };
}

export function editableFromResult(result: SearchResult): EditableTrack | null {
  if (!result.trackId || result.cached === false) return null;
  return {
    id: result.trackId,
    title: result.title,
    artist: result.artist,
    album: result.album ?? null,
    genre: result.genre ?? null,
    subgenre: result.subgenre ?? null,
    year: result.year ?? null,
    trackNumber: result.trackNumber ?? null,
    thumbnail: result.thumbnail ?? null,
  };
}

export function buildMetadataPatch(
  values: MetadataFormValues,
): { ok: true; patch: TrackMetadataPatch } | { ok: false; error: string } {
  const title = values.title.trim();
  if (!title) return { ok: false, error: 'Informe o título da música.' };
  if (title.length > 200) return { ok: false, error: 'Título deve ter no máximo 200 caracteres.' };

  const artist = values.artist.trim();
  if (artist.length > 200) return { ok: false, error: 'Artista deve ter no máximo 200 caracteres.' };

  const album = values.album.trim();
  if (album.length > 200) return { ok: false, error: 'Álbum deve ter no máximo 200 caracteres.' };

  const genre = values.genre.trim();
  if (genre.length > 100) return { ok: false, error: 'Categoria deve ter no máximo 100 caracteres.' };

  const subgenre = values.subgenre.trim();
  if (subgenre.length > 100) return { ok: false, error: 'Subcategoria deve ter no máximo 100 caracteres.' };

  let year: number | null = null;
  const rawYear = values.year.trim();
  if (rawYear !== '') {
    if (!/^\d+$/.test(rawYear)) return { ok: false, error: 'Ano deve ser um número inteiro entre 1000 e 2100.' };
    const parsedYear = Number(rawYear);
    if (parsedYear < 1000 || parsedYear > 2100) {
      return { ok: false, error: 'Ano deve estar entre 1000 e 2100.' };
    }
    year = parsedYear;
  }

  let trackNumber: number | null = null;
  const rawTrackNumber = values.trackNumber.trim();
  if (rawTrackNumber !== '') {
    if (!/^\d+$/.test(rawTrackNumber)) return { ok: false, error: 'Nº da faixa deve ser um inteiro entre 1 e 999.' };
    const parsedNum = Number(rawTrackNumber);
    if (parsedNum < 1 || parsedNum > 999) {
      return { ok: false, error: 'Nº da faixa deve estar entre 1 e 999.' };
    }
    trackNumber = parsedNum;
  }

  return {
    ok: true,
    patch: {
      title,
      artist,
      album: album || null,
      genre: genre || null,
      subgenre: subgenre || null,
      year,
      trackNumber,
    },
  };
}

export function playlistTrackFromTrack(track: Track): PlaylistPickerTrack {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    thumbnail: track.thumbnail,
  };
}

export function playlistTrackFromResult(result: SearchResult): PlaylistPickerTrack | null {
  if (!result.trackId) return null;
  return {
    id: result.trackId,
    title: result.title,
    artist: result.artist,
    thumbnail: result.thumbnail ?? null,
  };
}

export function formatTrackCount(count: number): string {
  return count === 1 ? '1 música' : `${count} músicas`;
}

export function formatAlbumCount(count: number): string {
  return count === 1 ? '1 álbum' : `${count} álbuns`;
}

export function formatAlbumMeta(album: CatalogAlbum): string {
  const parts = [formatTrackCount(album.trackCount)];
  if (album.totalDurationSec > 0) parts.push(formatTime(album.totalDurationSec));
  return parts.join(' · ');
}
