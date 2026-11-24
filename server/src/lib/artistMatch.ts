const GENERIC_ARTIST_TOKENS = new Set(['dj', 'mc', 'the', 'os', 'as', 'da', 'de', 'do']);

export function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTokenRegex(needle: string): RegExp {
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(needle)}(?:$|[^a-z0-9])`);
}

export function normalizeArtistForMatch(value: string): string {
  return fold(value)
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strict token-bounded artist match used across Spotify, Deezer, iTunes and MusicBrainz lookups. */
export function artistsMatch(expectedCandidates: readonly string[], returnedArtist: string): boolean {
  const candNorm = normalizeArtistForMatch(returnedArtist);
  if (!candNorm || candNorm.length < 2 || GENERIC_ARTIST_TOKENS.has(candNorm)) return false;

  return expectedCandidates.some((expected) => {
    const expNorm = normalizeArtistForMatch(expected);
    if (!expNorm || expNorm.length < 2 || GENERIC_ARTIST_TOKENS.has(expNorm)) return false;
    if (candNorm === expNorm) return true;
    const shorterLen = Math.min(candNorm.length, expNorm.length);
    if (shorterLen < 4) return false;
    return buildTokenRegex(expNorm).test(candNorm) || buildTokenRegex(candNorm).test(expNorm);
  });
}
