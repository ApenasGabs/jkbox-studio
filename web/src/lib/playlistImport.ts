import { ApiError } from './api';
import type { PlaylistImportResult, PlaylistSource } from './types';

export interface DetectedPlaylistLink {
  source: PlaylistSource;
  id: string;
  url: string;
}

export interface PlaylistImportSummaryText {
  headline: string;
  counts: string;
  toast: string;
}

export interface PlaylistImportErrorInfo {
  status?: number;
  title: string;
  message: string;
}

const YT_ID = /^[\w-]{11}$/;
const YT_PLAYLIST_ID = /^[\w-]{1,128}$/;

/** Detects whether a search/input string is a YouTube or Spotify playlist URL/URI. */
export function detectPlaylistLink(raw: string): DetectedPlaylistLink | null {
  const input = raw.trim();
  if (!input) return null;

  const spotifyUri = input.match(/^spotify:playlist:([A-Za-z0-9]+)$/);
  if (spotifyUri) {
    return { source: 'spotify', id: spotifyUri[1], url: input };
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, '');
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const v = url.searchParams.get('v');
    if (v && YT_ID.test(v)) return null;
    if (/^\/(?:shorts|embed|live|v)\/[\w-]{11}/.test(url.pathname)) return null;
    const list = url.searchParams.get('list');
    if (list && YT_PLAYLIST_ID.test(list)) {
      return { source: 'youtube', id: list, url: input };
    }
    return null;
  }

  if (host === 'open.spotify.com') {
    const match = url.pathname.match(/\/playlist\/([A-Za-z0-9]+)/);
    if (match) {
      return { source: 'spotify', id: match[1], url: input };
    }
  }

  return null;
}

/** Formats a user-facing summary of a completed playlist import. */
export function formatPlaylistImportSummary(result: PlaylistImportResult): PlaylistImportSummaryText {
  const headline = result.created
    ? `Playlist "${result.playlist.name}" importada`
    : `Playlist "${result.playlist.name}" atualizada`;

  const importedLabel = `${result.imported} ${result.imported === 1 ? 'importada' : 'importadas'}`;
  const cachedLabel = `${result.alreadyCached} já em cache`;
  const downloadingLabel = `${result.downloading} baixando`;

  const parts = [`${importedLabel}, ${cachedLabel}, ${downloadingLabel}`];
  if (result.queued > 0) {
    parts.push(`${result.queued} na fila`);
  }
  if (result.skipped > 0) {
    parts.push(`${result.skipped} ignorada${result.skipped === 1 ? '' : 's'}/duplicada${result.skipped === 1 ? '' : 's'}`);
  }

  return {
    headline,
    counts: parts.join(' · '),
    toast: `${headline}: ${importedLabel}, ${cachedLabel}, ${downloadingLabel}`,
  };
}

/** Maps API/network failures from POST /api/playlists/import into actionable UI messages. */
export function describePlaylistImportError(err: unknown): PlaylistImportErrorInfo {
  if (err instanceof ApiError) {
    switch (err.status) {
      case 400:
        return {
          status: 400,
          title: 'Link de playlist inválido',
          message: err.message || 'Cole um link válido de playlist do YouTube ou Spotify.',
        };
      case 404:
        return {
          status: 404,
          title: 'Playlist não encontrada ou privada',
          message: err.message || 'Verifique se a playlist existe e está pública no YouTube ou Spotify.',
        };
      case 422:
        return {
          status: 422,
          title: 'Playlist fora do limite permitido',
          message: err.message || 'A playlist está vazia ou ultrapassa o limite máximo de faixas.',
        };
      case 503:
        return {
          status: 503,
          title: 'Integração indisponível',
          message: err.message || 'Serviço temporariamente indisponível para importar esta playlist.',
        };
      default:
        return {
          status: err.status,
          title: 'Falha ao importar playlist',
          message: err.message || `Erro HTTP ${err.status} ao importar playlist.`,
        };
    }
  }

  if (err instanceof Error && err.message.trim()) {
    return {
      title: 'Falha ao importar playlist',
      message: err.message,
    };
  }

  return {
    title: 'Falha ao importar playlist',
    message: 'Não foi possível importar a playlist.',
  };
}
