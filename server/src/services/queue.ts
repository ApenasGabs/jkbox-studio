import { EventEmitter } from 'node:events';
import type { Db } from '../db.js';
import { orderQueue } from '../lib/fairQueue.js';
import type { JukeboxState, NowPlaying, QueueEntryView, QueueItem, QueueStatus } from '../types.js';
import type { TrackRepository } from './tracks.js';

interface QueueRow {
  id: number;
  track_id: string;
  requester_id: string;
  requester_name: string;
  added_at: number;
  status: QueueStatus;
  started_at: number | null;
}

export class QueueError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface QueueEvents {
  change: [];
  progress: [positionSec: number, paused: boolean];
  drained: [];
}

export interface EnqueueResult {
  item: QueueEntryView;
  /** The track was already in the queue; the request counted as a vote instead. */
  duplicate: boolean;
}

/** Collaborative queue + playback state machine. The kiosk browser does the actual audio playback. */
export class QueueService extends EventEmitter<QueueEvents> {
  private positionSec = 0;
  private paused = false;

  constructor(
    private readonly db: Db,
    private readonly tracks: TrackRepository,
  ) {
    super();
  }

  enqueue(trackId: string, requesterId: string, requesterName: string): EnqueueResult {
    if (!this.tracks.get(trackId)) throw new QueueError('Faixa não encontrada', 404);
    const existing = this.db
      .prepare("SELECT * FROM queue WHERE track_id = ? AND status IN ('queued', 'playing') LIMIT 1")
      .get(trackId) as QueueRow | undefined;
    if (existing) {
      if (existing.status === 'queued' && existing.requester_id !== requesterId) {
        this.addVote(existing.id, requesterId);
        this.emit('change');
      }
      return { item: this.view(existing), duplicate: true };
    }
    const result = this.db
      .prepare('INSERT INTO queue (track_id, requester_id, requester_name, added_at) VALUES (?, ?, ?, ?)')
      .run(trackId, requesterId, requesterName.trim().slice(0, 40) || 'Convidado', Date.now());
    const row = this.getRow(Number(result.lastInsertRowid))!;
    this.advanceIfIdle();
    this.emit('change');
    return { item: this.view(row), duplicate: false };
  }

  /** Toggles the voter's vote on a queued item. Returns whether the vote is now active. */
  vote(queueId: number, voterId: string): boolean {
    const row = this.getRow(queueId);
    if (!row || row.status !== 'queued') throw new QueueError('Item não está na fila', 404);
    const had = this.db.prepare('SELECT 1 FROM votes WHERE queue_id = ? AND voter_id = ?').get(queueId, voterId);
    if (had) this.db.prepare('DELETE FROM votes WHERE queue_id = ? AND voter_id = ?').run(queueId, voterId);
    else this.addVote(queueId, voterId);
    this.emit('change');
    return !had;
  }

  remove(queueId: number, requesterId: string, isHost: boolean): void {
    const row = this.getRow(queueId);
    if (!row || (row.status !== 'queued' && row.status !== 'playing')) throw new QueueError('Item não está na fila', 404);
    if (!isHost && row.requester_id !== requesterId) {
      throw new QueueError('Apenas quem pediu a música ou o host pode removê-la', 403);
    }
    if (row.status === 'playing') {
      this.finishCurrent('removed');
      const advanced = this.advanceIfIdle();
      this.emit('change');
      if (!advanced && this.ordered().length === 0) this.emit('drained');
    } else {
      this.setStatus(queueId, 'removed');
      this.emit('change');
    }
  }

  skip(): void {
    if (!this.currentRow()) return;
    this.finishCurrent('played');
    const advanced = this.advanceIfIdle();
    this.emit('change');
    if (!advanced && this.ordered().length === 0) this.emit('drained');
  }

  /** Called by the kiosk when the audio element fires "ended" (idempotent per item). */
  ended(queueId: number): void {
    const current = this.currentRow();
    if (!current || current.id !== queueId) return;
    this.skip();
  }

  reportProgress(positionSec: number, paused: boolean): void {
    if (!this.currentRow()) return;
    this.positionSec = Math.max(0, positionSec);
    this.paused = paused;
    this.emit('progress', this.positionSec, this.paused);
  }

  /** Starts the next ready track when nothing is playing. Called when downloads finish. */
  advanceIfIdle(): boolean {
    if (this.currentRow()) return false;
    const next = this.ordered().find((entry) => entry.track.status === 'ready');
    if (!next) return false;
    this.db.prepare("UPDATE queue SET status = 'playing', started_at = ? WHERE id = ?").run(Date.now(), next.id);
    this.positionSec = 0;
    this.paused = false;
    this.emit('change');
    return true;
  }

  state(): JukeboxState {
    const current = this.currentRow();
    const nowPlaying: NowPlaying | null = current
      ? {
          item: this.view(current),
          startedAt: current.started_at ?? Date.now(),
          positionSec: this.positionSec,
          paused: this.paused,
        }
      : null;
    return { nowPlaying, queue: this.ordered() };
  }

  history(limit = 20): QueueEntryView[] {
    const rows = this.db
      .prepare("SELECT * FROM queue WHERE status = 'played' ORDER BY finished_at DESC LIMIT ?")
      .all(limit) as unknown as QueueRow[];
    return rows.map((row) => this.view(row));
  }

  /** Returns recently played/started-and-removed track IDs (most recent first) for Auto-DJ deduplication. */
  recentTrackIds(limit = 30): string[] {
    const rows = this.db
      .prepare(
        `SELECT track_id FROM queue
         WHERE status = 'played' OR (status = 'removed' AND started_at IS NOT NULL)
         ORDER BY finished_at DESC, id DESC
         LIMIT ?`,
      )
      .all(limit) as unknown as { track_id: string }[];
    return rows.map((r) => r.track_id);
  }

  private ordered(): QueueEntryView[] {
    const rows = this.db
      .prepare("SELECT * FROM queue WHERE status = 'queued'")
      .all() as unknown as QueueRow[];
    return orderQueue(rows.map((row) => this.view(row)));
  }

  private currentRow(): QueueRow | undefined {
    return this.db.prepare("SELECT * FROM queue WHERE status = 'playing' LIMIT 1").get() as QueueRow | undefined;
  }

  private finishCurrent(status: 'played' | 'removed'): void {
    this.db
      .prepare("UPDATE queue SET status = ?, finished_at = ? WHERE status = 'playing'")
      .run(status, Date.now());
    this.positionSec = 0;
    this.paused = false;
  }

  private getRow(id: number): QueueRow | undefined {
    return this.db.prepare('SELECT * FROM queue WHERE id = ?').get(id) as QueueRow | undefined;
  }

  private setStatus(id: number, status: QueueStatus): void {
    this.db.prepare('UPDATE queue SET status = ?, finished_at = ? WHERE id = ?').run(status, Date.now(), id);
  }

  private addVote(queueId: number, voterId: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO votes (queue_id, voter_id, created_at) VALUES (?, ?, ?)')
      .run(queueId, voterId, Date.now());
  }

  private view(row: QueueRow): QueueEntryView {
    const voters = (
      this.db.prepare('SELECT voter_id FROM votes WHERE queue_id = ?').all(row.id) as unknown as { voter_id: string }[]
    ).map((v) => v.voter_id);
    const item: QueueItem = {
      id: row.id,
      trackId: row.track_id,
      requesterId: row.requester_id,
      requesterName: row.requester_name,
      addedAt: row.added_at,
      status: row.status,
      votes: voters.length,
      voters,
    };
    return { ...item, track: this.tracks.get(row.track_id)! };
  }
}
