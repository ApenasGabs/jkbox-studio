export type ParsedInput =
  | { kind: 'youtube'; videoId: string }
  | { kind: 'youtube-playlist'; playlistId: string; url: string }
  | { kind: 'spotify-track'; id: string }
  | { kind: 'spotify-playlist'; id: string }
  | { kind: 'spotify-album'; id: string }
  | { kind: 'query'; query: string };

const YT_ID = /^[\w-]{11}$/;
const YT_PLAYLIST_ID = /^[\w-]{1,128}$/;

/** Detects YouTube / Spotify links (or URIs) pasted in the search box. */
export function parseInput(raw: string): ParsedInput {
  const input = raw.trim();

  const spotifyUri = input.match(/^spotify:(track|playlist|album):([A-Za-z0-9]+)$/);
  if (spotifyUri) return spotifyKind(spotifyUri[1], spotifyUri[2]) ?? { kind: 'query', query: input };

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { kind: 'query', query: input };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { kind: 'query', query: input };
  }
  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, '');

  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    if (YT_ID.test(id)) return { kind: 'youtube', videoId: id };
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const v = url.searchParams.get('v');
    if (v && YT_ID.test(v)) return { kind: 'youtube', videoId: v };
    const pathMatch = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
    if (pathMatch) return { kind: 'youtube', videoId: pathMatch[1] };
    const list = url.searchParams.get('list');
    if (list && YT_PLAYLIST_ID.test(list)) return { kind: 'youtube-playlist', playlistId: list, url: input };
  }
  if (host === 'open.spotify.com') {
    // e.g. /track/<id>, /intl-pt/track/<id>, /playlist/<id>
    const match = url.pathname.match(/\/(track|playlist|album)\/([A-Za-z0-9]+)/);
    if (match) {
      const kind = spotifyKind(match[1], match[2]);
      if (kind) return kind;
    }
  }
  return { kind: 'query', query: input };
}

function spotifyKind(type: string, id: string): ParsedInput | null {
  if (type === 'track') return { kind: 'spotify-track', id };
  if (type === 'playlist') return { kind: 'spotify-playlist', id };
  if (type === 'album') return { kind: 'spotify-album', id };
  return null;
}
