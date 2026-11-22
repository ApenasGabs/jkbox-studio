import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFileName, scanLibrary } from '../src/services/library.js';
import { setup } from './helpers.js';

describe('local library', () => {
  it('parses "Artist - Title" file names', () => {
    expect(parseFileName('/m/Queen - Bohemian Rhapsody.mp3')).toEqual({ artist: 'Queen', title: 'Bohemian Rhapsody' });
    expect(parseFileName('/m/just_a_song.flac')).toEqual({ artist: '', title: 'just a song' });
  });

  it('imports dropped files once and makes them searchable', () => {
    const { config, jukebox } = setup();
    fs.mkdirSync(path.join(config.musicDir, 'rock'), { recursive: true });
    fs.writeFileSync(path.join(config.musicDir, 'rock', 'Queen - Bohemian Rhapsody.mp3'), 'x');
    fs.writeFileSync(path.join(config.musicDir, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(config.musicDir, '0f8fad5b-d9cb-469f-a165-70867728950e.webm'), 'x');

    expect(scanLibrary(jukebox.tracks, config.musicDir)).toBe(1);
    expect(scanLibrary(jukebox.tracks, config.musicDir)).toBe(0);
    const [track] = jukebox.tracks.searchLibrary('bohemian');
    expect(track).toMatchObject({ source: 'local', artist: 'Queen', status: 'ready' });
  });
});
