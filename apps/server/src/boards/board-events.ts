import { Injectable } from '@nestjs/common';
import { BOARD_EVENTS } from '@os-planner/shared';
import { EventBus } from '../events/event-bus.js';
import type { Tx } from '../prisma/prisma.service.js';

type BoardEventName = (typeof BOARD_EVENTS)[keyof typeof BOARD_EVENTS];

/**
 * What the boards feature announces. The row itself goes to the room of its board (`board:<id>`, which only people who may see
 * the board can be in); the room of the space (`space:<id>`, everybody who sees the space) hears only that something changed
 * and where, never what, so a board that is hidden from somebody stays hidden.
 */
@Injectable()
export class BoardEvents {
  constructor(private readonly bus: EventBus) {}

  /** Announces after the transaction commits. `id` is the row that changed (a task, a column, a label or a comment). */
  emit(tx: Tx, name: BoardEventName, args: { spaceId: string; boardId: string | null; id: string; payload: unknown }): void {
    const { spaceId, boardId, id, payload } = args;
    if (boardId) this.bus.publishAfterCommit(tx, 'room.event', { rooms: [`board:${boardId}`], name, payload });
    this.bus.publishAfterCommit(tx, 'room.event', { rooms: [`space:${spaceId}`], name, payload: { spaceId, boardId, id } });
  }
}
