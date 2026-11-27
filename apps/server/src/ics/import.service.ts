import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import {
  Permission,
  type IcsImportItemDto,
  type IcsImportPreviewDto,
  type IcsImportResultDto,
} from '@os-planner/shared';
import { normalizeTiming } from '@os-planner/shared/calendar';
import {
  ICS_LIMITS,
  IcsParseError,
  exceptionsOf,
  parseIcs,
  type IcsSeries,
  type ImportFields,
} from '@os-planner/shared/ics';
import { CalendarViews } from '../calendar/calendar-views.service.js';
import { EventsService } from '../calendar/events.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PermissionService } from '../spaces/permission.service.js';

const ATTENDEES_LABEL: Record<string, string> = { en: 'Attendees', pt: 'Participantes' };

/**
 * Taking a calendar file into the person's calendar: first a preview (what is in it, what is already there), then the events they
 * keep. Only text comes in: no attachments, nobody is invited, no address of an attendee is kept.
 */
@Injectable()
export class IcsImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionService,
    private readonly events: EventsService,
    private readonly views: CalendarViews,
  ) {}

  async run(
    userId: string,
    file: Buffer | undefined,
    fields: ImportFields,
  ): Promise<IcsImportPreviewDto | IcsImportResultDto> {
    if (!file?.length) throw new UnprocessableEntityException('no_file');
    // Where it goes: a team or project space needs CREATE_MEETINGS there; the person's own space is always theirs.
    const spaceId =
      fields.spaceId ??
      (await this.prisma.space.findUniqueOrThrow({ where: { userId }, select: { id: true } })).id;
    const space = await this.perms.requireCalendarSpace(
      userId,
      spaceId,
      Permission.CREATE_MEETINGS,
    );

    const settings = await this.views.settings(userId);
    let parsed;
    try {
      parsed = parseIcs(
        file.toString('utf8'),
        settings.defaultTz ? { defaultZone: settings.defaultTz } : {},
      );
    } catch (e) {
      if (e instanceof IcsParseError) throw new UnprocessableEntityException(e.code);
      throw e;
    }
    if (!parsed.series.length) throw new UnprocessableEntityException('no_events');

    const truncated = parsed.series.length > ICS_LIMITS.importEvents;
    const series = parsed.series.slice(0, ICS_LIMITS.importEvents);
    const known = new Set(
      (
        await this.prisma.event.findMany({
          where: {
            spaceId: space.space.id,
            deletedAt: null,
            icsUid: { in: series.map((s) => s.uid) },
          },
          select: { icsUid: true },
        })
      ).map((e) => e.icsUid),
    );

    if (fields.mode === 'preview') {
      return {
        mode: 'preview',
        spaceId: space.space.id,
        items: series.map((s) => this.item(s, known.has(s.uid))),
        unsupported: parsed.unsupported,
        skipped: parsed.skipped,
        truncated,
      };
    }

    const wanted = fields.uids ? new Set(fields.uids) : null;
    const label =
      ATTENDEES_LABEL[
        (await this.prisma.user.findUnique({ where: { id: userId }, select: { locale: true } }))
          ?.locale ?? 'en'
      ] ?? 'Attendees';
    let created = 0;
    let duplicates = 0;
    let skipped = parsed.skipped;
    for (const s of series) {
      if (wanted && !wanted.has(s.uid)) continue;
      const r = await this.events.createImported(userId, space.space.id, s, label);
      if (r === 'created') created++;
      else if (r === 'duplicate') duplicates++;
      else skipped++;
    }
    return { mode: 'commit', spaceId: space.space.id, created, duplicates, skipped };
  }

  private item(s: IcsSeries, duplicate: boolean): IcsImportItemDto {
    const m = s.master;
    const timing = normalizeTiming({
      startAt: m.startAt,
      endAt: m.endAt,
      allDay: m.allDay,
      timezone: m.timezone,
      rrule: m.rrule,
    });
    return {
      uid: m.uid,
      title: m.title,
      startAt: m.startAt,
      endAt: m.endAt,
      allDay: m.allDay,
      recurring: timing.ok ? !!timing.value.rrule : false,
      exceptions: exceptionsOf(s).length,
      duplicate,
      simplified: m.simplified,
    };
  }
}
