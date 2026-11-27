import { Module, type OnModuleInit } from '@nestjs/common';
import { EventBus } from '../events/event-bus.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ChangeSeqService } from '../prisma/change-seq.service.js';
import { CalendarController } from './calendar.controller.js';
import { CalendarEvents } from './calendar-events.js';
import { CalendarViews } from './calendar-views.service.js';
import { EventAccess } from './event-access.js';
import { EventsService } from './events.service.js';
import { ExternalReader } from './external-reader.js';
import { IcsExporter } from './ics-export.js';
import { RemindersService } from './reminders.service.js';

/** What changes who holds a role of a team, or what a role may do: events that name a role are read again by the devices concerned. */
const ROLE_ACTIONS = new Set([
  'role.assign',
  'role.unassign',
  'role.update',
  'role.delete',
  'member.remove',
  'member.ban',
  'overwrite.set',
  'overwrite.clear',
  'project.member.add',
  'project.member.remove',
]);

/** Calendar and meetings: events with recurrence, attendees and answers, reminders, and the expanded calendar. Sync reads events through the tree module. */
@Module({
  imports: [NotificationsModule],
  controllers: [CalendarController],
  providers: [CalendarEvents, EventAccess, EventsService, CalendarViews, RemindersService, ExternalReader, IcsExporter],
  exports: [EventsService, CalendarViews, EventAccess, IcsExporter, ExternalReader],
})
export class CalendarModule implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly seq: ChangeSeqService,
  ) {}

  /**
   * An event that names a role belongs to whoever holds the role, so when roles or memberships of a team change, the events that name
   * a role get a new sequence number: devices read them again, and the ones that no longer see them drop them.
   */
  onModuleInit(): void {
    this.bus.subscribe('team.audited', async ({ teamId, action }) => {
      if (!ROLE_ACTIONS.has(action)) return;
      const events = await this.prisma.event.findMany({
        where: {
          deletedAt: null,
          attendees: { some: { kind: 'role' } },
          space: { OR: [{ teamId }, { project: { teamId } }] },
        },
        select: { id: true, spaceId: true },
      });
      const bySpace = new Map<string, string[]>();
      for (const e of events)
        (bySpace.get(e.spaceId) ?? bySpace.set(e.spaceId, []).get(e.spaceId)!).push(e.id);
      for (const [spaceId, ids] of bySpace) {
        await this.prisma.fresh(async (tx) => {
          const seq = await this.seq.next(tx, spaceId);
          await tx.event.updateMany({ where: { id: { in: ids } }, data: { seq } });
        });
      }
    });
  }
}
