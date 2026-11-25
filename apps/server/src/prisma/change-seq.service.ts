import { Injectable } from '@nestjs/common';
import type { Tx } from './prisma.service.js';

/**
 * Hands out the per-user change sequence used for sync.
 *
 * MySQL has no sequences, so each user row carries a counter. Every write transaction calls
 * `next()` first: the UPDATE takes a row lock on the user that is held until commit, so one
 * user's write transactions run one after another and their seq values become visible in order.
 * That is what lets a client safely ask for "everything with seq > cursor" without missing rows.
 * Rows changed in the same transaction share the same seq. Different users never block each other.
 */
@Injectable()
export class ChangeSeqService {
  async next(tx: Tx, userId: string): Promise<bigint> {
    const row = await tx.user.update({
      where: { id: userId },
      data: { changeSeq: { increment: 1 } },
      select: { changeSeq: true },
    });
    return row.changeSeq;
  }
}
