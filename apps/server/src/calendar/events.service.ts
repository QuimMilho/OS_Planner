import { Injectable } from '@nestjs/common';
import {
  CALENDAR_EVENTS,
  hasPermission,
  Permission,
  type AddAttendeesInput,
  type AttendeeDto,
  type AttendeeInput,
  type CancelEventInput,
  type CreateEventInput,
  type DuplicateEventInput,
  type EventDetailDto,
  type EventDto,
  type EventOverrideDto,
  type RemindersInput,
  type RsvpAnswer,
  type RsvpInput,
  type UpdateEventInput,
} from '@os-planner/shared';
import {
  CALENDAR_LIMITS,
  expandRule,
  formatRRule,
  lastOccurrence,
  normalizeTiming,
  ruleOf,
  updateEventSchema,
  type RRule,
  type Timing,
} from '@os-planner/shared/calendar';
import { exceptionsOf, type IcsSeries } from '@os-planner/shared/ics';
import { newId } from '../common/crypto.js';
import { guardDelete, guardUpdate } from '../common/merge-scope.js';
import { Prisma } from '../generated/prisma/client.js';
import { NotificationService } from '../notifications/notification.service.js';
import { ChangeSeqService } from '../prisma/change-seq.service.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { QuotaService } from '../quota/quota.service.js';
import { PermissionService, type SpaceAccess } from '../spaces/permission.service.js';
import { forbidden, idTaken, invalid, notFound } from '../tree/tree.error.js';
import { CalendarEvents } from './calendar-events.js';
import { EventAccess, type EventContext } from './event-access.js';
import {
  EVENT_INCLUDE,
  eventBytes,
  myRow,
  namesNeeded,
  namesOf,
  toEventDto,
  type EventRow,
} from './event-views.js';

/** The fields an exception of one occurrence may change. */
const THIS_FIELDS = new Set(['title', 'description', 'location', 'videoUrl', 'startAt', 'endAt']);
/** The keys of an event change that make up its timing (one merge field: they stay consistent with each other). */
const TIMING_KEYS = ['startAt', 'endAt', 'allDay', 'timezone', 'rrule'];
/** The fields that change what a person is told about ("the meeting moved"). */
const NOTABLE = new Set([
  'title',
  'startAt',
  'endAt',
  'allDay',
  'timezone',
  'rrule',
  'location',
  'videoUrl',
]);

type Body = ReturnType<typeof updateEventSchema.parse>;

const sameInstant = (a: Date, iso: string) => a.getTime() === new Date(iso).getTime();

