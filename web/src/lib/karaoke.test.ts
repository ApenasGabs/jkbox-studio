import { describe, expect, it } from 'vitest';
import { applyKaraokeFilter } from './karaoke';

describe('applyKaraokeFilter', () => {
  it('leaves query trimmed when disabled', () => {
    expect(applyKaraokeFilter('  Evidências  ', false)).toBe('Evidências');
  });

  it('appends karaoke when enabled for a plain text query', () => {
    expect(applyKaraokeFilter('Evidências', true)).toBe('Evidências karaoke');
  });

  it('does not duplicate karaoke when already present (accent or case insensitive)', () => {
    expect(applyKaraokeFilter('Evidências karaoke', true)).toBe('Evidências karaoke');
    expect(applyKaraokeFilter('Bohemian Rhapsody Karaokê', true)).toBe('Bohemian Rhapsody Karaokê');
  });

  it('leaves empty queries and media URLs untouched', () => {
    expect(applyKaraokeFilter('   ', true)).toBe('');
    expect(applyKaraokeFilter('https://youtu.be/dQw4w9WgXcQ', true)).toBe('https://youtu.be/dQw4w9WgXcQ');
    expect(applyKaraokeFilter('spotify:track:12345', true)).toBe('spotify:track:12345');
  });
});
