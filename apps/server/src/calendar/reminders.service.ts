import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CALENDAR_EVENTS, type Locale } from '@os-planner/shared';
import { expandEvent, type Expandable } from '@os-planner/shared/calendar';
import { EventBus } from '../events/event-bus.js';
import { MailService } from '../mail/mail.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CalendarViews } from './calendar-views.service.js';
import { toExceptionDto, EVENT_INCLUDE, type EventRow } from './event-views.js';
import { EventsService } from './events.service.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Reminders up to a day ahead are looked for every minute; longer ones (up to a week) hourly, so they may come up to an hour late. */
export const SHORT_LEAD_MINUTES = 24 * 60;
export const LONG_LEAD_MINUTES = 7 * 24 * 60;

/** Events that were cancelled stay as a tombstone this long, so every device hears of it. */
export const EVENT_TOMBSTONE_DAYS = 30;

const when = (locale: string, start: Date, allDay: boolean, tz: string): string => {
  const lang = locale === 'pt' ? 'pt-PT' : 'en-GB';
  const text = new Intl.DateTimeFormat(
    lang,
    allDay
      ? { dateStyle: 'medium', timeZone: 'UTC' }
      : { dateStyle: 'medium', timeStyle: 'short', timeZone: tz },
  ).format(start);
  return `${locale === 'pt' ? 'em' : 'on'} ${text}`;
};

/**
 * Reminders: "this starts in 10 minutes". A sweep looks at the occurrences about to start and tells each person on them, once per
 * occurrence and lead time. Being told is recorded in `ReminderDelivery` (its primary key is the person, the occurrence and the
 * lead), in the same transaction as the notification, so however many workers run, each reminder goes out once.
 */
@Injectable()
export class RemindersService {
  private readonly log = new Logger(RemindersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly views: CalendarViews,
    private readonly notifications: NotificationService,
    private readonly bus: EventBus,
    private readonly mail: MailService,
  ) {}

  @Cron('* * * * *')
  async everyMinute(): Promise<void> {
    try {
      await this.sweep(new Date(), SHORT_LEAD_MINUTES);
    } catch (e) {
      this.log.error(`reminder sweep failed: ${e instanceof Error ? e.stack : e}`);
    }
  }

  @Cron('7 * * * *')
  async hourly(): Promise<void> {
    try {
      await this.sweep(new Date(), LONG_LEAD_MINUTES);
    } catch (e) {
      this.log.error(`long reminder sweep failed: ${e instanceof Error ? e.stack : e}`);
    }
  }

  @Cron('40 3 * * *')
  async nightly(): Promise<void> {
    try {
      const n = await this.purge();
      if (n) this.log.log(`removed ${n} old calendar rows`);
    } catch (e) {
      this.log.error(`calendar cleanup failed: ${e instanceof Error ? e.stack : e}`);
    }
  }

  /**
   * Sends every reminder that is due: an occurrence starting after `now` whose lead (the person's own reminder on the event, or their
   * default) has been reached. Returns how many went out.
   */
  async sweep(now = new Date(), maxLead = SHORT_LEAD_MINUTES): Promise<number> {
    const horizon = new Date(now.getTime() + maxLead * MINUTE + 1);
    let sent = 0;
    let after = '';
    for (;;) {
      const batch: EventRow[] = await this.prisma.event.findMany({
        where: {
          id: { gt: after },
          deletedAt: null,
          startAt: { lt: horizon },
          OR: [
            { rrule: null, endAt: { gte: now } },
            { rrule: { not: null }, OR: [{ rruleUntil: null }, { rruleUntil: { gte: now } }] },
          ],
        },
        include: EVENT_INCLUDE,
        orderBy: { id: 'asc' },
        take: 200,
      });
      if (!batch.length) return sent;
      after = batch.at(-1)!.id;
      for (const row of batch) sent += await this.remind(row, now, horizon);
    }
  }

  private async remind(row: EventRow, now: Date, horizon: Date): Promise<number> {
    const e: Expandable = {
      startAt: row.startAt.toISOString(),
      endAt: row.endAt.toISOString(),
      allDay: row.allDay,
      timezone: row.timezone,
      rrule: row.rrule,
      exceptions: row.exceptions.map(toExceptionDto),
    };
    const upcoming = expandEvent(e, now.getTime(), horizon.getTime()).filter(
      (o) => new Date(o.start) > now,
    );
    if (!upcoming.length) return 0;
    const people = await this.events.audience(this.prisma, row);
    if (!people.length) return 0;
    const [settings, own] = await Promise.all([
      this.views.settingsOf(people),
      this.prisma.eventReminder.findMany({ where: { eventId: row.id, userId: { in: people } } }),
    ]);
    const ownBy = new Map(own.map((r) => [r.userId, r.minutes as number[]]));

    let sent = 0;
    for (const o of upcoming) {
      const start = new Date(o.start);
      const title = o.override?.title ?? row.title;
      for (const userId of people) {
        const leads = ownBy.get(userId) ?? settings.get(userId)!.defaultReminders;
        for (const minutes of leads) {
          if (start.getTime() - minutes * MINUTE > now.getTime()) continue; // not yet
          if (
            await this.deliver(
              row,
              userId,
              new Date(o.originalStart),
              minutes,
              title,
              start,
              settings.get(userId)!.defaultTz,
            )
          )
            sent++;
        }
      }
    }
    return sent;
  }

  /** True when this call is the one that sent it. */
  private async deliver(
    row: EventRow,
    userId: string,
    occurrence: Date,
    minutes: number,
    title: string,
    start: Date,
    tz: string | null,
  ): Promise<boolean> {
    let told: string[] = [];
    try {
      told = await this.prisma.fresh(async (tx) => {
        await tx.reminderDelivery.create({
          data: { eventId: row.id, userId, occurrenceStart: occurrence, minutesBefore: minutes },
        });
        const out = await this.notifications.onMeeting(tx, {
          kind: 'meeting_reminder',
          recipients: [userId],
          actorId: null,
          spaceId: row.spaceId,
          eventId: row.id,
          title,
          summary: title,
        });
        this.bus.publishAfterCommit(tx, 'room.event', {
          rooms: [`user:${userId}`],
          name: CALENDAR_EVENTS.reminderDue,
          payload: {
            eventId: row.id,
            spaceId: row.spaceId,
            title,
            start: start.toISOString(),
            minutes,
          },
        });
        return out;
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return false; // another worker (or an earlier sweep) already did
      throw e;
    }
    const settings = (await this.views.settingsOf([userId])).get(userId)!;
    if (told.length && settings.emailReminders) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, displayName: true, locale: true },
      });
      if (user)
        void this.mail.sendMeetingReminder(
          user.email,
          user.displayName,
          (user.locale === 'pt' ? 'pt' : 'en') as Locale,
          title,
          when(user.locale, start, row.allDay, tz ?? row.timezone),
        );
    }
    return true;
  }

  /** Old delivery records, and the tombstones of cancelled events that every device has had time to hear about. */
  async purge(now = new Date()): Promise<number> {
    const done = await this.prisma.reminderDelivery.deleteMany({
      where: { occurrenceStart: { lt: new Date(now.getTime() - 2 * DAY) } },
    });
    const gone = await this.prisma.event.deleteMany({
      where: { deletedAt: { not: null, lt: new Date(now.getTime() - EVENT_TOMBSTONE_DAYS * DAY) } },
    });
    return done.count + gone.count;
  }
}