/** Events: make, change, cancel and answer them; name people on them. Reading for the calendar and sync is `CalendarViews`. */
@Injectable()
export class EventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seq: ChangeSeqService,
    private readonly perms: PermissionService,
    private readonly quota: QuotaService,
    private readonly access: EventAccess,
    private readonly events: CalendarEvents,
    private readonly notifications: NotificationService,
  ) {}

  // ---------------------------------------------------------------- reading

  /** The event as this person sees it. */
  async dtoFor(userId: string, row: EventRow): Promise<EventDto> {
    const viewer = { userId, held: await this.perms.heldRoleIds(userId) };
    return toEventDto(row, viewer, await namesOf(this.prisma, namesNeeded([row], viewer)));
  }

  /** `GET /api/events/:id`: the event, who is on it, and what the person may do. */
  async detail(userId: string, id: string): Promise<EventDetailDto> {
    const ctx = this.access.live(await this.access.forUser(userId, id));
    const { event } = ctx;
    const roleIds = event.attendees.filter((a) => a.kind === 'role').map((a) => a.subjectId);
    const roles = roleIds.length
      ? await this.prisma.role.findMany({
          where: { id: { in: roleIds } },
          select: { id: true, name: true },
        })
      : [];
    const roleName = new Map(roles.map((r) => [r.id, r.name]));
    const memberCount = new Map<string, number>();
    for (const roleId of roleIds) {
      const members = (
        await this.prisma.memberRole.findMany({
          where: { roleId },
          select: { userId: true },
          take: 5000,
        })
      ).map((m) => m.userId);
      memberCount.set(
        roleId,
        (await this.perms.spaceViewers(event.spaceId, members, Permission.VIEW_CALENDAR)).size,
      );
    }
    const names = await namesOf(this.prisma, [
      event.ownerId,
      ...event.attendees.flatMap((a) => [a.kind === 'user' ? a.subjectId : null, a.addedBy]),
    ]);
    const attendees: AttendeeDto[] = event.attendees
      .map((a) => ({
        kind: a.kind as 'user' | 'role',
        subjectId: a.subjectId,
        name: (a.kind === 'user' ? names.get(a.subjectId) : roleName.get(a.subjectId)) ?? '',
        status: a.status as AttendeeDto['status'],
        respondedAt: a.respondedAt?.toISOString() ?? null,
        addedBy: a.addedBy,
        addedByName: a.addedBy ? (names.get(a.addedBy) ?? null) : null,
        optional: a.optional,
        ...(a.kind === 'role' ? { memberCount: memberCount.get(a.subjectId) ?? 0 } : {}),
      }))
      .sort((x, y) =>
        x.kind === y.kind ? x.name.localeCompare(y.name) : x.kind === 'user' ? -1 : 1,
      );
    const mine = await this.prisma.eventReminder.findUnique({
      where: { eventId_userId: { eventId: id, userId } },
    });
    const space = await this.prisma.space.findUnique({
      where: { id: event.spaceId },
      select: { kind: true, team: { select: { name: true } }, project: { select: { name: true } } },
    });
    return {
      event: await this.dtoFor(userId, event),
      attendees,
      canEdit: ctx.canEdit,
      canInvite: ctx.canInvite,
      reminders: mine ? (mine.minutes as number[]) : null,
      spaceName:
        space?.kind === 'personal' ? '' : (space?.team?.name ?? space?.project?.name ?? ''),
    };
  }

  // ---------------------------------------------------------------- making

  /** Idempotent: a repeat with the same id returns the event that exists. */
  async create(userId: string, input: CreateEventInput): Promise<EventDto> {
    const space = await this.perms.requireCalendarSpace(
      userId,
      input.spaceId,
      Permission.CREATE_MEETINGS,
    );
    const spaceId = space.space.id;
    const timing = this.timing({
      startAt: input.startAt,
      endAt: input.endAt,
      allDay: input.allDay ?? false,
      timezone: input.timezone ?? 'UTC',
      rrule: input.rrule ?? null,
    });
    const people = await this.checkAttendees(userId, space, input.attendees ?? []);
    if (input.linkedChannelId) await this.checkChannel(spaceId, input.linkedChannelId);
    const title = input.title.trim();
    const description = input.description ?? '';
    const bytes = eventBytes({
      title,
      description,
      location: input.location ?? null,
      videoUrl: input.videoUrl ?? null,
      rrule: timing.value.rrule,
    });

    const row = await this.prisma.fresh(async (tx) => {
      const seq = await this.seq.next(tx, spaceId);
      const existing = await tx.event.findUnique({
        where: { id: input.id },
        include: EVENT_INCLUDE,
      });
      if (existing) {
        if (existing.spaceId !== spaceId || existing.ownerId !== userId) throw idTaken();
        return existing;
      }
      if (
        (await tx.event.count({ where: { spaceId, deletedAt: null } })) >=
        CALENDAR_LIMITS.eventsPerSpace
      )
        throw invalid('too_many_events');
      await this.quota.chargeSpace(tx, spaceId, bytes);
      const created = await tx.event.create({
        data: {
          id: input.id,
          spaceId,
          ownerId: userId,
          kind: input.kind ?? 'meeting',
          title,
          description,
          location: input.location ?? null,
          videoUrl: input.videoUrl ?? null,
          linkedChannelId: input.linkedChannelId ?? null,
          startAt: new Date(timing.value.startAt),
          endAt: new Date(timing.value.endAt),
          allDay: timing.value.allDay,
          timezone: timing.value.timezone,
          rrule: timing.value.rrule,
          rruleUntil: timing.value.rrule ? timing.lastEnd : null,
          visibility: input.visibility ?? 'attendees',
          sizeBytes: bytes,
          seq,
          attendees: {
            create: [
              {
                kind: 'user',
                subjectId: userId,
                status: 'accepted',
                respondedAt: new Date(),
                addedBy: null,
              },
              ...people.map((p) => ({
                kind: p.kind,
                subjectId: p.subjectId,
                status: 'invited',
                addedBy: userId,
                optional: p.optional ?? false,
              })),
            ],
          },
        },
        include: EVENT_INCLUDE,
      });
      if (input.reminders)
        await tx.eventReminder.create({
          data: { eventId: created.id, userId, minutes: input.reminders },
        });
      const audience = await this.audience(tx, created, [userId]);
      await this.notifications.onMeeting(tx, {
        kind: 'meeting_invite',
        recipients: audience,
        actorId: userId,
        spaceId,
        eventId: created.id,
        title,
        summary: title,
      });
      this.events.emit(tx, CALENDAR_EVENTS.eventCreated, { spaceId, id: created.id });
      if (audience.length)
        this.events.emit(tx, CALENDAR_EVENTS.eventInvited, {
          spaceId,
          id: created.id,
          userIds: audience,
        });
      return created;
    });
    return this.dtoFor(userId, row);
  }

  /**
   * One event of an imported calendar file (the person and the space were checked by the caller). Idempotent: an event with the same
   * UID already in the space is left alone, so importing a file twice makes no copies. Names of attendees stay text at the end of the
   * description: nobody is invited, and no address is kept. Returns what happened.
   */
  async createImported(
    userId: string,
    spaceId: string,
    series: IcsSeries,
    attendeesLabel: string,
  ): Promise<'created' | 'duplicate' | 'skipped'> {
    const m = series.master;
    const timing = normalizeTiming({ startAt: m.startAt, endAt: m.endAt, allDay: m.allDay, timezone: m.timezone, rrule: m.rrule });
    if (!timing.ok) return 'skipped';
    const exceptions = exceptionsOf(series);
    let description = m.description;
    if (m.attendees.length) description = [description, `${attendeesLabel}: ${m.attendees.join(', ')}`].filter(Boolean).join('\n\n');
    description = description.slice(0, CALENDAR_LIMITS.descriptionMax);
    const bytes = eventBytes(
      { title: m.title, description, location: m.location, videoUrl: m.videoUrl, rrule: timing.value.rrule },
      exceptions,
    );
    const id = newId();
    return this.prisma.fresh(async (tx) => {
      const seq = await this.seq.next(tx, spaceId);
      const had = await tx.event.findFirst({ where: { spaceId, icsUid: m.uid, deletedAt: null }, select: { id: true } });
      if (had) return 'duplicate' as const;
      if ((await tx.event.count({ where: { spaceId, deletedAt: null } })) >= CALENDAR_LIMITS.eventsPerSpace) throw invalid('too_many_events');
      await this.quota.chargeSpace(tx, spaceId, bytes);
      await tx.event.create({
        data: {
          id,
          spaceId,
          ownerId: userId,
          kind: m.attendees.length ? 'meeting' : 'event',
          title: m.title,
          description,
          location: m.location,
          videoUrl: m.videoUrl,
          startAt: new Date(timing.value.startAt),
          endAt: new Date(timing.value.endAt),
          allDay: timing.value.allDay,
          timezone: timing.value.timezone,
          rrule: timing.value.rrule,
          rruleUntil: timing.value.rrule ? timing.lastEnd : null,
          visibility: 'attendees',
          sizeBytes: bytes,
          icsUid: m.uid,
          seq,
          attendees: { create: [{ kind: 'user', subjectId: userId, status: 'accepted', respondedAt: new Date(), addedBy: null }] },
          exceptions: {
            create: exceptions.map((x) => ({
              id: newId(),
              originalStart: new Date(x.originalStart),
              kind: x.kind,
              override: x.override ? (x.override as Prisma.InputJsonValue) : Prisma.JsonNull,
            })),
          },
        },
      });
      if (m.alarms.length) await tx.eventReminder.create({ data: { eventId: id, userId, minutes: m.alarms } });
      this.events.emit(tx, CALENDAR_EVENTS.eventCreated, { spaceId, id });
      return 'created' as const;
    });
  }

  async duplicate(userId: string, id: string, input: DuplicateEventInput): Promise<EventDto> {
    const ctx = this.access.live(await this.access.forUser(userId, id));
    const space = await this.perms.requireCalendarSpace(
      userId,
      input.spaceId ?? ctx.event.spaceId,
      Permission.CREATE_MEETINGS,
    );
    const e = ctx.event;
    const shift = input.startAt ? new Date(input.startAt).getTime() - e.startAt.getTime() : 0;
    return this.create(userId, {
      id: input.id,
      spaceId: space.space.id,
      kind: e.kind as 'meeting' | 'event',
      title: e.title,
      description: e.description,
      location: e.location,
      videoUrl: e.videoUrl,
      startAt: input.startAt ?? e.startAt.toISOString(),
      endAt: input.endAt ?? new Date(e.endAt.getTime() + shift).toISOString(),
      allDay: e.allDay,
      timezone: e.timezone,
      rrule: e.rrule,
      visibility: e.visibility as 'attendees' | 'space',
    });
  }

  // ---------------------------------------------------------------- changing

  async update(userId: string, id: string, input: UpdateEventInput): Promise<EventDto> {
    const parsed = updateEventSchema.safeParse(input);
    if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'invalid');
    const body = parsed.data;
    const ctx = this.access.live(await this.access.forUser(userId, id));
    this.access.assertCanEdit(ctx);
    if (body.linkedChannelId) await this.checkChannel(ctx.event.spaceId, body.linkedChannelId);
    const changed = new Set(
      Object.keys(body).filter(
        (k) =>
          k !== 'scope' && k !== 'occurrence' && (body as Record<string, unknown>)[k] !== undefined,
      ),
    );
    if (!changed.size) return this.dtoFor(userId, ctx.event);

    const rule = ruleOf(ctx.event);
    const scope = rule ? body.scope : 'all';
    if (scope !== 'all') {
      if (!body.occurrence) throw invalid('occurrence_required');
      this.assertOccurrence(ctx.event, rule!, new Date(body.occurrence));
    }
    if (scope === 'following' && sameInstant(ctx.event.startAt, body.occurrence!))
      return this.applyAll(userId, ctx, body, changed);
    if (scope === 'all') return this.applyAll(userId, ctx, body, changed);
    if (scope === 'this') return this.applyThis(userId, ctx, body, changed);
    return this.applyFollowing(userId, ctx, body, changed);
  }

  /** The change is for the whole series (or the event, which does not repeat). */
  private async applyAll(
    userId: string,
    ctx: EventContext,
    body: Body,
    changed: ReadonlySet<string>,
  ): Promise<EventDto> {
    const e = ctx.event;
    const timingKeys = ['startAt', 'endAt', 'allDay', 'timezone', 'rrule'];
    const timingChanged = timingKeys.some((k) => changed.has(k));
    const timing = timingChanged ? this.timing(this.mergedTiming(e, body)) : null;
    const dropExceptions = ['startAt', 'allDay', 'timezone', 'rrule'].some((k) => changed.has(k));
    const spaceId = e.spaceId;

    const row = await this.prisma.fresh(async (tx) => {
      const seq = await this.seq.next(tx, spaceId);
      const current = await tx.event.findFirst({
        where: { id: e.id, deletedAt: null },
        include: EVENT_INCLUDE,
      });
      if (!current) throw notFound();
      // Offline merge: only what nobody else changed since the device saw it (everything, for a plain request).
      const guard = guardUpdate('event', current, changed, body as Record<string, unknown>, current as unknown as Record<string, unknown>);
      const allowed = guard.keys;
      const useTiming = !!timing && TIMING_KEYS.some((k) => allowed.has(k));
      const dropNow = dropExceptions && ['startAt', 'allDay', 'timezone', 'rrule'].some((k) => allowed.has(k));
      const keep = dropNow ? [] : current.exceptions;
      if (dropNow) await tx.eventException.deleteMany({ where: { eventId: e.id } });
      const next = {
        title: allowed.has('title') && body.title !== undefined ? body.title.trim() : current.title,
        description: allowed.has('description') ? (body.description ?? current.description) : current.description,
        location: allowed.has('location') && body.location !== undefined ? body.location : current.location,
        videoUrl: allowed.has('videoUrl') && body.videoUrl !== undefined ? body.videoUrl : current.videoUrl,
        rrule: useTiming ? timing.value.rrule : current.rrule,
      };
      const bytes = eventBytes(next, keep);
      await this.quota.chargeSpace(tx, spaceId, bytes - current.sizeBytes);
      const data: Prisma.EventUncheckedUpdateInput = {
        seq,
        fieldSeq: guard.next(seq),
        sizeBytes: bytes,
        title: next.title,
        description: next.description,
        location: next.location,
        videoUrl: next.videoUrl,
      };
      if (allowed.has('kind') && body.kind !== undefined) data.kind = body.kind;
      if (allowed.has('visibility') && body.visibility !== undefined) data.visibility = body.visibility;
      if (allowed.has('linkedChannelId') && body.linkedChannelId !== undefined) data.linkedChannelId = body.linkedChannelId;
      if (useTiming && timing) {
        data.startAt = new Date(timing.value.startAt);
        data.endAt = new Date(timing.value.endAt);
        data.allDay = timing.value.allDay;
        data.timezone = timing.value.timezone;
        data.rrule = timing.value.rrule;
        data.rruleUntil = timing.value.rrule ? this.untilWith(timing.lastEnd, keep) : null;
      }
      const updated = await tx.event.update({ where: { id: e.id }, data, include: EVENT_INCLUDE });
      const audience = await this.told(tx, updated, userId, allowed);
      this.events.emit(tx, CALENDAR_EVENTS.eventUpdated, { spaceId, id: e.id, userIds: audience });
      return updated;
    });
    return this.dtoFor(userId, row);
  }

  /** The change is for one occurrence of a series: it becomes an exception. */
  private async applyThis(
    userId: string,
    ctx: EventContext,
    body: Body,
    changed: ReadonlySet<string>,
  ): Promise<EventDto> {
    const e = ctx.event;
    for (const k of changed) if (!THIS_FIELDS.has(k)) throw invalid('scope_this_fields');
    const occurrence = new Date(body.occurrence!);
    const duration = e.endAt.getTime() - e.startAt.getTime();
    const spaceId = e.spaceId;

    const row = await this.prisma.fresh(async (tx) => {
      const seq = await this.seq.next(tx, spaceId);
      const current = await tx.event.findFirst({
        where: { id: e.id, deletedAt: null },
        include: EVENT_INCLUDE,
      });
      if (!current) throw notFound();
      const existing = current.exceptions.find(
        (x) => x.originalStart.getTime() === occurrence.getTime(),
      );
      if (!existing && current.exceptions.length >= CALENDAR_LIMITS.exceptionsPerEvent)
        throw invalid('too_many_exceptions');
      const override: EventOverrideDto = {
        ...((existing?.kind === 'override' ? existing.override : null) as EventOverrideDto | null),
      };
      if (body.title !== undefined) override.title = body.title.trim();
      if (body.description !== undefined) override.description = body.description;
      if (body.location !== undefined) override.location = body.location;
      if (body.videoUrl !== undefined) override.videoUrl = body.videoUrl;
      if (body.startAt !== undefined || body.endAt !== undefined) {
        const start = new Date(body.startAt ?? override.startAt ?? occurrence.toISOString());
        const end = new Date(
          body.endAt ??
            (body.startAt
              ? new Date(start.getTime() + duration).toISOString()
              : (override.endAt ?? new Date(start.getTime() + duration).toISOString())),
        );
        const t = normalizeTiming({
          startAt: start.toISOString(),
          endAt: end.toISOString(),
          allDay: current.allDay,
          timezone: current.timezone,
          rrule: null,
        });
        if (!t.ok) throw invalid(t.error);
        override.startAt = t.value.startAt;
        override.endAt = t.value.endAt;
      }
      if (existing)
        await tx.eventException.update({
          where: { id: existing.id },
          data: { kind: 'override', override: override as object },
        });
      else
        await tx.eventException.create({
          data: {
            id: newId(),
            eventId: e.id,
            originalStart: occurrence,
            kind: 'override',
            override: override as object,
          },
        });
      const exceptions = await tx.eventException.findMany({ where: { eventId: e.id } });
      const bytes = eventBytes(current, exceptions);
      await this.quota.chargeSpace(tx, spaceId, bytes - current.sizeBytes);
      const moved = exceptions.filter(
        (x) => x.kind === 'override' && (x.override as EventOverrideDto | null)?.endAt,
      );
      const updated = await tx.event.update({
        where: { id: e.id },
        data: {
          seq,
          sizeBytes: bytes,
          rruleUntil:
            current.rruleUntil && moved.length
              ? this.untilWith(current.rruleUntil, exceptions)
              : current.rruleUntil,
        },
        include: EVENT_INCLUDE,
      });
      const audience = await this.told(tx, updated, userId, changed);
      this.events.emit(tx, CALENDAR_EVENTS.eventUpdated, { spaceId, id: e.id, userIds: audience });
      return updated;
    });
    return this.dtoFor(userId, row);
  }

  /** The change is for this occurrence and every later one: the series ends before it and a new one starts there. */
  private async applyFollowing(
    userId: string,
    ctx: EventContext,
    body: Body,
    changed: ReadonlySet<string>,
  ): Promise<EventDto> {
    const e = ctx.event;
    const rule = ruleOf(e)!;
    const occurrence = new Date(body.occurrence!);
    const duration = e.endAt.getTime() - e.startAt.getTime();
    const tz = e.allDay ? 'UTC' : e.timezone;
    const spaceId = e.spaceId;
    const before = expandRule({
      startMs: e.startAt.getTime(),
      tz,
      rule,
      fromMs: e.startAt.getTime(),
      toMs: occurrence.getTime() - 1,
      max: CALENDAR_LIMITS.exceptionsPerEvent * 8,
    }).length;

    // The first series stops just before the occurrence.
    const oldRule: RRule = { ...rule, count: undefined, until: occurrence.getTime() - 1000 };
    // The new one starts at it (or where the person moved it), with what is left of the count.
    const startAt = body.startAt ?? occurrence.toISOString();
    const endAt = body.endAt ?? new Date(new Date(startAt).getTime() + duration).toISOString();
    let newRuleText: string | null = body.rrule !== undefined ? body.rrule : e.rrule;
    if (body.rrule === undefined && rule.count !== undefined)
      newRuleText = formatRRule({ ...rule, count: Math.max(1, rule.count - before) });
    const timing = this.timing({
      startAt,
      endAt,
      allDay: body.allDay ?? e.allDay,
      timezone: body.timezone ?? e.timezone,
      rrule: newRuleText,
    });
    const keepExceptions =
      !['allDay', 'timezone', 'rrule'].some((k) => changed.has(k)) &&
      new Date(startAt).getTime() === occurrence.getTime();

    const row = await this.prisma.fresh(async (tx) => {
      const seq = await this.seq.next(tx, spaceId);
      const current = await tx.event.findFirst({
        where: { id: e.id, deletedAt: null },
        include: EVENT_INCLUDE,
      });
      if (!current) throw notFound();
      const later = current.exceptions.filter(
        (x) => x.originalStart.getTime() >= occurrence.getTime(),
      );
      const firstExceptions = current.exceptions.filter(
        (x) => x.originalStart.getTime() < occurrence.getTime(),
      );
      const newId_ = newId();
      const title = body.title !== undefined ? body.title.trim() : current.title;
      const description = body.description ?? current.description;
      const location = body.location !== undefined ? body.location : current.location;
      const videoUrl = body.videoUrl !== undefined ? body.videoUrl : current.videoUrl;
      const newBytes = eventBytes(
        { title, description, location, videoUrl, rrule: timing.value.rrule },
        keepExceptions ? later : [],
      );
      const oldBytes = eventBytes(current, firstExceptions);
      await this.quota.chargeSpace(tx, spaceId, newBytes + oldBytes - current.sizeBytes);

      const created = await tx.event.create({
        data: {
          id: newId_,
          spaceId,
          ownerId: current.ownerId,
          kind: body.kind ?? current.kind,
          title,
          description,
          location,
          videoUrl,
          linkedChannelId:
            body.linkedChannelId !== undefined ? body.linkedChannelId : current.linkedChannelId,
          startAt: new Date(timing.value.startAt),
          endAt: new Date(timing.value.endAt),
          allDay: timing.value.allDay,
          timezone: timing.value.timezone,
          rrule: timing.value.rrule,
          rruleUntil: timing.value.rrule
            ? this.untilWith(timing.lastEnd, keepExceptions ? later : [])
            : null,
          visibility: body.visibility ?? current.visibility,
          sizeBytes: newBytes,
          seq,
          attendees: {
            create: current.attendees.map((a) => ({
              kind: a.kind,
              subjectId: a.subjectId,
              status: a.status,
              respondedAt: a.respondedAt,
              addedBy: a.addedBy,
              optional: a.optional,
            })),
          },
        },
        include: EVENT_INCLUDE,
      });
      if (later.length) {
        if (keepExceptions)
          await tx.eventException.updateMany({
            where: { id: { in: later.map((x) => x.id) } },
            data: { eventId: newId_ },
          });
        else await tx.eventException.deleteMany({ where: { id: { in: later.map((x) => x.id) } } });
      }
      const mineReminders = await tx.eventReminder.findMany({ where: { eventId: e.id } });
      if (mineReminders.length)
        await tx.eventReminder.createMany({
          data: mineReminders.map((r) => ({
            eventId: newId_,
            userId: r.userId,
            minutes: r.minutes as number[],
          })),
        });
      await tx.event.update({
        where: { id: e.id },
        data: {
          seq,
          sizeBytes: oldBytes,
          rrule: formatRRule(oldRule),
          rruleUntil: this.untilWith(
            new Date(lastOccurrence(e.startAt.getTime(), tz, oldRule)! + duration),
            firstExceptions,
          ),
        },
      });
      const fresh = await tx.event.findUniqueOrThrow({
        where: { id: newId_ },
        include: EVENT_INCLUDE,
      });
      const audience = await this.told(tx, fresh, userId, changed);
      this.events.emit(tx, CALENDAR_EVENTS.eventUpdated, { spaceId, id: e.id, userIds: audience });
      this.events.emit(tx, CALENDAR_EVENTS.eventCreated, { spaceId, id: newId_ });
      return fresh;
    });
    return this.dtoFor(userId, row);
  }

  /** Cancels an occurrence, the rest of a series, or the event. A single event goes for good (a tombstone stays for sync). */
  async cancel(userId: string, id: string, input: CancelEventInput): Promise<void> {
    const ctx = this.access.live(await this.access.forUser(userId, id));
    this.access.assertCanEdit(ctx);
    const e = ctx.event;
    const rule = ruleOf(e);
    const scope = rule ? (input.scope ?? 'all') : 'all';
    if (scope !== 'all') {
      if (!input.occurrence) throw invalid('occurrence_required');
      this.assertOccurrence(e, rule!, new Date(input.occurrence));
    }
    const spaceId = e.spaceId;
    const duration = e.endAt.getTime() - e.startAt.getTime();
    const tz = e.allDay ? 'UTC' : e.timezone;

    await this.prisma.fresh(async (tx) => {
      const seq = await this.seq.next(tx, spaceId);
      const current = await tx.event.findFirst({
        where: { id: e.id, deletedAt: null },
        include: EVENT_INCLUDE,
      });
      if (!current) throw notFound();
      const whole = scope === 'all' || (scope === 'following' && sameInstant(e.startAt, input.occurrence!));
      // Offline merge: an event somebody changed after the device saw it is not cancelled by that device.
      if (whole && !guardDelete(current)) return;
      const audience = await this.audience(tx, current, [userId]);
      if (whole) {
        await this.quota.chargeSpace(tx, spaceId, -current.sizeBytes);
        await tx.event.update({
          where: { id: e.id },
          data: { deletedAt: new Date(), seq, sizeBytes: 0 },
        });
        await tx.eventException.deleteMany({ where: { eventId: e.id } });
        await tx.eventReminder.deleteMany({ where: { eventId: e.id } });
      } else if (scope === 'this') {
        const occurrence = new Date(input.occurrence!);
        const existing = current.exceptions.find(
          (x) => x.originalStart.getTime() === occurrence.getTime(),
        );
        if (!existing && current.exceptions.length >= CALENDAR_LIMITS.exceptionsPerEvent)
          throw invalid('too_many_exceptions');
        if (existing)
          await tx.eventException.update({
            where: { id: existing.id },
            data: { kind: 'cancelled', override: Prisma.DbNull },
          });
        else
          await tx.eventException.create({
            data: { id: newId(), eventId: e.id, originalStart: occurrence, kind: 'cancelled' },
          });
        const exceptions = await tx.eventException.findMany({ where: { eventId: e.id } });
        const bytes = eventBytes(current, exceptions);
        await this.quota.chargeSpace(tx, spaceId, bytes - current.sizeBytes);
        await tx.event.update({ where: { id: e.id }, data: { seq, sizeBytes: bytes } });
      } else {
        const occurrence = new Date(input.occurrence!);
        const oldRule: RRule = { ...rule!, count: undefined, until: occurrence.getTime() - 1000 };
        const stay = current.exceptions.filter(
          (x) => x.originalStart.getTime() < occurrence.getTime(),
        );
        await tx.eventException.deleteMany({
          where: { eventId: e.id, originalStart: { gte: occurrence } },
        });
        const bytes = eventBytes({ ...current, rrule: formatRRule(oldRule) }, stay);
        await this.quota.chargeSpace(tx, spaceId, bytes - current.sizeBytes);
        await tx.event.update({
          where: { id: e.id },
          data: {
            seq,
            sizeBytes: bytes,
            rrule: formatRRule(oldRule),
            rruleUntil: this.untilWith(
              new Date(lastOccurrence(e.startAt.getTime(), tz, oldRule)! + duration),
              stay,
            ),
          },
        });
      }
      await this.notifications.onMeeting(tx, {
        kind: 'meeting_cancelled',
        recipients: audience,
        actorId: userId,
        spaceId,
        eventId: e.id,
        title: current.title,
        summary: current.title,
      });
      this.events.emit(tx, CALENDAR_EVENTS.eventCancelled, { spaceId, id: e.id });
    });
  }

  // ---------------------------------------------------------------- answering

  /** Accept, decline or answer "maybe". Only people named on the event (or the author) may; a role member gets a row of their own. */
  async rsvp(userId: string, id: string, input: RsvpInput): Promise<EventDto> {
    if (input.scope && input.scope !== 'all') throw invalid('unsupported_scope');
    const status: RsvpAnswer = input.status;
    const ctx = this.access.live(await this.access.forUser(userId, id));
    const e = ctx.event;
    const mine = myRow(e, ctx.viewer);
    if (!mine && e.ownerId !== userId) throw forbidden();
    const spaceId = e.spaceId;

    const row = await this.prisma.fresh(async (tx) => {
      const seq = await this.seq.next(tx, spaceId);
      const current = await tx.event.findFirst({
        where: { id: e.id, deletedAt: null },
        include: EVENT_INCLUDE,
      });
      if (!current) throw notFound();
      const now = new Date();
      await tx.eventAttendee.upsert({
        where: { eventId_kind_subjectId: { eventId: e.id, kind: 'user', subjectId: userId } },
        create: {
          eventId: e.id,
          kind: 'user',
          subjectId: userId,
          status,
          respondedAt: now,
          addedBy: mine?.addedBy ?? null,
          optional: mine?.optional ?? false,
        },
        update: { status, respondedAt: now },
      });
      const updated = await tx.event.update({
        where: { id: e.id },
        data: { seq },
        include: EVENT_INCLUDE,
      });
      if (current.ownerId)
        await this.notifications.onMeeting(tx, {
          kind: 'meeting_response',
          recipients: [current.ownerId],
          actorId: userId,
          spaceId,
          eventId: e.id,
          title: current.title,
          summary: current.title,
        });
      this.events.emit(tx, CALENDAR_EVENTS.rsvpChanged, {
        spaceId,
        id: e.id,
        userIds: current.ownerId ? [current.ownerId] : [],
      });
      return updated;
    });
    return this.dtoFor(userId, row);
  }

  // ---------------------------------------------------------------- people

  async addAttendees(
    userId: string,
    id: string,
    input: AddAttendeesInput,
  ): Promise<EventDetailDto> {
    const ctx = this.access.live(await this.access.forUser(userId, id));
    this.access.assertCanEdit(ctx);
    if (ctx.personal) throw invalid('no_attendees_in_personal');
    const people = await this.checkAttendees(userId, ctx.space, input.attendees);
    const spaceId = ctx.event.spaceId;

    await this.prisma.fresh(async (tx) => {
      const seq = await this.seq.next(tx, spaceId);
      const current = await tx.event.findFirst({
        where: { id: id, deletedAt: null },
        include: EVENT_INCLUDE,
      });
      if (!current) throw notFound();
      const have = new Set(current.attendees.map((a) => `${a.kind}:${a.subjectId}`));
      const fresh = people.filter((p) => !have.has(`${p.kind}:${p.subjectId}`));
      if (!fresh.length) return;
      const users =
        current.attendees.filter((a) => a.kind === 'user').length +
        fresh.filter((p) => p.kind === 'user').length;
      const roles =
        current.attendees.filter((a) => a.kind === 'role').length +
        fresh.filter((p) => p.kind === 'role').length;
      if (users > CALENDAR_LIMITS.usersPerEvent || roles > CALENDAR_LIMITS.rolesPerEvent)
        throw invalid('too_many_attendees');
      await tx.eventAttendee.createMany({
        data: fresh.map((p) => ({
          eventId: id,
          kind: p.kind,
          subjectId: p.subjectId,
          status: 'invited',
          addedBy: userId,
          optional: p.optional ?? false,
        })),
      });
      const updated = await tx.event.update({
        where: { id },
        data: { seq },
        include: EVENT_INCLUDE,
      });
      const invited = await this.audience(
        tx,
        {
          ...updated,
          attendees: updated.attendees.filter((a) =>
            fresh.some((p) => p.kind === a.kind && p.subjectId === a.subjectId),
          ),
        },
        [userId],
      );
      await this.notifications.onMeeting(tx, {
        kind: 'meeting_invite',
        recipients: invited,
        actorId: userId,
        spaceId,
        eventId: id,
        title: current.title,
        summary: current.title,
      });
      this.events.emit(tx, CALENDAR_EVENTS.eventUpdated, { spaceId, id });
      if (invited.length)
        this.events.emit(tx, CALENDAR_EVENTS.eventInvited, { spaceId, id, userIds: invited });
    });
    return this.detail(userId, id);
  }

  async removeAttendee(
    userId: string,
    id: string,
    kind: 'user' | 'role',
    subjectId: string,
  ): Promise<EventDetailDto> {
    const ctx = this.access.live(await this.access.forUser(userId, id));
    this.access.assertCanEdit(ctx);
    if (kind === 'user' && subjectId === ctx.event.ownerId) throw invalid('cannot_remove_owner');
    const spaceId = ctx.event.spaceId;
    await this.prisma.fresh(async (tx) => {
      const seq = await this.seq.next(tx, spaceId);
      const gone = await tx.eventAttendee.deleteMany({ where: { eventId: id, kind, subjectId } });
      if (!gone.count) throw notFound();
      await tx.event.update({ where: { id }, data: { seq } });
      this.events.emit(tx, CALENDAR_EVENTS.eventUpdated, {
        spaceId,
        id,
        userIds: kind === 'user' ? [subjectId] : [],
      });
    });
    // The person taken off may no longer see the event: the answer is built for the caller, who still does.
    return this.detail(userId, id);
  }

  /** The person's own reminders on one event (minutes before the start); null goes back to their defaults. */
  async setReminders(
    userId: string,
    id: string,
    input: RemindersInput,
  ): Promise<{ reminders: number[] | null }> {
    this.access.live(await this.access.forUser(userId, id));
    if (input.minutes === null)
      await this.prisma.eventReminder.deleteMany({ where: { eventId: id, userId } });
    else {
      const minutes = [...new Set(input.minutes)].sort((a, b) => a - b);
      await this.prisma.eventReminder.upsert({
        where: { eventId_userId: { eventId: id, userId } },
        create: { eventId: id, userId, minutes },
        update: { minutes },
      });
    }
    return {
      reminders: input.minutes === null ? null : [...new Set(input.minutes)].sort((a, b) => a - b),
    };
  }

  // ---------------------------------------------------------------- helpers

  /** Checks when an event happens and answers with the normalised form (or the reason it is refused). */
  private timing(t: Timing) {
    const r = normalizeTiming(t);
    if (!r.ok) throw invalid(r.error);
    return r;
  }

  private mergedTiming(e: EventRow, body: Body): Timing {
    return {
      startAt: body.startAt ?? e.startAt.toISOString(),
      endAt: body.endAt ?? e.endAt.toISOString(),
      allDay: body.allDay ?? e.allDay,
      timezone: body.timezone ?? e.timezone,
      rrule: body.rrule !== undefined ? body.rrule : e.rrule,
    };
  }

  /** When the last occurrence ends, never earlier than an occurrence that was moved later. */
  private untilWith(
    end: Date | null,
    exceptions: readonly { override?: unknown; kind?: string }[],
  ): Date | null {
    if (!end) return null;
    let latest = end.getTime();
    for (const x of exceptions) {
      const o = (x.override ?? null) as EventOverrideDto | null;
      if (o?.endAt) latest = Math.max(latest, new Date(o.endAt).getTime());
    }
    return new Date(latest);
  }

  /** `occurrence` must be one of the instants the series really starts at. */
  private assertOccurrence(e: EventRow, rule: RRule, occurrence: Date): void {
    if (Number.isNaN(occurrence.getTime())) throw invalid('occurrence_invalid');
    const hit = expandRule({
      startMs: e.startAt.getTime(),
      tz: e.allDay ? 'UTC' : e.timezone,
      rule,
      fromMs: occurrence.getTime(),
      toMs: occurrence.getTime(),
      max: 1,
    });
    if (hit[0] !== occurrence.getTime()) throw invalid('not_an_occurrence');
  }

  private async checkChannel(spaceId: string, channelId: string): Promise<void> {
    const channel = await this.prisma.channel.findFirst({ where: { id: channelId, spaceId } });
    if (!channel) throw invalid('invalid_channel');
  }

  /**
   * Who may be named on an event, and by whom. Everybody must belong to the space's team and be able to see its calendar. Roles and
   * other people need ADD_TO_MEMBER_CALENDARS; without it a person can put on an event only themselves and those who opened their
   * calendar to invitations.
   */
  private async checkAttendees(
    userId: string,
    space: SpaceAccess,
    input: readonly AttendeeInput[],
  ): Promise<AttendeeInput[]> {
    const wanted = new Map<string, AttendeeInput>();
    for (const a of input)
      if (!(a.kind === 'user' && a.subjectId === userId)) wanted.set(`${a.kind}:${a.subjectId}`, a);
    const list = [...wanted.values()];
    if (!list.length) return [];
    if (space.space.kind === 'personal' || !space.teamId) throw invalid('no_attendees_in_personal');
    const users = list.filter((a) => a.kind === 'user');
    const roles = list.filter((a) => a.kind === 'role');
    if (
      users.length > CALENDAR_LIMITS.usersPerEvent ||
      roles.length > CALENDAR_LIMITS.rolesPerEvent
    )
      throw invalid('too_many_attendees');
    const mayAdd = hasPermission(space.perms, Permission.ADD_TO_MEMBER_CALENDARS);
    if (roles.length && !mayAdd) throw forbidden();

    if (users.length) {
      const ids = users.map((u) => u.subjectId);
      const members = await this.prisma.teamMember.findMany({
        where: { teamId: space.teamId, userId: { in: ids } },
        select: { userId: true },
      });
      if (members.length !== ids.length) throw invalid('not_a_member');
      const viewers = await this.perms.spaceViewers(space.space.id, ids, Permission.VIEW_CALENDAR);
      if (viewers.size !== ids.length) throw invalid('cannot_view_calendar');
      if (!mayAdd) {
        const open = await this.prisma.userCalendarSetting.findMany({
          where: { userId: { in: ids }, openInvites: true },
          select: { userId: true },
        });
        if (open.length !== ids.length) throw forbidden();
      }
    }
    if (roles.length) {
      const found = await this.prisma.role.count({
        where: {
          id: { in: roles.map((r) => r.subjectId) },
          teamId: space.teamId,
          isEveryone: false,
        },
      });
      if (found !== roles.length) throw invalid('invalid_role');
    }
    return list;
  }

  /** Everybody who has the event on their calendar (the author, people named, members of roles named who can see it), without those who declined and `exclude`. */
  async audience(
    db: Tx | PrismaService,
    row: Pick<EventRow, 'spaceId' | 'ownerId' | 'attendees'>,
    exclude: readonly string[] = [],
  ): Promise<string[]> {
    const declined = new Set(
      row.attendees
        .filter((a) => a.kind === 'user' && a.status === 'declined')
        .map((a) => a.subjectId),
    );
    const people = new Set(row.attendees.filter((a) => a.kind === 'user').map((a) => a.subjectId));
    const roleIds = row.attendees.filter((a) => a.kind === 'role').map((a) => a.subjectId);
    if (roleIds.length) {
      const members = [
        ...new Set(
          (
            await db.memberRole.findMany({
              where: { roleId: { in: roleIds } },
              select: { userId: true },
              take: 5000,
            })
          ).map((m) => m.userId),
        ),
      ];
      for (const id of await this.perms.spaceViewers(
        row.spaceId,
        members,
        Permission.VIEW_CALENDAR,
        db,
      ))
        people.add(id);
    }
    return [...people].filter((id) => !declined.has(id) && !exclude.includes(id));
  }

  /** Tells the people on the event that something they care about changed; returns who has the event on their calendar. */
  private async told(
    tx: Tx,
    row: EventRow,
    actorId: string,
    changed: ReadonlySet<string>,
  ): Promise<string[]> {
    const audience = await this.audience(tx, row, [actorId]);
    if ([...changed].some((k) => NOTABLE.has(k)))
      await this.notifications.onMeeting(tx, {
        kind: 'meeting_updated',
        recipients: audience,
        actorId,
        spaceId: row.spaceId,
        eventId: row.id,
        title: row.title,
        summary: row.title,
      });
    return audience;
  }
}
