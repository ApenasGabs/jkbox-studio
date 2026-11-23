import type { SearchResult } from '../types.js';

const NON_CLIP_RE =
  /\b(reaction|react|tutorial|karaoke|instrumental|cover|nightcore|slowed|reverb|8d\s*audio|1\s*hour|teaser|trailer|shorts|podcast|interview|entrevista|making\s*of|behind\s*the\s*scenes)\b/i;
const OFFICIAL_VIDEO_RE =
  /\b(official\s*(music\s*)?video|clipe\s*oficial|videoclipe|v[ií]deo\s*oficial|music\s*video|mv)\b/i;
const VIDEO_HINT_RE = /\b(video|v[ií]deo|clipe)\b/i;
const AUDIO_ONLY_RE = /\b(official\s*audio|audio\s*only|[áa]udio\s*oficial|audio)\b/i;
const LYRIC_VIDEO_RE = /\b(lyric\s*video|lyrics|letra|legendado)\b/i;

/** Removes parenthetical/bracketed suffixes (e.g. "(Remastered)", "[Live]") and normalizes spacing. */
export function stripTitleBrackets(value: string): string {
  return value
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Query used to find the matching audio on YouTube (spotDL approach). */
export function youtubeQueryFor(result: { title: string; artist: string }): string {
  return `${result.artist} - ${result.title} audio`.trim();
}

/** Query used to prioritize an official music video on YouTube for a track. */
export function youtubeVideoQueryFor(result: { title: string; artist: string }): string {
  return `${result.artist ? `${result.artist} - ` : ''}${result.title} official video`.trim();
}

function normalizeText(value: string): string {
  return stripTitleBrackets(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function significantTokens(value: string): string[] {
  return normalizeText(value)
    .split(' ')
    .filter((token) => token.length >= 2);
}

function hasPhrase(haystack: string, phrase: string): boolean {
  return Boolean(haystack && phrase && ` ${haystack} `.includes(` ${phrase} `));
}

/** Returns true when a YouTube candidate's duration is compatible with the target track duration. */
export function isDurationCompatible(
  candidateSec: number | null | undefined,
  targetSec: number | null | undefined,
): boolean {
  if (typeof targetSec !== 'number' || !Number.isFinite(targetSec) || targetSec <= 0) {
    return typeof candidateSec !== 'number' || (candidateSec >= 30 && candidateSec <= 900);
  }
  if (typeof candidateSec !== 'number' || !Number.isFinite(candidateSec) || candidateSec <= 0) {
    return false;
  }
  const tolerance = Math.max(15, Math.min(45, Math.round(targetSec * 0.2)));
  return Math.abs(candidateSec - targetSec) <= tolerance;
}

/**
 * Picks the best YouTube music-video candidate for a track by requiring a real title match,
 * filtering out non-clips and duration mismatches, and scoring official video hints above audio-only uploads.
 */
export function pickYoutubeVideoCandidate(
  candidates: SearchResult[],
  track: { title: string; artist: string; durationSec?: number | null },
): SearchResult | null {
  const normTitle = normalizeText(track.title);
  const titleTokens = significantTokens(track.title);
  const requiredTitleTokens = titleTokens.length >= 2 ? 2 : titleTokens.length;
  const primaryArtist = normalizeText(track.artist.split(',')[0] ?? '');
  const artistTokens = significantTokens(primaryArtist);

  let best: { result: SearchResult; score: number } | null = null;
  for (const candidate of candidates) {
    if (!candidate.sourceId) continue;
    if (!isDurationCompatible(candidate.durationSec, track.durationSec)) continue;

    const noiseMatch = candidate.title.match(NON_CLIP_RE);
    if (noiseMatch && !track.title.toLowerCase().includes(noiseMatch[1].toLowerCase())) continue;

    const normCandidateTitle = normalizeText(candidate.title);
    const normCandidateArtist = normalizeText(candidate.artist);
    const candidateHaystack = `${normCandidateTitle} ${normCandidateArtist}`.trim();
    const candidateTitleWords = new Set(normCandidateTitle.split(' ').filter(Boolean));
    const candidateHaystackWords = new Set(candidateHaystack.split(' ').filter(Boolean));

    const matchedTitleTokens = titleTokens.filter((token) => candidateTitleWords.has(token)).length;
    const titleMatches =
      hasPhrase(normCandidateTitle, normTitle) ||
      (titleTokens.length > 0 && matchedTitleTokens >= requiredTitleTokens);

    if (normTitle && !titleMatches) continue;

    const artistMatches =
      hasPhrase(candidateHaystack, primaryArtist) ||
      artistTokens.some((token) => candidateHaystackWords.has(token));

    let score = 0;
    if (OFFICIAL_VIDEO_RE.test(candidate.title)) score += 4;
    else if (VIDEO_HINT_RE.test(candidate.title)) score += 2;
    if (LYRIC_VIDEO_RE.test(candidate.title) && !LYRIC_VIDEO_RE.test(track.title)) score -= 1;
    if (AUDIO_ONLY_RE.test(candidate.title) && !AUDIO_ONLY_RE.test(track.title)) score -= 3;
    if (/-\s*topic$/i.test(candidate.artist)) score -= 3;
    if (hasPhrase(normCandidateTitle, normTitle)) score += 3;
    else if (titleMatches) score += 1;
    if (artistMatches) score += 1;

    if (
      typeof track.durationSec === 'number' &&
      track.durationSec > 0 &&
      typeof candidate.durationSec === 'number' &&
      candidate.durationSec > 0
    ) {
      score -= Math.abs(candidate.durationSec - track.durationSec) / 100;
    }

    if (!best || score > best.score) {
      best = { result: candidate, score };
    }
  }

  return best?.result ?? null;
}
