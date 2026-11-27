import { z } from 'zod';
import { idSchema } from './common';

// Calendar and meetings (phase 13). The runtime part (schemas, limits, recurrence) is the separate entry
// `@os-planner/shared/calendar`; the main entry only exports the types, so the website's first load does not carry them.

// ---------------------------------------------------------------- limits and enums

export const CALENDAR_LIMITS = {
  titleMax: 200,
  /** Markdown. */
  descriptionMax: 10_000,
  locationMax: 300,
  urlMax: 500,
  /** People (and roles) who can be named on one event. The plan's cap on a mass invite. */
  usersPerEvent: 500,
  rolesPerEvent: 10,
  /** Changed or cancelled occurrences one series keeps. */
  exceptionsPerEvent: 500,
  /** Own reminders one person keeps on one event, and how far ahead the earliest may be (a week: what the hourly sweep looks at). */
  remindersPerEvent: 5,
  reminderMaxMinutes: 10_080,
  /** Longest window one calendar request may ask for (two years), and the most entries it returns. */
  windowDays: 731,
  itemsPerRequest: 5000,
  /** Events a space keeps that are not in the trash. */
  eventsPerSpace: 20_000,
  /** An event may be this long (a year). */
  maxDurationDays: 366,
  /** Most spaces one calendar request names. */
  spacesPerRequest: 200,
} as const;

