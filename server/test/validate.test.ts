import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { safeHttpUrl, sanitizeResult } from '../src/lib/validate.js';
import { setup, ytResult } from './helpers.js';

describe('sanitizeResult', () => {
  it('accepts a well-formed YouTube result and drops unsafe fields', () => {
    expect(
      sanitizeResult({ ...ytResult('dQw4w9WgXcQ'), thumbnail: 'javascript:alert(1)', durationSec: 'x', spotifyUri: 'bad' }),
    ).toMatchObject({ source: 'youtube', sourceId: 'dQw4w9WgXcQ', thumbnail: null, durationSec: null, spotifyUri: null });
  });

  it('rejects unknown sources and malformed ids', () => {
    expect(sanitizeResult({ source: 'soundcloud', sourceId: 'x', title: 't' })).toBeNull();
    expect(sanitizeResult({ source: 'youtube', sourceId: 'abc&list=1', title: 't' })).toBeNull();
    expect(sanitizeResult({ source: 'spotify', sourceId: '../me', title: 't' })).toBeNull();
    expect(sanitizeResult({ source: 'youtube', sourceId: 'dQw4w9WgXcQ', title: 42 })).toBeNull();
    expect(sanitizeResult(null)).toBeNull();
  });

  it('only keeps absolute http(s) urls', () => {
    expect(safeHttpUrl('https://i.ytimg.com/vi/x/hq.jpg')).toBe('https://i.ytimg.com/vi/x/hq.jpg');
    expect(safeHttpUrl('x) ; background:url(evil')).toBeNull();
    expect(safeHttpUrl('data:image/png;base64,AAAA')).toBeNull();
  });

  it('POST /api/queue rejects invalid payloads with 400', async () => {
    const { config, jukebox } = setup();
    const app = createApp({ config, jukebox });
    await request(app)
      .post('/api/queue')
      .send({ result: { source: 'youtube', sourceId: '--exec=rm', title: 'x' }, clientId: 'a' })
      .expect(400);
    await request(app).post('/api/queue').send({ result: { source: 'ftp', sourceId: 'a', title: 'x' }, clientId: 'a' }).expect(400);
  });
});
