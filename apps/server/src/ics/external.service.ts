import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { CalendarDto, ExternalCalendarDto } from '@os-planner/shared';
import { normalizeTiming } from '@os-planner/shared/calendar';
import {
  ICS_LIMITS,
  IcsParseError,
  exceptionsOf,
  parseIcs,
  type CreateExternalInput,
  type IcsError,
  type UpdateExternalInput,
} from '@os-planner/shared/ics';
import { newId } from '../common/crypto.js';
import { ENV, type Env } from '../config/env.js';
import { Prisma, type ExternalCalendar } from '../generated/prisma/client.js';
import { ExternalReader } from '../calendar/external-reader.js';
import { NotificationService } from '../notifications/notification.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { IcsFetcher } from './ics-fetcher.js';
import { IcsFetchError, parseCalendarUrl } from './safe-fetch.js';

const MINUTE = 60_000;
const DAY = 86_400_000;
/** Most followed calendars read at the same time on one server. */
const CONCURRENCY = 4;
/** What a worker that took a calendar leaves as its next time, so nobody else takes it while it is read (and a crash only delays it). */
const CLAIM_MINUTES = 15;
/** The longest wait between two tries of a calendar that keeps failing. */
const MAX_BACKOFF_MINUTES = 24 * 60;

/** A counting semaphore: at most `n` jobs run at once, the others wait their turn. */
class Limiter {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly n: number) {}
  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.running >= this.n) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.running++;
    try {
      return await job();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}

/** The error of the website: `ics.error.<code>`. */
const asHttp = (code: IcsError): HttpException =>
  code === 'refresh_too_soon'
    ? new HttpException(code, 429)
    : code === 'too_many_calendars'
      ? new ConflictException(code)
      : new UnprocessableEntityException(code);

function codeOf(e: unknown): IcsError {
  if (e instanceof IcsFetchError || e instanceof IcsParseError) return e.code;
  return 'ics_unreachable';
}

/** The key two UIDs that a case-insensitive, accent-insensitive column cannot tell apart share. */
const uidKey = (uid: string): string => uid.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const toDto = (c: ExternalCalendar, eventCount: number): ExternalCalendarDto => ({
  id: c.id,
  name: c.name,
  url: c.url,
  color: c.color,
  enabled: c.enabled,
  syncEveryMinutes: c.syncEveryMinutes,
  lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
  lastError: c.lastError,
  failingSince: c.failingSince?.toISOString() ?? null,
  disabledReason: c.disabledReason,
  eventCount,
  createdAt: c.createdAt.toISOString(),
});

/**
 * Calendars other people publish that a person follows (phase 14). The server reads the address now and then and keeps the events
 * for display, read only. Reading is careful (see `safeFetch`), bounded (size, count, time, storage per person) and polite (it
 * asks "has it changed?", waits longer after failures, and gives up on an address that fails for two weeks).
 */
@Injectable()
export class ExternalCalendarsService {
  private readonly log = new Logger(ExternalCalendarsService.name);
  private readonly limiter = new Limiter(CONCURRENCY);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fetcher: IcsFetcher,
    private readonly notifications: NotificationService,
    private readonly reader: ExternalReader,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ---------------------------------------------------------------- the person's list

  async list(userId: string): Promise<ExternalCalendarDto[]> {
    const rows = await this.prisma.externalCalendar.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    const counts = await this.prisma.externalEvent.groupBy({
      by: ['calendarId'],
      where: { calendarId: { in: rows.map((r) => r.id) } },
      _count: { _all: true },
    });
    const count = new Map(counts.map((c) => [c.calendarId, c._count._all]));
    return rows.map((r) => toDto(r, count.get(r.id) ?? 0));
  }

  private async mine(userId: string, id: string): Promise<ExternalCalendar> {
    const row = await this.prisma.externalCalendar.findFirst({ where: { id, userId } });
    if (!row) throw new NotFoundException('not_found');
    return row;
  }

  /** The calendar is read once before it is kept: an address that cannot be read is refused with the reason, and nothing is saved. */
  async create(userId: string, input: CreateExternalInput): Promise<ExternalCalendarDto> {
    if (
      (await this.prisma.externalCalendar.count({ where: { userId } })) >=
      ICS_LIMITS.externalPerUser
    )
      throw asHttp('too_many_calendars');
    const interval = input.syncEveryMinutes ?? ICS_LIMITS.syncDefaultMinutes;
    const id = newId();
    const now = new Date();
    try {
      const url = input.url.trim();
      parseCalendarUrl(url, true); // the address itself; whether http is allowed is the fetcher's decision
      const loaded = await this.limiter.run(() => this.load(url, null, null));
      if (loaded.notModified) throw new IcsFetchError('ics_http_error');
      await this.assertRoom(userId, null, loaded.bytes);
      await this.prisma.$transaction(async (tx) => {
        await tx.externalCalendar.create({
          data: {
            id,
            userId,
            name: input.name.trim(),
            url,
            color: input.color ?? '#6b7280',
            etag: loaded.etag,
            lastModified: loaded.lastModified,
            lastSyncAt: now,
            nextSyncAt: this.next(now, interval),
            syncEveryMinutes: interval,
          },
        });
        await this.writeEvents(tx, id, loaded.rows);
      });
    } catch (e) {
      if (e instanceof IcsFetchError || e instanceof IcsParseError) throw asHttp(e.code);
      throw e;
    }
    return toDto(
      await this.mine(userId, id),
      await this.prisma.externalEvent.count({ where: { calendarId: id } }),
    );
  }

