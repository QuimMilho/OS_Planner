import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import {
  idSchema,
  type AddAttendeesInput,
  type CalendarDto,
  type CalendarPeopleDto,
  type CalendarPermissionsDto,
  type CalendarSettingsDto,
  type CancelEventInput,
  type CreateEventInput,
  type DuplicateEventInput,
  type EventDetailDto,
  type EventDto,
  type RemindersInput,
  type RsvpInput,
  type UpdateCalendarSettingsInput,
  type UpdateEventInput,
} from '@os-planner/shared';
import {
  CALENDAR_LIMITS,
  addAttendeesSchema,
  calendarQuerySchema,
  calendarSettingsSchema,
  cancelEventSchema,
  createEventSchema,
  duplicateEventSchema,
  remindersSchema,
  rsvpSchema,
  updateEventSchema,
  type CalendarQuery,
} from '@os-planner/shared/calendar';
import { exportQuerySchema, type ExportQuery } from '@os-planner/shared/ics';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../common/auth.decorators.js';
import { CalendarViews } from './calendar-views.service.js';
import { EventsService } from './events.service.js';
import { IcsExporter } from './ics-export.js';
import { invalid } from '../tree/tree.error.js';
import { Authz } from '../common/authz.js';

const Id = () => Param('id', { schema: idSchema });

