import { Injectable } from '@nestjs/common';
import { CALENDAR_EVENTS } from '@os-planner/shared';
import { EventBus } from '../events/event-bus.js';
import type { Tx } from '../prisma/prisma.service.js';

type CalendarEventName = (typeof CALENDAR_EVENTS)[keyof typeof CALENDAR_EVENTS];

/**
 * What the calendar announces. An event may be for some people only, so the room of the space (everybody who sees it) hears just
 * where and what changed (`{spaceId, id}`, enough to pull), never the event itself; the people named on it are also told in their
 * own rooms.
 */
@Injectable()
export class CalendarEvents {
  constructor(private readonly bus: EventBus) {}

  /** Announces after the transaction commits. */
  emit(
    tx: Tx,
    name: CalendarEventName,
    args: { spaceId: string; id: string; userIds?: readonly string[] },
  ): void {
    const payload = { spaceId: args.spaceId, id: args.id };
    this.bus.publishAfterCommit(tx, 'room.event', {
      rooms: [`space:${args.spaceId}`],
      name,
      payload,
    });
    const users = [...new Set(args.userIds ?? [])].slice(0, 600);
    if (users.length)
      this.bus.publishAfterCommit(tx, 'room.event', {
        rooms: users.map((u) => `user:${u}`),
        name,
        payload,
      });
  }
}
