import { z } from 'zod';
import { idSchema } from './common';

// ICS feeds, external calendars and import (phase 14). The runtime part (schemas, limits, the ICS parser and writer) is the separate
// entry `@os-planner/shared/ics`; the main entry only exports the types.

export const ICS_LIMITS = {
  /** Largest calendar file taken in (a subscribed feed or an import). */
  maxBytes: 5 * 1024 * 1024,
  /** Most events one file may hold; more is refused. */
  maxEvents: 20_000,
  /** Most events one import creates. */
  importEvents: 1000,
  /** Feeds and subscriptions one person keeps. */
  feedsPerUser: 10,
  externalPerUser: 10,
  nameMax: 80,
  urlMax: 2000,
  /** A calendar can be refreshed by hand this often. */
  refreshCooldownSeconds: 300,
  fetchTimeoutMs: 20_000,
  maxRedirects: 3,
  /** Shortest and longest time between two automatic refreshes. */
  syncMinMinutes: 15,
  syncMaxMinutes: 10_080,
  syncDefaultMinutes: 60,
  /** A subscription that fails this long without one success is switched off. */
  disableAfterDays: 14,
  /** What a feed holds: events that ended up to this many days ago, and at most this many entries. */
  feedPastDays: 90,
  feedItems: 5000,
} as const;

/** What the person chose to put in a feed. */
export interface FeedIncludeDto {
  /** Spaces to take from (only those the person can still see count); null = every one. */
  spaces: string[] | null;
  /** Tasks that have a date (as events). */
  tasks: boolean;
  meetings: boolean;
  events: boolean;
  /** Also events the person declined. */
  declined: boolean;
}

export interface CalendarFeedDto {
  id: string;
  name: string;
  include: FeedIncludeDto;
  /** The last characters of the secret (the rest is never kept). */
  tokenHint: string;
  createdAt: string;
  rotatedAt: string | null;
  lastFetchedAt: string | null;
  fetchCount: number;
}

/** Creating or renewing a feed: the only time the address is shown. */
export interface CalendarFeedSecretDto extends CalendarFeedDto {
  url: string;
}

export interface ExternalCalendarDto {
  id: string;
  name: string;
  /** As the person typed it (it may hold a secret of the other service: shown to the owner only). */
  url: string;
  color: string;
  enabled: boolean;
  syncEveryMinutes: number;
  lastSyncAt: string | null;
  /** The code of the last refusal (`ics_*`), null after a good refresh. */
  lastError: string | null;
  failingSince: string | null;
  /** Why it was switched off by the server (`failing_too_long`), null when it was not. */
  disabledReason: string | null;
  eventCount: number;
  createdAt: string;
}

export interface IcsImportItemDto {
  uid: string;
  title: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  recurring: boolean;
  /** Changed or cancelled occurrences inside the series. */
  exceptions: number;
  /** An event with this UID is already in the space (an earlier import). */
  duplicate: boolean;
  /** The repeat rule had parts this calendar cannot keep and was simplified. */
  simplified: boolean;
}

export interface IcsImportPreviewDto {
  mode: 'preview';
  spaceId: string;
  items: IcsImportItemDto[];
  /** Parts of the file that are not events (to-dos, journals...), by kind, with how many. */
  unsupported: { component: string; count: number }[];
  /** Entries that were broken and left out. */
  skipped: number;
  /** The file held more events than one import takes. */
  truncated: boolean;
}

export interface IcsImportResultDto {
  mode: 'commit';
  spaceId: string;
  created: number;
  duplicates: number;
  skipped: number;
}

/** Error codes of this phase (the server's message; the website shows `ics.error.<code>`). */
export const ICS_ERRORS = [
  'ics_bad_url',
  'ics_blocked_address',
  'ics_unreachable',
  'ics_timeout',
  'ics_too_large',
  'ics_not_a_calendar',
  'ics_too_many_events',
  'ics_too_many_redirects',
  'ics_http_error',
  'ics_quota',
  'ics_parse_timeout',
  'refresh_too_soon',
  'too_many_feeds',
  'too_many_calendars',
  'no_file',
  'no_events',
] as const;
export type IcsError = (typeof ICS_ERRORS)[number];

// ---------------------------------------------------------------- bodies

const feedName = z.string().trim().min(1).max(ICS_LIMITS.nameMax);

export const feedIncludeSchema = z.object({
  spaces: z.array(idSchema).max(200).nullable(),
  tasks: z.boolean(),
  meetings: z.boolean(),
  events: z.boolean(),
  declined: z.boolean(),
});

export const DEFAULT_FEED_INCLUDE: FeedIncludeDto = {
  spaces: null,
  tasks: true,
  meetings: true,
  events: true,
  declined: false,
};

export const createFeedSchema = z.object({
  name: feedName,
  include: feedIncludeSchema.partial().optional(),
});
export type CreateFeedInput = z.infer<typeof createFeedSchema>;

export const updateFeedSchema = z.object({
  name: feedName.optional(),
  include: feedIncludeSchema.partial().optional(),
});
export type UpdateFeedInput = z.infer<typeof updateFeedSchema>;

const colour = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const createExternalSchema = z.object({
  name: z.string().trim().min(1).max(ICS_LIMITS.nameMax),
  url: z.string().trim().min(1).max(ICS_LIMITS.urlMax),
  color: colour.default('#6b7280'),
  syncEveryMinutes: z
    .number()
    .int()
    .min(ICS_LIMITS.syncMinMinutes)
    .max(ICS_LIMITS.syncMaxMinutes)
    .default(ICS_LIMITS.syncDefaultMinutes),
});
export type CreateExternalInput = z.input<typeof createExternalSchema>;

export const updateExternalSchema = z.object({
  name: z.string().trim().min(1).max(ICS_LIMITS.nameMax).optional(),
  color: colour.optional(),
  enabled: z.boolean().optional(),
  syncEveryMinutes: z
    .number()
    .int()
    .min(ICS_LIMITS.syncMinMinutes)
    .max(ICS_LIMITS.syncMaxMinutes)
    .optional(),
});
export type UpdateExternalInput = z.infer<typeof updateExternalSchema>;

/** The text fields that come with the uploaded file of an import. */
export const importFieldsSchema = z.object({
  mode: z.enum(['preview', 'commit']).default('preview'),
  spaceId: idSchema.optional(),
  /** JSON array of the UIDs to take (commit); left out: all of them. */
  uids: z
    .string()
    .max(200_000)
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return undefined;
      try {
        const parsed = z
          .array(z.string().max(255))
          .max(ICS_LIMITS.importEvents)
          .safeParse(JSON.parse(v));
        if (parsed.success) return parsed.data;
      } catch {
        // falls through to the issue
      }
      ctx.addIssue({ code: 'custom', message: 'invalid_uids' });
      return z.NEVER;
    }),
});
export type ImportFields = z.infer<typeof importFieldsSchema>;

/** `GET /api/calendar/export`. */
export const exportQuerySchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  spaces: z
    .string()
    .max(200 * 37)
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : undefined))
    .pipe(z.array(idSchema).max(200).optional()),
});
export type ExportQuery = z.infer<typeof exportQuerySchema>;