/** Sends a calendar file as a download. */
function sendFile(res: Response, name: string, text: string): void {
  const ascii = name.normalize('NFKD').replace(/[^ -~]/g, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'calendar';
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${ascii}.ics"; filename*=UTF-8''${encodeURIComponent(name.slice(0, 80))}.ics`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(text);
}
const attendeeKind = z.enum(['user', 'role']);

/** The calendar, events, answers and settings. An event the person cannot see answers 404 to all of these. */
@Controller()
export class CalendarController {
  constructor(
    private readonly events: EventsService,
    private readonly views: CalendarViews,
    private readonly ics: IcsExporter,
  ) {}

  @Authz({ scope: 'self' })
  @Get('calendar-permissions')
  permissions(@CurrentUser() u: AuthUser): Promise<CalendarPermissionsDto> {
    return this.views.permissions(u.id);
  }

  @Authz({ scope: 'self', note: 'only what the person can see' })
  @Get('calendar')
  calendar(
    @CurrentUser() u: AuthUser,
    @Query({ schema: calendarQuerySchema }) q: CalendarQuery,
  ): Promise<CalendarDto> {
    return this.views.calendar(u.id, q);
  }

  @Authz({ scope: 'calendar' })
  @Get('spaces/:id/calendar-people')
  people(@CurrentUser() u: AuthUser, @Id() spaceId: string): Promise<CalendarPeopleDto> {
    return this.views.people(u.id, spaceId);
  }

  @Authz({ scope: 'self' })
  @Get('me/calendar-settings')
  settings(@CurrentUser() u: AuthUser): Promise<CalendarSettingsDto> {
    return this.views.settings(u.id);
  }

  @Authz({ scope: 'self' })
  @Put('me/calendar-settings')
  updateSettings(
    @CurrentUser() u: AuthUser,
    @Body({ schema: calendarSettingsSchema }) body: UpdateCalendarSettingsInput,
  ): Promise<CalendarSettingsDto> {
    return this.views.updateSettings(u.id, body);
  }

  // ---- files (phase 14). Declared before `events/:id`, which would otherwise take "<id>.ics" for an id.

  /** What the person's calendar shows between two dates, as a calendar file to download (events and tasks with dates). */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Authz({ scope: 'self', note: 'only what the person can see' })
  @Get('calendar/export')
  async exportRange(
    @CurrentUser() u: AuthUser,
    @Query({ schema: exportQuerySchema }) q: ExportQuery,
    @Res() res: Response,
  ): Promise<void> {
    const from = q.from ? new Date(q.from) : new Date();
    const to = q.to ? new Date(q.to) : new Date(from.getTime() + 365 * 86_400_000);
    if (!(to > from)) throw invalid('window_invalid');
    if (to.getTime() - from.getTime() > CALENDAR_LIMITS.windowDays * 86_400_000) throw invalid('window_too_large');
    const { events } = await this.ics.entries(u.id, {
      spaces: q.spaces,
      meetings: true,
      events: true,
      tasks: true,
      declined: false,
      from,
      to,
    });
    sendFile(res, 'calendar', this.ics.render('OS_Planner', events));
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Authz({ scope: 'calendar' })
  @Get('events/:id.ics')
  async eventFile(@CurrentUser() u: AuthUser, @Id() id: string, @Res() res: Response): Promise<void> {
    const file = await this.ics.single(u.id, id);
    sendFile(res, file.name, file.text);
  }

  // ---- events

  @Authz({ scope: 'calendar', needs: ['CREATE_MEETINGS'], note: "the space is in the body; in one's own space nothing is needed" })
  @Post('events')
  create(
    @CurrentUser() u: AuthUser,
    @Body({ schema: createEventSchema }) body: CreateEventInput,
  ): Promise<EventDto> {
    return this.events.create(u.id, body);
  }

  @Authz({ scope: 'calendar' })
  @Get('events/:id')
  one(@CurrentUser() u: AuthUser, @Id() id: string): Promise<EventDetailDto> {
    return this.events.detail(u.id, id);
  }

  /** `scope` says which occurrences of a repeating event: `this` (with `occurrence`), `following` (same) or `all`. */
  @Authz({ scope: 'calendar', needs: ['MANAGE_MEETINGS'], author: 'or' })
  @Patch('events/:id')
  update(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: updateEventSchema }) body: UpdateEventInput,
  ): Promise<EventDto> {
    return this.events.update(u.id, id, body);
  }

  @Authz({ scope: 'calendar', needs: ['MANAGE_MEETINGS'], author: 'or' })
  @Delete('events/:id')
  @HttpCode(204)
  async cancel(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Query({ schema: cancelEventSchema }) q: CancelEventInput,
  ): Promise<void> {
    await this.events.cancel(u.id, id, q);
  }

  @Authz({ scope: 'calendar', needs: ['CREATE_MEETINGS'] })
  @Post('events/:id/duplicate')
  duplicate(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: duplicateEventSchema }) body: DuplicateEventInput,
  ): Promise<EventDto> {
    return this.events.duplicate(u.id, id, body);
  }

  @Authz({ scope: 'calendar', author: 'only', note: 'the people the event is for, and its maker' })
  @Post('events/:id/rsvp')
  @HttpCode(200)
  rsvp(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: rsvpSchema }) body: RsvpInput,
  ): Promise<EventDto> {
    return this.events.rsvp(u.id, id, body);
  }

  @Authz({ scope: 'calendar', needs: ['MANAGE_MEETINGS'], author: 'or' })
  @Post('events/:id/attendees')
  @HttpCode(200)
  addAttendees(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: addAttendeesSchema }) body: AddAttendeesInput,
  ): Promise<EventDetailDto> {
    return this.events.addAttendees(u.id, id, body);
  }

  @Authz({ scope: 'calendar', needs: ['MANAGE_MEETINGS'], author: 'or' })
  @Delete('events/:id/attendees/:kind/:subjectId')
  removeAttendee(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Param('kind', { schema: attendeeKind }) kind: 'user' | 'role',
    @Param('subjectId', { schema: idSchema }) subjectId: string,
  ): Promise<EventDetailDto> {
    return this.events.removeAttendee(u.id, id, kind, subjectId);
  }

  @Authz({ scope: 'calendar', note: "the caller's own reminders" })
  @Put('events/:id/reminders')
  reminders(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: remindersSchema }) body: RemindersInput,
  ): Promise<{ reminders: number[] | null }> {
    return this.events.setReminders(u.id, id, body);
  }
}