  async update(
    userId: string,
    id: string,
    patch: UpdateExternalInput,
  ): Promise<ExternalCalendarDto> {
    const row = await this.mine(userId, id);
    const data: Prisma.ExternalCalendarUpdateInput = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.color !== undefined) data.color = patch.color;
    if (patch.syncEveryMinutes !== undefined) {
      data.syncEveryMinutes = patch.syncEveryMinutes;
      data.nextSyncAt = this.next(row.lastSyncAt ?? new Date(), patch.syncEveryMinutes);
    }
    if (patch.enabled !== undefined) {
      data.enabled = patch.enabled;
      if (patch.enabled && !row.enabled) {
        // Turned back on: start afresh, and look at it at the next sweep.
        data.failureCount = 0;
        data.failingSince = null;
        data.lastError = null;
        data.disabledReason = null;
        data.nextSyncAt = new Date();
      }
    }
    const saved = await this.prisma.externalCalendar.update({ where: { id }, data });
    return toDto(saved, await this.prisma.externalEvent.count({ where: { calendarId: id } }));
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.mine(userId, id);
    await this.prisma.externalCalendar.delete({ where: { id } });
  }

  /** "Refresh now": at most once every five minutes per calendar. */
  async refresh(userId: string, id: string): Promise<ExternalCalendarDto> {
    const row = await this.mine(userId, id);
    const since = row.lastAttemptAt ? Date.now() - row.lastAttemptAt.getTime() : Infinity;
    if (since < ICS_LIMITS.refreshCooldownSeconds * 1000) throw asHttp('refresh_too_soon');
    const claimed = await this.prisma.externalCalendar.updateMany({
      where: { id, OR: [{ lastAttemptAt: null }, { lastAttemptAt: row.lastAttemptAt }] },
      data: { lastAttemptAt: new Date() },
    });
    if (!claimed.count) throw asHttp('refresh_too_soon');
    // A calendar the server switched off is tried again when the person asks.
    const fresh = { ...row, enabled: true };
    await this.limiter.run(() => this.sync(fresh, true));
    return toDto(
      await this.mine(userId, id),
      await this.prisma.externalEvent.count({ where: { calendarId: id } }),
    );
  }

  /** The calendar's events in a window (the same entries the calendar shows). */
  async events(userId: string, id: string, from: Date, to: Date): Promise<CalendarDto> {
    await this.mine(userId, id);
    const r = await this.reader.items(userId, from, to, 5000, id);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      items: r.items,
      truncated: r.truncated,
    };
  }

  // ---------------------------------------------------------------- reading one

  private next(from: Date, minutes: number): Date {
    const jitter = 1 + (Math.random() * 0.2 - 0.1);
    return new Date(from.getTime() + minutes * MINUTE * jitter);
  }

  /** Fetches and parses; the rows are ready to store. */
  private async load(url: string, etag: string | null, lastModified: string | null) {
    const res = await this.fetcher.fetch(url, { etag, lastModified });
    if (res.notModified) return { notModified: true as const };
    const parsed = parseIcs(res.body);
    const rows: Prisma.ExternalEventCreateManyInput[] = [];
    const seen = new Set<string>();
    let bytes = 0;
    for (const s of parsed.series) {
      const m = s.master;
      const key = uidKey(m.uid);
      if (seen.has(key)) continue;
      seen.add(key);
      const timing = normalizeTiming({
        startAt: m.startAt,
        endAt: m.endAt,
        allDay: m.allDay,
        timezone: m.timezone,
        rrule: m.rrule,
      });
      if (!timing.ok) continue;
      const exceptions = exceptionsOf(s);
      const size =
        Buffer.byteLength(m.title) +
        Buffer.byteLength(m.description) +
        Buffer.byteLength(m.location ?? '') +
        Buffer.byteLength(m.url ?? '') +
        Buffer.byteLength(m.rrule ?? '') +
        (exceptions.length ? Buffer.byteLength(JSON.stringify(exceptions)) : 0) +
        96;
      bytes += size;
      rows.push({
        id: newId(),
        calendarId: '',
        uid: m.uid,
        recurrenceId: '',
        startAt: new Date(timing.value.startAt),
        endAt: new Date(timing.value.endAt),
        allDay: m.allDay,
        timezone: timing.value.timezone,
        title: m.title,
        description: m.description,
        location: m.location,
        url: m.url,
        rrule: timing.value.rrule,
        rruleUntil: timing.value.rrule ? timing.lastEnd : null,
        exdates: exceptions.length
          ? (exceptions as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        status: m.status,
        sequence: m.sequence,
        sizeBytes: size,
      });
    }
    return {
      notModified: false as const,
      rows,
      bytes,
      etag: res.etag,
      lastModified: res.lastModified,
    };
  }

  /** A person's followed calendars together may take this much; `except` is the one being replaced. */
  private async assertRoom(userId: string, except: string | null, bytes: number): Promise<void> {
    const used = await this.prisma.externalEvent.aggregate({
      _sum: { sizeBytes: true },
      where: { calendar: { userId }, ...(except ? { calendarId: { not: except } } : {}) },
    });
    if (
      (used._sum.sizeBytes ?? 0) + bytes >
      Math.floor(this.env.EXTERNAL_CALENDAR_MAX_MB * 1024 * 1024)
    )
      throw new IcsFetchError('ics_quota');
  }

  private async writeEvents(
    tx: Prisma.TransactionClient,
    calendarId: string,
    rows: Prisma.ExternalEventCreateManyInput[],
  ): Promise<void> {
    await tx.externalEvent.deleteMany({ where: { calendarId } });
    for (let i = 0; i < rows.length; i += 500)
      await tx.externalEvent.createMany({
        data: rows.slice(i, i + 500).map((r) => ({ ...r, calendarId })),
      });
  }

  /**
   * One refresh of one calendar: ask, parse, replace what is kept. A failure keeps what was there and counts: the wait grows with each,
   * and after two weeks without a success the calendar is switched off and its person is told.
   */
  async sync(cal: ExternalCalendar, manual = false): Promise<void> {
    const now = new Date();
    try {
      const loaded = await this.load(cal.url, cal.etag, cal.lastModified);
      if (loaded.notModified) {
        await this.succeeded(cal, now, {});
        return;
      }
      await this.assertRoom(cal.userId, cal.id, loaded.bytes);
      await this.prisma.$transaction(async (tx) => {
        await this.writeEvents(tx, cal.id, loaded.rows);
      });
      await this.succeeded(cal, now, { etag: loaded.etag, lastModified: loaded.lastModified });
    } catch (e) {
      const code = codeOf(e);
      if (code === 'ics_unreachable' && !(e instanceof IcsFetchError))
        this.log.warn(`calendar ${cal.id}: ${e instanceof Error ? e.message : e}`);
      await this.failed(cal, now, code);
      if (manual) return; // the page reads the state from the calendar
    }
  }

  private async succeeded(
    cal: ExternalCalendar,
    now: Date,
    extra: { etag?: string | null; lastModified?: string | null },
  ): Promise<void> {
    await this.prisma.externalCalendar.update({
      where: { id: cal.id },
      data: {
        ...extra,
        lastSyncAt: now,
        lastAttemptAt: now,
        lastError: null,
        failureCount: 0,
        failingSince: null,
        nextSyncAt: this.next(now, cal.syncEveryMinutes),
      },
    });
  }

  private async failed(cal: ExternalCalendar, now: Date, code: IcsError): Promise<void> {
    const failures = cal.failureCount + 1;
    const since = cal.failingSince ?? now;
    const give_up = now.getTime() - since.getTime() > ICS_LIMITS.disableAfterDays * DAY;
    const wait = Math.min(cal.syncEveryMinutes * 2 ** Math.min(failures, 10), MAX_BACKOFF_MINUTES);
    await this.prisma.externalCalendar.update({
      where: { id: cal.id },
      data: {
        lastAttemptAt: now,
        lastError: code,
        failureCount: failures,
        failingSince: since,
        nextSyncAt: this.next(now, wait),
        ...(give_up ? { enabled: false, disabledReason: 'failing_too_long' } : {}),
      },
    });
    if (give_up) {
      try {
        await this.notifications.calendarSyncOff(cal.userId, cal.id, cal.name);
      } catch (e) {
        this.log.warn(
          `could not tell about calendar ${cal.id}: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
  }

  // ---------------------------------------------------------------- the scheduler

  @Cron('* * * * *')
  async tick(): Promise<void> {
    try {
      await this.refreshDue();
    } catch (e) {
      this.log.error(`calendar refresh failed: ${e instanceof Error ? e.stack : e}`);
    }
  }

  /**
   * Reads every calendar that is due. A worker takes one by moving its next time forward (one `updateMany` that only one of several
   * servers can win), so two servers never read the same calendar at once and nothing needs a separate lock.
   */
  async refreshDue(now = new Date(), max = 40): Promise<number> {
    const due = await this.prisma.externalCalendar.findMany({
      where: { enabled: true, nextSyncAt: { lte: now } },
      orderBy: { nextSyncAt: 'asc' },
      take: max,
    });
    const jobs: Promise<void>[] = [];
    for (const cal of due) {
      const claimed = await this.prisma.externalCalendar.updateMany({
        where: { id: cal.id, nextSyncAt: cal.nextSyncAt },
        data: { nextSyncAt: new Date(now.getTime() + CLAIM_MINUTES * MINUTE) },
      });
      if (claimed.count) jobs.push(this.limiter.run(() => this.sync(cal)));
    }
    await Promise.allSettled(jobs);
    return jobs.length;
  }
}
