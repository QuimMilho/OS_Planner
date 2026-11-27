import { Injectable } from '@nestjs/common';
import type { CalendarItemDto, EventExceptionDto } from '@os-planner/shared';
import { expandEvent } from '@os-planner/shared/calendar';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * The events of the calendars a person follows (phase 14), as entries of their calendar. They are the person's own and read only:
 * nobody else ever sees them, and they carry no space, no answers and no reminders.
 */
@Injectable()
export class ExternalReader {
  constructor(private readonly prisma: PrismaService) {}

  async items(
    userId: string,
    from: Date,
    to: Date,
    limit: number,
    calendarId?: string,
  ): Promise<{ items: CalendarItemDto[]; truncated: boolean }> {
    if (limit <= 0) return { items: [], truncated: true };
    const rows = await this.prisma.externalEvent.findMany({
      where: {
        calendar: { userId, enabled: true, ...(calendarId ? { id: calendarId } : {}) },
        startAt: { lt: to },
        OR: [
          { rrule: null, endAt: { gt: from } },
          { rrule: { not: null }, OR: [{ rruleUntil: null }, { rruleUntil: { gte: from } }] },
        ],
      },
      include: { calendar: { select: { id: true, name: true, color: true } } },
      orderBy: { id: 'asc' },
      take: 5000,
    });
    const items: CalendarItemDto[] = [];
    let truncated = false;
    for (const row of rows) {
      const expanded = expandEvent(
        {
          startAt: row.startAt.toISOString(),
          endAt: row.endAt.toISOString(),
          allDay: row.allDay,
          timezone: row.timezone,
          rrule: row.rrule,
          exceptions: (row.exdates as EventExceptionDto[] | null) ?? [],
        },
        from.getTime(),
        to.getTime(),
        limit - items.length + 1,
      );
      for (const o of expanded) {
        if (items.length >= limit) {
          truncated = true;
          break;
        }
        items.push({
          source: 'external',
          id: row.id,
          key: `ext:${row.id}@${o.originalStart}`,
          spaceId: '',
          title: o.override?.title ?? row.title,
          start: o.start,
          end: o.end,
          allDay: row.allDay,
          originalStart: o.originalStart,
          recurring: !!row.rrule,
          location: o.override?.location !== undefined ? o.override.location : row.location,
          calendarId: row.calendar.id,
          color: row.calendar.color,
          sourceName: row.calendar.name,
          url: row.url,
          note: (o.override?.description ?? row.description).slice(0, 500),
        });
      }
      if (truncated) break;
    }
    return { items, truncated };
  }
}
