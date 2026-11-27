import { Injectable } from '@nestjs/common';
import {
  hasPermission,
  Permission,
  type CalendarDto,
  type CalendarItemDto,
  type CalendarPeopleDto,
  type CalendarPermissionsDto,
  type CalendarSettingsDto,
  type EventKind,
  type RsvpStatus,
  type UpdateCalendarSettingsInput,
} from '@os-planner/shared';
import {
  CALENDAR_LIMITS,
  expandEvent,
  isValidTimeZone,
  type CalendarQuery,
} from '@os-planner/shared/calendar';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PermissionService } from '../spaces/permission.service.js';
import { invalid } from '../tree/tree.error.js';
import { ExternalReader } from './external-reader.js';
import {
  EVENT_INCLUDE,
  namesNeeded,
  namesOf,
  toEventDto,
  toExceptionDto,
  type EventRow,
} from './event-views.js';

export const DEFAULT_REMINDERS = [10];

const DAY = 86_400_000;

/** Reading the calendar: the expanded entries of a window, who can be named on an event, and the person's own settings. */
@Injectable()
export class CalendarViews {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionService,
    private readonly external: ExternalReader,
  ) {}

  async permissions(userId: string): Promise<CalendarPermissionsDto> {
    return { spaces: await this.perms.calendarPermissions(userId) };
  }

  // ---------------------------------------------------------------- the calendar

  /**
   * Everything on the person's calendar between `from` and `to`: events they made or attend, events of spaces that show theirs to
   * everybody, and tasks assigned to them that have a date. A repeating event is expanded here (nothing is stored per occurrence).
   * Only spaces whose calendar (and, for tasks, boards) the person can see at this moment count.
   */
  async calendar(userId: string, q: CalendarQuery): Promise<CalendarDto> {
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (!(to > from)) throw invalid('window_invalid');
    if (to.getTime() - from.getTime() > CALENDAR_LIMITS.windowDays * DAY)
      throw invalid('window_too_large');
    const include = new Set(q.include);
    const items: CalendarItemDto[] = [];
    let truncated = false;
    const room = () => CALENDAR_LIMITS.itemsPerRequest - items.length;

    if (include.has('meetings') || include.has('events')) {
      const kinds = [
        ...(include.has('meetings') ? ['meeting'] : []),
        ...(include.has('events') ? ['event'] : []),
      ];
      const { rows, viewer } = await this.visibleEvents(userId, {
        spaces: q.spaces,
        kinds,
        from,
        to,
        take: CALENDAR_LIMITS.itemsPerRequest,
      });
      const names = await namesOf(this.prisma, namesNeeded(rows, viewer));
      for (const row of rows) {
        const dto = toEventDto(row, viewer, names);
        if (dto.me?.status === 'declined' && q.declined !== 'true') continue;
        for (const o of expandEvent(
          { ...dto, exceptions: row.exceptions.map(toExceptionDto) },
          from.getTime(),
          to.getTime(),
          room() + 1,
        )) {
          if (room() <= 0) {
            truncated = true;
            break;
          }
          items.push({
            source: 'event',
            id: dto.id,
            key: `${dto.id}@${o.originalStart}`,
            spaceId: dto.spaceId,
            title: o.override?.title ?? dto.title,
            start: o.start,
            end: o.end,
            allDay: dto.allDay,
            originalStart: o.originalStart,
            recurring: !!dto.rrule,
            kind: dto.kind as EventKind,
            location: o.override?.location !== undefined ? o.override.location : dto.location,
            rsvp: (dto.me?.status ?? null) as RsvpStatus | null,
          });
        }
        if (truncated) break;
      }
      this.flagConflicts(items);
    }

    if (include.has('tasks') && room() > 0) {
      const boards = await this.perms.boardSpaces(userId);
      const wanted = [...boards.keys()].filter((id) => !q.spaces || q.spaces.includes(id));
      if (wanted.length) {
        const hidden: string[] = [];
        for (const id of wanted) hidden.push(...(await this.perms.hiddenBoards(userId, id)));
        const tasks = await this.prisma.task.findMany({
          where: {
            spaceId: { in: wanted },
            deletedAt: null,
            assignees: { some: { userId } },
            board: { deletedAt: null, ...(hidden.length ? { id: { notIn: hidden } } : {}) },
            OR: [
              { dueAt: { gte: from, lt: to } },
              { startAt: { gte: from, lt: to } },
              { AND: [{ startAt: { lt: to } }, { dueAt: { gte: from } }] },
            ],
          },
          select: {
            id: true,
            boardId: true,
            spaceId: true,
            title: true,
            startAt: true,
            dueAt: true,
            allDay: true,
            completedAt: true,
          },
          take: room() + 1,
        });
        for (const t of tasks) {
          if (room() <= 0) {
            truncated = true;
            break;
          }
          const start = t.startAt ?? t.dueAt!;
          let end = t.dueAt ?? t.startAt!;
          if (t.allDay) end = new Date(end.getTime() + DAY);
          items.push({
            source: 'task',
            id: t.id,
            key: t.id,
            spaceId: t.spaceId,
            title: t.title,
            start: start.toISOString(),
            end: end.toISOString(),
            allDay: t.allDay,
            completed: !!t.completedAt,
            boardId: t.boardId,
          });
        }
      }
    }

    // The calendars the person follows are theirs alone: they ignore the space filter, which names spaces.
    if (include.has('external') && !q.spaces && room() > 0) {
      const ext = await this.external.items(userId, from, to, room());
      items.push(...ext.items);
      if (ext.truncated) truncated = true;
    }

    items.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.key < b.key ? -1 : 1));
    return { from: from.toISOString(), to: to.toISOString(), items, truncated };
  }

  /**
   * The events the person may see in the spaces whose calendar they can see, that touch [from, to): as rows, repeating ones whole (the
   * caller expands them). What the calendar, the feeds and the export all start from, so they can never disagree about who sees what.
   */
  async visibleEvents(
    userId: string,
    o: { spaces?: readonly string[]; kinds: readonly string[]; from: Date; to: Date; take: number },
  ): Promise<{ rows: EventRow[]; viewer: { userId: string; held: ReadonlySet<string> } }> {
    const spaces = await this.perms.calendarSpaces(userId);
    const wanted = [...spaces.keys()].filter((id) => !o.spaces || o.spaces.includes(id));
    const held = await this.perms.heldRoleIds(userId);
    const managers = wanted.filter((id) => {
      const a = spaces.get(id)!;
      return a.space.kind === 'personal' || hasPermission(a.perms, Permission.MANAGE_MEETINGS);
    });
    const others = wanted.filter((id) => !managers.includes(id));
    const seeing: Prisma.EventWhereInput[] = [
      { visibility: 'space' },
      { ownerId: userId },
      { attendees: { some: { kind: 'user', subjectId: userId } } },
    ];
    if (held.size)
      seeing.push({ attendees: { some: { kind: 'role', subjectId: { in: [...held] } } } });
    const rows: EventRow[] =
      wanted.length && o.kinds.length
        ? await this.prisma.event.findMany({
            where: {
              deletedAt: null,
              kind: { in: [...o.kinds] },
              startAt: { lt: o.to },
              AND: [
                {
                  OR: [
                    { rrule: null, endAt: { gt: o.from } },
                    {
                      rrule: { not: null },
                      OR: [{ rruleUntil: null }, { rruleUntil: { gte: o.from } }],
                    },
                  ],
                },
                {
                  OR: [
                    ...(managers.length ? [{ spaceId: { in: managers } }] : []),
                    ...(others.length ? [{ spaceId: { in: others }, OR: seeing }] : []),
                  ],
                },
              ],
            },
            include: EVENT_INCLUDE,
            orderBy: { id: 'asc' },
            take: o.take,
          })
        : [];
    return { rows, viewer: { userId, held } };
  }

  /** Marks the timed entries of the person that overlap another one they have not declined. */
  private flagConflicts(items: CalendarItemDto[]): void {
    const live = items
      .filter((i) => i.source === 'event' && !i.allDay && i.rsvp !== 'declined')
      .sort((a, b) => (a.start < b.start ? -1 : 1));
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length && live[j]!.start < live[i]!.end; j++) {
        live[i]!.conflict = true;
        live[j]!.conflict = true;
      }
    }
  }

  // ---------------------------------------------------------------- who can be named

  /** The people and roles that can be put on an event in a space. Without ADD_TO_MEMBER_CALENDARS only people who opened their calendar. */
  async people(userId: string, spaceId: string): Promise<CalendarPeopleDto> {
    const space = await this.perms.requireCalendarSpace(userId, spaceId);
    if (space.space.kind === 'personal' || !space.teamId) return { users: [], roles: [] };
    const mayAdd = hasPermission(space.perms, Permission.ADD_TO_MEMBER_CALENDARS);
    const members = await this.prisma.teamMember.findMany({
      where: { teamId: space.teamId },
      select: { userId: true, nickname: true, user: { select: { displayName: true } } },
      take: 5000,
    });
    const viewers = await this.perms.spaceViewers(
      spaceId,
      members.map((m) => m.userId),
      Permission.VIEW_CALENDAR,
    );
    const open = new Set(
      (
        await this.prisma.userCalendarSetting.findMany({
          where: { openInvites: true, userId: { in: [...viewers] } },
          select: { userId: true },
        })
      ).map((s) => s.userId),
    );
    const users = members
      .filter((m) => m.userId !== userId && viewers.has(m.userId) && (mayAdd || open.has(m.userId)))
      .map((m) => ({
        userId: m.userId,
        displayName: m.nickname || m.user.displayName,
        open: open.has(m.userId),
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    if (!mayAdd) return { users, roles: [] };
    const roles = await this.prisma.role.findMany({
      where: { teamId: space.teamId, isEveryone: false },
      select: { id: true, name: true, projectId: true },
    });
    const counts = await this.prisma.memberRole.groupBy({
      by: ['roleId'],
      where: { roleId: { in: roles.map((r) => r.id) } },
      _count: { _all: true },
    });
    const count = new Map(counts.map((c) => [c.roleId, c._count._all]));
    return {
      users,
      roles: roles
        .map((r) => ({ id: r.id, name: r.name, memberCount: count.get(r.id) ?? 0 }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  // ---------------------------------------------------------------- settings

  async settings(userId: string): Promise<CalendarSettingsDto> {
    const row = await this.prisma.userCalendarSetting.findUnique({ where: { userId } });
    return {
      defaultTz: row?.defaultTz ? row.defaultTz : null,
      weekStart: (row?.weekStart ?? 1) as 0 | 1 | 6,
      defaultReminders: row ? (row.defaultReminders as number[]) : DEFAULT_REMINDERS,
      hiddenSpaces: row ? (row.hiddenSpaces as string[]) : [],
      openInvites: row?.openInvites ?? false,
      emailReminders: row?.emailReminders ?? false,
    };
  }

  async updateSettings(
    userId: string,
    patch: UpdateCalendarSettingsInput,
  ): Promise<CalendarSettingsDto> {
    if (patch.defaultTz && !isValidTimeZone(patch.defaultTz)) throw invalid('invalid_timezone');
    const now = await this.settings(userId);
    const next = { ...now, ...patch };
    const data = {
      defaultTz: next.defaultTz ?? '',
      weekStart: next.weekStart,
      defaultReminders: [...new Set(next.defaultReminders)].sort((a, b) => a - b),
      hiddenSpaces: next.hiddenSpaces,
      openInvites: next.openInvites,
      emailReminders: next.emailReminders,
    };
    await this.prisma.userCalendarSetting.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    return this.settings(userId);
  }

  /** A person's settings for a batch of people (the reminders worker). */
  async settingsOf(userIds: readonly string[]): Promise<Map<string, CalendarSettingsDto>> {
    const rows = await this.prisma.userCalendarSetting.findMany({
      where: { userId: { in: [...userIds] } },
    });
    const out = new Map<string, CalendarSettingsDto>();
    for (const id of userIds) {
      const row = rows.find((r) => r.userId === id);
      out.set(id, {
        defaultTz: row?.defaultTz ? row.defaultTz : null,
        weekStart: (row?.weekStart ?? 1) as 0 | 1 | 6,
        defaultReminders: row ? (row.defaultReminders as number[]) : DEFAULT_REMINDERS,
        hiddenSpaces: row ? (row.hiddenSpaces as string[]) : [],
        openInvites: row?.openInvites ?? false,
        emailReminders: row?.emailReminders ?? false,
      });
    }
    return out;
  }
}
