import { describe, expect, it } from 'vitest';
import { orderQueue } from '../src/lib/fairQueue.js';

const item = (id: number, requesterId: string, votes = 0) => ({ id, requesterId, addedAt: id, votes });

describe('orderQueue', () => {
  it('keeps insertion order for a single requester', () => {
    expect(orderQueue([item(2, 'a'), item(1, 'a'), item(3, 'a')]).map((i) => i.id)).toEqual([1, 2, 3]);
  });

  it('round-robins between requesters so nobody floods the queue', () => {
    const order = orderQueue([item(1, 'a'), item(2, 'a'), item(3, 'a'), item(4, 'b'), item(5, 'c')]);
    expect(order.map((i) => i.id)).toEqual([1, 4, 5, 2, 3]);
  });

  it('puts more voted songs first', () => {
    const order = orderQueue([item(1, 'a'), item(2, 'b'), item(3, 'c', 2), item(4, 'd', 1)]);
    expect(order.map((i) => i.id)).toEqual([3, 4, 1, 2]);
  });
});
