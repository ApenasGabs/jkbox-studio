export interface Orderable {
  id: number;
  requesterId: string;
  addedAt: number;
  votes: number;
}

/**
 * Orders queued items for a fair, collaborative jukebox:
 *  1. more votes first;
 *  2. on a tie, round-robin between requesters (each requester's 1st song
 *     comes before anyone's 2nd song), so nobody can flood the queue;
 *  3. then by insertion time.
 */
export function orderQueue<T extends Orderable>(items: readonly T[]): T[] {
  const byTime = [...items].sort((a, b) => a.addedAt - b.addedAt || a.id - b.id);
  const seen = new Map<string, number>();
  const rounds = new Map<number, number>();
  for (const item of byTime) {
    const round = seen.get(item.requesterId) ?? 0;
    rounds.set(item.id, round);
    seen.set(item.requesterId, round + 1);
  }
  return byTime.sort(
    (a, b) =>
      b.votes - a.votes ||
      rounds.get(a.id)! - rounds.get(b.id)! ||
      a.addedAt - b.addedAt ||
      a.id - b.id,
  );
}
