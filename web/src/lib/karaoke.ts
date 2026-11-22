const MEDIA_LINK_RE = /^(?:https?:\/\/|spotify:|(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\b)/i;
const KARAOKE_WORD_RE = /(?:^|[^\p{L}\p{N}_])karaok[eê](?:$|[^\p{L}\p{N}_])/iu;

/**
 * Appends "karaoke" to text search queries when the Karaoke filter is enabled,
 * leaving pasted media URLs and queries that already mention karaoke untouched.
 */
export function applyKaraokeFilter(rawQuery: string, enabled: boolean): string {
  const trimmed = rawQuery.trim();
  if (!enabled || !trimmed) return trimmed;
  if (MEDIA_LINK_RE.test(trimmed)) return trimmed;
  if (KARAOKE_WORD_RE.test(trimmed)) return trimmed;
  return `${trimmed} karaoke`;
}
