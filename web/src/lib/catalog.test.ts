import { describe, expect, it } from 'vitest';
import {
  buildDiscoveryContext,
  buildMetadataPatch,
  editableFromResult,
  formatAlbumMeta,
  getCategoryTheme,
  getSubcategorySuggestions,
  mergeCategorySuggestions,
  playlistTrackFromResult,
  playlistTrackFromTrack,
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
        subgenre: ' MPB Clássica ',
        year: '1982',
        trackNumber: '3',
      }),
    ).toEqual({
      ok: true,
      patch: {
        title: 'Sina',
        artist: 'Djavan',
        album: null,
        genre: 'MPB',
        subgenre: 'MPB Clássica',
        year: 1982,
        trackNumber: 3,
      },
    });

    expect(getSubcategorySuggestions('Funk')).toContain('Funk Mandelão');
    expect(getSubcategorySuggestions('Funk')).toContain('Funk MTG');
    expect(getSubcategorySuggestions('Funk')).toContain('Funk Automotivo');

    expect(
      buildMetadataPatch({ title: '  ', artist: 'X', album: '', genre: '', subgenre: '', year: '', trackNumber: '' }),
    ).toMatchObject({ ok: false });
    expect(
      buildMetadataPatch({ title: 'X', artist: 'Y', album: '', genre: '', subgenre: '', year: '999', trackNumber: '' }),
    ).toMatchObject({ ok: false });
    expect(
      buildMetadataPatch({ title: 'X', artist: 'Y', album: '', genre: '', subgenre: '', year: '', trackNumber: '1000' }),
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

  it('builds PlaylistPickerTrack from Track or SearchResult with trackId', () => {
    expect(playlistTrackFromResult({ source: 'youtube', sourceId: 'abc', title: 'X', artist: 'Y' })).toBeNull();
    expect(
      playlistTrackFromResult({
        source: 'local',
        sourceId: '1',
        title: 'Evidências',
        artist: 'Chitãozinho',
        trackId: 't-1',
        thumbnail: 'https://img.test/a.jpg',
      }),
    ).toEqual({
      id: 't-1',
      title: 'Evidências',
      artist: 'Chitãozinho',
      thumbnail: 'https://img.test/a.jpg',
    });
    expect(
      playlistTrackFromTrack({
        id: 't-2',
        source: 'local',
        sourceId: '2',
        title: 'Sina',
        artist: 'Djavan',
        album: null,
        durationSec: 250,
        thumbnail: null,
        status: 'ready',
        progress: 1,
        error: null,
      }),
    ).toEqual({
      id: 't-2',
      title: 'Sina',
      artist: 'Djavan',
      thumbnail: null,
    });
  });

  it('builds discovery request contexts for playlist, category, and vibe modes', () => {
    expect(
      buildDiscoveryContext({ mode: 'playlist', playlistId: 'pl-1', label: 'Pagode 90' }),
    ).toEqual({
      mode: 'playlist',
      target: 'playlist',
      playlistId: 'pl-1',
      title: 'Popular semelhantes',
      subtitle: 'Playlist: Pagode 90',
    });

    expect(
      buildDiscoveryContext({ mode: 'category', category: 'Rock', subgenre: 'Rock Nacional', label: 'Rock · Rock Nacional' }),
    ).toEqual({
      mode: 'category',
      target: 'library',
      category: 'Rock',
      subgenre: 'Rock Nacional',
      title: 'Popular semelhantes',
      subtitle: 'Rock · Rock Nacional',
    });

    expect(buildDiscoveryContext({ mode: 'vibe' })).toEqual({
      mode: 'vibe',
      target: 'queue',
      title: 'Completar fila na vibe atual',
      subtitle: 'Recomendações baseadas nas últimas faixas tocadas',
    });
  });
});
