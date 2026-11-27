import { Inject, Injectable } from '@nestjs/common';
import type { RsvpStatus } from '@os-planner/shared';
import { ICS_LIMITS, buildIcs, type IcsOutEvent } from '@os-planner/shared/ics';
import { ENV, type Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PermissionService } from '../spaces/permission.service.js';
import { CalendarViews, DEFAULT_REMINDERS } from './calendar-views.service.js';
import { EventAccess } from './event-access.js';
import { namesNeeded, namesOf, toEventDto, toExceptionDto, type EventRow } from './event-views.js';

const DAY = 86_400_000;
const FAR = Date.UTC(2199, 0, 1);

const PARTSTAT: Record<RsvpStatus, 'ACCEPTED' | 'DECLINED' | 'TENTATIVE' | 'NEEDS-ACTION'> = {
  accepted: 'ACCEPTED',
  declined: 'DECLINED',
  tentative: 'TENTATIVE',
  invited: 'NEEDS-ACTION',
};

export interface ExportSelection {
  /** Spaces to take from; left out: every one the person can see. */
  spaces?: readonly string[];
  meetings: boolean;
  events: boolean;
  tasks: boolean;
  declined: boolean;
  /** Events that end after this and start before `to`. */
  from: Date;
  to: Date;
}

/**
 * Turns what a person sees in their calendar into calendar files: the private feed, the export of a range and of one event. It reads
 * through `CalendarViews`, so what is in a file is exactly what the person's own calendar shows at that moment.
 */
@Injectable()
export class IcsExporter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly views: CalendarViews,
    private readonly access: EventAccess,
    private readonly perms: PermissionService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** The name events are identified with in files (`<id>@host`). */
  get host(): string {
    return new URL(this.env.APP_URL).hostname;
  }

  /** Events (and, when asked, tasks with dates) of a person as entries of a file, sorted by start. */
  async entries(
    userId: string,
    sel: ExportSelection,
  ): Promise<{ events: IcsOutEvent[]; truncated: boolean }> {
    const out: IcsOutEvent[] = [];
    let truncated = false;
    const kinds = [...(sel.meetings ? ['meeting'] : []), ...(sel.events ? ['event'] : [])];
    if (kinds.length) {
      const { rows, viewer } = await this.views.visibleEvents(userId, {
        spaces: sel.spaces,
        kinds,
        from: sel.from,
        to: sel.to,
        take: ICS_LIMITS.feedItems + 1,
      });
      if (rows.length > ICS_LIMITS.feedItems) truncated = true;
      const names = await namesOf(this.prisma, namesNeeded(rows, viewer));
      const me = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { displayName: true, email: true },
      });
      const settings = await this.views.settings(userId);
      const own = new Map(
        (
          await this.prisma.eventReminder.findMany({
            where: { userId, eventId: { in: rows.map((r) => r.id) } },
            select: { eventId: true, minutes: true },
          })
        ).map((r) => [r.eventId, r.minutes as number[]]),
      );
      for (const row of rows.slice(0, ICS_LIMITS.feedItems)) {
        const dto = toEventDto(row, viewer, names);
        if (dto.me?.status === 'declined' && !sel.declined) continue;
        out.push(
          this.entry(
            row,
            dto.me?.status ?? null,
            dto.ownerName,
            me,
            own.get(row.id) ?? settings.defaultReminders ?? DEFAULT_REMINDERS,
          ),
        );
      }
    }
    if (sel.tasks && out.length < ICS_LIMITS.feedItems) {
      const cal = await this.views.calendar(userId, {
        from: sel.from.toISOString(),
        to: new Date(Math.min(sel.to.getTime(), sel.from.getTime() + 731 * DAY)).toISOString(),
        spaces: sel.spaces ? [...sel.spaces] : undefined,
        include: ['tasks'],
        declined: 'false',
      });
      if (cal.truncated) truncated = true;
      for (const t of cal.items) {
        if (t.source !== 'task') continue;
        out.push({
          uid: `task-${t.id}@${this.host}`,
          title: t.completed ? `✓ ${t.title}` : t.title,
          description: '',
          location: null,
          startAt: t.start,
          endAt: t.end,
          allDay: t.allDay,
          timezone: 'UTC',
          rrule: null,
          alarms: [],
        });
      }
    }
    out.sort((a, b) =>
      a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : a.uid < b.uid ? -1 : 1,
    );
    return { events: out, truncated };
  }

  private entry(
    row: EventRow,
    status: RsvpStatus | null,
    owner: string | null,
    me: { displayName: string; email: string } | null,
    alarms: readonly number[],
  ): IcsOutEvent {
    return {
      uid: `${row.id}@${this.host}`,
      title: row.title,
      description: row.description,
      location: row.location,
      url: row.videoUrl,
      startAt: row.startAt.toISOString(),
      endAt: row.endAt.toISOString(),
      allDay: row.allDay,
      timezone: row.timezone,
      rrule: row.rrule,
      exceptions: row.exceptions.map(toExceptionDto),
      status: status === 'tentative' ? 'tentative' : 'confirmed',
      updatedAt: row.updatedAt.toISOString(),
      organizer: owner,
      attendee:
        status && me ? { name: me.displayName, email: me.email, partstat: PARTSTAT[status] } : null,
      alarms: [...alarms],
    };
  }

  /** The text of a calendar file for entries. */
  render(
    name: string,
    events: readonly IcsOutEvent[],
    refreshMinutes?: number,
    now?: string,
  ): string {
    return buildIcs({
      name,
      host: this.host,
      events,
      ...(refreshMinutes ? { refreshMinutes } : {}),
      ...(now ? { now } : {}),
    });
  }

  /** The window a feed covers: what ended in the last months, and everything to come. */
  feedWindow(now = new Date()): { from: Date; to: Date } {
    return { from: new Date(now.getTime() - ICS_LIMITS.feedPastDays * DAY), to: new Date(FAR) };
  }

  /** One event the person can see, as a file (404 for one they cannot). */
  async single(userId: string, id: string): Promise<{ name: string; text: string }> {
    const ctx = this.access.live(await this.access.forUser(userId, id));
    const row = ctx.event;
    const viewer = { userId, held: await this.perms.heldRoleIds(userId) };
    const names = await namesOf(this.prisma, namesNeeded([row], viewer));
    const dto = toEventDto(row, viewer, names);
    const me = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { displayName: true, email: true },
    });
    const mine = await this.prisma.eventReminder.findUnique({
      where: { eventId_userId: { eventId: id, userId } },
    });
    const settings = await this.views.settings(userId);
    const alarms = mine ? (mine.minutes as number[]) : settings.defaultReminders;
    return {
      name: row.title,
      text: this.render(row.title, [
        this.entry(row, dto.me?.status ?? null, dto.ownerName, me, alarms),
      ]),
    };
  }
}
