import { Injectable } from '@nestjs/common';
import { EventBus } from '../events/event-bus.js';
import type { Tx } from './prisma.service.js';

/**
 * Hands out the per-space change sequence used for sync.
 *
 * MySQL has no sequences, so each space row carries a counter. Every write transaction calls
 * `next()` first: the UPDATE takes a row lock on the space that is held until commit, so one
 * space's write transactions run one after another and their seq values become visible in order.
 * That is what lets a client safely ask for "everything with seq > cursor" without missing rows.
 * Rows changed in the same transaction share the same seq. Different spaces never block each other.
 *
 * For a personal space the number is mirrored to `User.changeSeq` so clients that still sync with
 * a single `since` cursor keep working (the mirror goes away in phase 17).
 */
@Injectable()
export class ChangeSeqService {
  constructor(private readonly bus: EventBus) {}

  async next(tx: Tx, spaceId: string): Promise<bigint> {
    const row = await tx.space.update({
      where: { id: spaceId },
      data: { changeSeq: { increment: 1 } },
      select: { changeSeq: true, kind: true, userId: true },
    });
    if (row.kind === 'personal' && row.userId) {
      await tx.user.update({ where: { id: row.userId }, data: { changeSeq: row.changeSeq } });
    }
    // Whoever has the space open pulls now instead of waiting for the timer.
    this.bus.publishAfterCommit(tx, 'space.changed', { spaceId, seq: row.changeSeq.toString(10) });
    return row.changeSeq;
  }
}