export const EVENT_KINDS = ['meeting', 'event'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** Who may see an event: its attendees (the default), or everybody who can see the calendar of the space. */
export const EVENT_VISIBILITIES = ['attendees', 'space'] as const;
export type EventVisibility = (typeof EVENT_VISIBILITIES)[number];

export const RSVP_STATUSES = ['invited', 'accepted', 'declined', 'tentative'] as const;
export type RsvpStatus = (typeof RSVP_STATUSES)[number];
/** What a person can answer. */
export const RSVP_ANSWERS = ['accepted', 'declined', 'tentative'] as const;
export type RsvpAnswer = (typeof RSVP_ANSWERS)[number];

export const ATTENDEE_KINDS = ['user', 'role'] as const;
export type AttendeeKind = (typeof ATTENDEE_KINDS)[number];

/** Which occurrences of a recurring event a change is for. */
export const EDIT_SCOPES = ['this', 'following', 'all'] as const;
export type EditScope = (typeof EDIT_SCOPES)[number];

export const WEEK_STARTS = [0, 1, 6] as const;

// ---------------------------------------------------------------- responses

/** What an exception of a series changes (all optional: what is missing stays as the series has it). */
export interface EventOverrideDto {
  title?: string;
  description?: string;
  location?: string | null;
  videoUrl?: string | null;
  startAt?: string;
  endAt?: string;
}

/** One occurrence of a series that was cancelled or changed. `originalStart` is the instant it would have started at. */
export interface EventExceptionDto {
  originalStart: string;
  kind: 'cancelled' | 'override';
  override?: EventOverrideDto;
}

/** How the person is on the event. */
export interface MyAttendanceDto {
  status: RsvpStatus;
  /** Who put it on their calendar (null for an event they made or one whose author left). */
  addedBy: string | null;
  addedByName: string | null;
  /** Named themselves or by role; the owner of the event. */
  via: 'user' | 'role' | 'owner';
  optional: boolean;
}

export interface RsvpCountsDto {
  invited: number;
  accepted: number;
  declined: number;
  tentative: number;
}

export interface EventDto {
  id: string;
  /** The space the event belongs to: the person's own space for a personal event. */
  spaceId: string;
  ownerId: string | null;
  ownerName: string | null;
  kind: EventKind;
  title: string;
  /** Markdown. */
  description: string;
  location: string | null;
  videoUrl: string | null;
  /** A voice channel (phase 16) that is the place of the meeting. */
  linkedChannelId: string | null;
  /** The first occurrence: an instant (ISO). For an all-day event: 00:00 UTC of the first day. */
  startAt: string;
  /** End of the first occurrence (exclusive; for all-day: 00:00 UTC of the day after the last). */
  endAt: string;
  allDay: boolean;
  /** IANA zone whose wall clock the recurrence follows (`UTC` for all-day events). */
  timezone: string;
  /** Canonical RRULE text (`FREQ=WEEKLY;BYDAY=MO`), null when it does not repeat. */
  rrule: string | null;
  visibility: EventVisibility;
  exceptions: EventExceptionDto[];
  /** People and roles named on the event. */
  attendeeCount: number;
  counts: RsvpCountsDto;
  /** The person's own place on it; null when they only see it because the space shows it. */
  me: MyAttendanceDto | null;
  seq: number;
  /** Merge field → seq at which it last changed (phase 15); absent for an entity nobody changed since it was made. */
  fieldSeq?: Record<string, number>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface AttendeeDto {
  kind: AttendeeKind;
  subjectId: string;
  /** The person's name, or the role's. */
  name: string;
  status: RsvpStatus;
  respondedAt: string | null;
  addedBy: string | null;
  addedByName: string | null;
  optional: boolean;
  /** For a role: how many of its members can see the event. */
  memberCount?: number;
}

/** `GET /api/events/:id`. */
export interface EventDetailDto {
  event: EventDto;
  attendees: AttendeeDto[];
  /** The person may change the event (owner, or MANAGE_MEETINGS). */
  canEdit: boolean;
  /** The person may name others (ADD_TO_MEMBER_CALENDARS; personal events have nobody to name). */
  canInvite: boolean;
  /** The reminders the person set on it (minutes before), null when they use their defaults. */
  reminders: number[] | null;
  spaceName: string;
}

/** One entry of the calendar: an occurrence of an event, or a task with a date. */
export interface CalendarItemDto {
  source: 'event' | 'task' | 'external';
  /** The event id, the task id, or the id of an event of a followed calendar. */
  id: string;
  /** Unique per entry: `<id>@<originalStart>` for an occurrence, the id for a task. */
  key: string;
  spaceId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  /** Events: the instant this occurrence would have started at without a change (the key of its exception). */
  originalStart?: string;
  recurring?: boolean;
  kind?: EventKind;
  location?: string | null;
  rsvp?: RsvpStatus | null;
  /** True when it overlaps another entry of the person that they have not declined. */
  conflict?: boolean;
  /** Tasks. */
  completed?: boolean;
  boardId?: string;
  /** Followed calendars (phase 14): which one, its colour and name, the event's own page, and the start of its description. */
  calendarId?: string;
  color?: string;
  sourceName?: string;
  url?: string | null;
  note?: string;
}

/** `GET /api/calendar`. */
export interface CalendarDto {
  from: string;
  to: string;
  items: CalendarItemDto[];
  /** More occurrences matched than `CALENDAR_LIMITS.itemsPerRequest`: the list was cut. */
  truncated: boolean;
}

/** `GET /api/calendar-permissions`: what the person may do in each space whose calendar they can see (decimal strings). */
export interface CalendarPermissionsDto {
  spaces: Record<string, string>;
}

/** Who can be named on an event in a space (`GET /api/spaces/:id/calendar-people`). */
export interface CalendarPeopleDto {
  users: {
    userId: string;
    displayName: string;
    /** The person has chosen to be put on calendars by anyone who can see the space's. */ open: boolean;
  }[];
  roles: { id: string; name: string; memberCount: number }[];
}

export interface CalendarSettingsDto {
  /** The zone new events start in; null: the one of the device. */
  defaultTz: string | null;
  /** 0 Sunday, 1 Monday, 6 Saturday. */
  weekStart: 0 | 1 | 6;
  /** Minutes before the start, for every event the person attends and has not set reminders on. */
  defaultReminders: number[];
  /** Spaces whose entries are hidden on the person's calendar (the colour toggles). Kept for their other devices. */
  hiddenSpaces: string[];
  /** Anyone who can see a space's calendar may put the person on an event there (without ADD_TO_MEMBER_CALENDARS). */
  openInvites: boolean;
  /** Also send reminders by email. */
  emailReminders: boolean;
}

// ---------------------------------------------------------------- bodies

const isoSchema = z.iso.datetime({ offset: true });
const text = (max: number) => z.string().max(max);
const url = z
  .string()
  .trim()
  .max(CALENDAR_LIMITS.urlMax)
  .refine((v) => /^https?:\/\/[^\s]+$/i.test(v), 'url');
const timezone = z.string().min(1).max(64);

export const attendeeInputSchema = z.object({
  kind: z.enum(ATTENDEE_KINDS),
  subjectId: idSchema,
  optional: z.boolean().optional(),
});
export type AttendeeInput = z.infer<typeof attendeeInputSchema>;

const eventFields = {
  kind: z.enum(EVENT_KINDS),
  title: z.string().trim().min(1).max(CALENDAR_LIMITS.titleMax),
  description: text(CALENDAR_LIMITS.descriptionMax),
  location: text(CALENDAR_LIMITS.locationMax).nullable(),
  videoUrl: url.nullable(),
  linkedChannelId: idSchema.nullable(),
  startAt: isoSchema,
  endAt: isoSchema,
  allDay: z.boolean(),
  timezone,
  /** RRULE text, null for a single event. */
  rrule: text(400).nullable(),
  visibility: z.enum(EVENT_VISIBILITIES),
};

export const createEventSchema = z.object({
  id: idSchema,
  /** Where it goes: a team or project space, or the person's own. */
  spaceId: idSchema,
  ...z.object(eventFields).partial().required({ title: true, startAt: true, endAt: true }).shape,
  attendees: z
    .array(attendeeInputSchema)
    .max(CALENDAR_LIMITS.usersPerEvent + CALENDAR_LIMITS.rolesPerEvent)
    .optional(),
  /** The person's own reminders on it (minutes before); left out: their defaults. */
  reminders: z
    .array(z.number().int().min(0).max(CALENDAR_LIMITS.reminderMaxMinutes))
    .max(CALENDAR_LIMITS.remindersPerEvent)
    .optional(),
});
export type CreateEventInput = z.infer<typeof createEventSchema>;

export const updateEventSchema = z.object({
  ...z.object(eventFields).partial().shape,
  scope: z.enum(EDIT_SCOPES).default('all'),
  /** For `this` and `following`: the occurrence meant (its `originalStart`). */
  occurrence: isoSchema.optional(),
});
export type UpdateEventInput = z.input<typeof updateEventSchema>;
export type UpdateEventBody = z.infer<typeof updateEventSchema>;

export const cancelEventSchema = z.object({
  scope: z.enum(EDIT_SCOPES).default('all'),
  occurrence: isoSchema.optional(),
});
export type CancelEventInput = z.input<typeof cancelEventSchema>;

export const rsvpSchema = z.object({
  status: z.enum(RSVP_ANSWERS),
  /** Only `all` for now: the answer is for the whole series. */
  scope: z.enum(EDIT_SCOPES).default('all'),
});
export type RsvpInput = z.input<typeof rsvpSchema>;

export const addAttendeesSchema = z.object({
  attendees: z
    .array(attendeeInputSchema)
    .min(1)
    .max(CALENDAR_LIMITS.usersPerEvent + CALENDAR_LIMITS.rolesPerEvent),
});
export type AddAttendeesInput = z.infer<typeof addAttendeesSchema>;

export const duplicateEventSchema = z.object({
  id: idSchema,
  startAt: isoSchema.optional(),
  endAt: isoSchema.optional(),
  spaceId: idSchema.optional(),
});
export type DuplicateEventInput = z.infer<typeof duplicateEventSchema>;

export const remindersSchema = z.object({
  /** Minutes before the start; null goes back to the person's defaults. */
  minutes: z
    .array(z.number().int().min(0).max(CALENDAR_LIMITS.reminderMaxMinutes))
    .max(CALENDAR_LIMITS.remindersPerEvent)
    .nullable(),
});
export type RemindersInput = z.infer<typeof remindersSchema>;

export const calendarQuerySchema = z.object({
  from: isoSchema,
  to: isoSchema,
  /** Comma-separated space ids; left out: every space the person can see. */
  spaces: z
    .string()
    .max(CALENDAR_LIMITS.spacesPerRequest * 37)
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : undefined))
    .pipe(z.array(idSchema).max(CALENDAR_LIMITS.spacesPerRequest).optional()),
  /** Comma-separated: `tasks`, `meetings`, `events`, `external` (followed calendars). Left out: all four. */
  include: z
    .string()
    .max(60)
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : ['tasks', 'meetings', 'events', 'external']))
    .pipe(z.array(z.enum(['tasks', 'meetings', 'events', 'external'])).max(4)),
  /** Also list entries of events the person declined. */
  declined: z.enum(['true', 'false']).optional(),
});
export type CalendarQuery = z.infer<typeof calendarQuerySchema>;

export const calendarSettingsSchema = z
  .object({
    defaultTz: timezone.nullable(),
    weekStart: z.union([z.literal(0), z.literal(1), z.literal(6)]),
    defaultReminders: z
      .array(z.number().int().min(0).max(CALENDAR_LIMITS.reminderMaxMinutes))
      .max(CALENDAR_LIMITS.remindersPerEvent),
    hiddenSpaces: z.array(idSchema).max(500),
    openInvites: z.boolean(),
    emailReminders: z.boolean(),
  })
  .partial();
export type UpdateCalendarSettingsInput = z.infer<typeof calendarSettingsSchema>;
