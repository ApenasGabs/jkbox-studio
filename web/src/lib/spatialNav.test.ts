import { describe, expect, it } from 'vitest';
import { findNextSpatialCandidate, type RectLike } from './spatialNav';

interface Box {
  id: string;
  rect: RectLike;
}

function box(id: string, left: number, top: number, width = 100, height = 60): Box {
  return {
    id,
    rect: { left, top, width, height, right: left + width, bottom: top + height },
  };
}

describe('spatialNav', () => {
  it('navigates cleanly across a 2D catalog grid (including partial last row)', () => {
    const items = [
      box('c1', 0, 0),
      box('c2', 120, 0),
      box('c3', 240, 0),
      box('c4', 0, 80),
      box('c5', 120, 80),
    ];

    expect(findNextSpatialCandidate(items[0].rect, items, 'RIGHT')?.id).toBe('c2');
    expect(findNextSpatialCandidate(items[1].rect, items, 'LEFT')?.id).toBe('c1');
    expect(findNextSpatialCandidate(items[1].rect, items, 'DOWN')?.id).toBe('c5');
    expect(findNextSpatialCandidate(items[2].rect, items, 'DOWN')?.id).toBe('c5');
    expect(findNextSpatialCandidate(items[4].rect, items, 'UP')?.id).toBe('c2');
    expect(findNextSpatialCandidate(items[0].rect, items, 'UP')).toBeNull();
    expect(findNextSpatialCandidate(items[0].rect, items, 'LEFT')).toBeNull();
  });

  it('jumps horizontally from main player controls to desktop queue sidebar', () => {
    const play = box('play', 300, 600, 56, 56);
    const skip = box('skip', 370, 604, 48, 48);
    const q1Vote = box('q1-vote', 980, 240, 48, 48);
    const q2Vote = box('q2-vote', 980, 580, 48, 48);

    const all = [play, skip, q1Vote, q2Vote];
    expect(findNextSpatialCandidate(play.rect, all, 'RIGHT')?.id).toBe('skip');
    expect(findNextSpatialCandidate(skip.rect, all, 'RIGHT')?.id).toBe('q2-vote');
    expect(findNextSpatialCandidate(q2Vote.rect, all, 'LEFT')?.id).toBe('skip');
  });

  it('jumps vertically from main player controls to mobile/tablet stacked queue', () => {
    const play = box('play', 100, 420, 56, 56);
    const skip = box('skip', 170, 424, 48, 48);
    const q1Vote = box('q1-vote', 280, 560, 48, 48);

    const all = [play, skip, q1Vote];
    expect(findNextSpatialCandidate(skip.rect, all, 'DOWN')?.id).toBe('q1-vote');
    expect(findNextSpatialCandidate(q1Vote.rect, all, 'UP')?.id).toBe('skip');
  });
});
