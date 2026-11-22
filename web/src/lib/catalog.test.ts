import { describe, expect, it } from 'vitest';
import {
  buildMetadataPatch,
  editableFromResult,
  formatAlbumMeta,
  getCategoryTheme,
  mergeCategorySuggestions,
  splitUncategorizedTracks,
} from './catalog';

describe('catalog helpers', () => {
  it('assigns deterministic category themes and a dedicated uncategorized theme', () => {
    expect(getCategoryTheme('Rock')).toEqual(getCategoryTheme(' rock '));
    expect(getCategoryTheme('Sem Categoria', true)).not.toEqual(getCategoryTheme('Rock'));
  });

  it('merges existing categories with defaults without case duplicates', () => {
    const merged = mergeCategorySuggestions([
      { name: 'rock', trackCount: 3, albumCount: 1, artistCount: 1, cover: null },
      { name: 'Forró', trackCount: 2, albumCount: 1, artistCount: 1, cover: null },
    ]);
    expect(merged[0]).toBe('rock');
    expect(merged[1]).toBe('Forró');
    expect(merged.filter((c) => c.toLowerCase() === 'rock')).toHaveLength(1);
    expect(merged).toContain('MPB');
  });

  it('extracts uncategorized tracks and representative cover', () => {
    const { tracks, cover } = splitUncategorizedTracks([
      { source: 'local', sourceId: '1', title: 'A', artist: 'X', genre: 'Rock', thumbnail: 'http://a' },
      { source: 'local', sourceId: '2', title: 'B', artist: 'Y', genre: null, thumbnail: null },
      { source: 'local', sourceId: '3', title: 'C', artist: 'Z', genre: '  ', thumbnail: 'http://c' },
    ]);
    expect(tracks.map((t) => t.title)).toEqual(['B', 'C']);
    expect(cover).toBe('http://c');
  });

  it('converts only cached/tracked SearchResult into EditableTrack', () => {
    expect(editableFromResult({ source: 'youtube', sourceId: 'abc', title: 'X', artist: 'Y' })).toBeNull();
    expect(
      editableFromResult({ source: 'local', sourceId: '1', title: 'X', artist: 'Y', cached: false, trackId: 't1' }),
    ).toBeNull();
    expect(
      editableFromResult({
        source: 'local',
        sourceId: '1',
        title: 'Sina',
        artist: 'Djavan',
        album: 'Luz',
        genre: 'MPB',
        year: 1982,
        trackNumber: 3,
        trackId: 't1',
        cached: true,
      }),
    ).toMatchObject({ id: 't1', title: 'Sina', genre: 'MPB', year: 1982, trackNumber: 3 });
  });

  it('validates and normalizes metadata patch form values', () => {
    expect(
      buildMetadataPatch({
        title: '  Sina ',
        artist: ' Djavan ',
        album: '',
        genre: ' MPB ',
        year: '1982',
        trackNumber: '3',
      }),
    ).toEqual({
      ok: true,
      patch: { title: 'Sina', artist: 'Djavan', album: null, genre: 'MPB', year: 1982, trackNumber: 3 },
    });

    expect(
      buildMetadataPatch({ title: '  ', artist: 'X', album: '', genre: '', year: '', trackNumber: '' }),
    ).toMatchObject({ ok: false });
    expect(
      buildMetadataPatch({ title: 'X', artist: 'Y', album: '', genre: '', year: '999', trackNumber: '' }),
    ).toMatchObject({ ok: false });
    expect(
      buildMetadataPatch({ title: 'X', artist: 'Y', album: '', genre: '', year: '', trackNumber: '1000' }),
    ).toMatchObject({ ok: false });
  });

  it('formats album metadata summary', () => {
    expect(
      formatAlbumMeta({
        name: 'Luz',
        artist: 'Djavan',
        genre: 'MPB',
        year: 1982,
        trackCount: 1,
        totalDurationSec: 250,
        cover: null,
      }),
    ).toBe('1 música · 4:10');
  });
});
