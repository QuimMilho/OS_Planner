import { z } from 'zod';
import { idSchema } from './common';

// Notifications (phase 9): settings with inheritance, the inbox, Web Push and the per-chat email option.

export const NOTIFY_LIMITS = {
  /** Notifications in one page of the inbox. */
  pageMax: 100,
  pageDefault: 50,
  /** Notifications are removed after this many days. */
  retentionDays: 90,
  /** `@everyone` in a team with more people than this is refused. */
  everyoneMaxMembers: 5000,
  /** Push subscriptions (devices) per person. */
  devicesMax: 10,
  /** Settings rows per person. */
  settingsMax: 2000,
  /** The last messages an email lists. */
  mailMessages: 5,
} as const;

export const SCOPE_KINDS = ['global', 'team', 'project', 'channel', 'dm'] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];
export const scopeKindSchema = z.enum(SCOPE_KINDS);

export const NOTIFY_LEVELS = ['all', 'mentions', 'none', 'inherit'] as const;
export type NotifyLevel = (typeof NOTIFY_LEVELS)[number];
export const EMAIL_MODES = ['off', 'mentions', 'all', 'inherit'] as const;
export type EmailMode = (typeof EMAIL_MODES)[number];

/** `mutedUntil` far in the future means "until turned back on". */
export const MUTED_FOREVER = '9999-12-31T23:59:59.000Z';
/** The mute presets of the UI, in minutes (null: until turned back on). The API takes any future time. */
export const MUTE_PRESET_MINUTES = [15, 60, 180, 480, 1440, null] as const;

export const NOTIFICATION_KINDS = [
  'mention_user',
  'mention_role',
  'mention_everyone',
  'mention_here',
  'dm',
  'reply',
  'invite',
  'task_assigned',
  'task_due',
  'task_comment',
  'meeting_invite',
  'meeting_reminder',
  'meeting_updated',
  'meeting_cancelled',
  'meeting_response',
  'join_request',
  'calendar_sync_off',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
/** The kinds that count as "mentions" in the inbox filter and the badges. */
export const MENTION_KINDS_OF_NOTIFICATIONS: readonly NotificationKind[] = [
  'mention_user',
  'mention_role',
  'mention_everyone',
  'mention_here',
  'reply',
];

// ---------------------------------------------------------------- settings

export interface NotificationSettingDto {
  id: string;
  scopeKind: ScopeKind;
  /** Null for `global`. */
  scopeId: string | null;
  level: NotifyLevel;
  suppressEveryone: boolean | null;
  suppressRoles: boolean | null;
  suppressDirect: boolean | null;
  /** ISO time the mute ends; null when not muted (a time in the past is an explicit un-mute). */
  mutedUntil: string | null;
  email: EmailMode;
  emailOnlyWhenAway: boolean | null;
  push: boolean | null;
  updatedAt: string;
}

const scopeFields = {
  scopeKind: scopeKindSchema,
  scopeId: idSchema.nullish(),
};
const refineScope = <T extends z.ZodType<{ scopeKind: ScopeKind; scopeId?: string | null }>>(
  schema: T,
) =>
  schema.refine(
    (v) => (v.scopeKind === 'global' ? !v.scopeId : Boolean(v.scopeId)),
    'scopeId is required for every scope but global',
  );

export const putSettingSchema = refineScope(
  z.object({
    ...scopeFields,
    level: z.enum(NOTIFY_LEVELS).optional(),
    suppressEveryone: z.boolean().nullable().optional(),
    suppressRoles: z.boolean().nullable().optional(),
    suppressDirect: z.boolean().nullable().optional(),
    mutedUntil: z.iso.datetime().nullable().optional(),
    email: z.enum(EMAIL_MODES).optional(),
    emailOnlyWhenAway: z.boolean().nullable().optional(),
    push: z.boolean().nullable().optional(),
  }),
);
export type PutSettingInput = z.infer<typeof putSettingSchema>;

export const muteSchema = refineScope(
  z.object({
    ...scopeFields,
    /** A future time, or null to turn the mute off. */
    until: z.iso.datetime().nullable(),
  }),
);
export type MuteInput = z.infer<typeof muteSchema>;

export const effectiveQuerySchema = refineScope(
  z.object({
    scopeKind: scopeKindSchema,
    scopeId: idSchema.optional(),
  }),
);

/** Where a value of an effective setting comes from: a scope, or the built-in default. */
export interface SettingSource {
  scopeKind: ScopeKind | 'default';
  scopeId: string | null;
}

export interface EffectiveSettingDto {
  level: Exclude<NotifyLevel, 'inherit'>;
  muted: boolean;
  mutedUntil: string | null;
  suppressEveryone: boolean;
  suppressRoles: boolean;
  suppressDirect: boolean;
  email: Exclude<EmailMode, 'inherit'>;
  emailOnlyWhenAway: boolean;
  push: boolean;
  sources: Record<
    | 'level'
    | 'mute'
    | 'suppressEveryone'
    | 'suppressRoles'
    | 'suppressDirect'
    | 'email'
    | 'emailOnlyWhenAway'
    | 'push',
    SettingSource
  >;
}

// ---------------------------------------------------------------- quiet hours

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const quietHoursSchema = z.object({
  enabled: z.boolean(),
  /** Local time, "HH:MM". The window may run past midnight (22:00 to 07:00). */
  from: hhmm,
  to: hhmm,
  /** 0 = Sunday ... 6 = Saturday: the day the window starts on. */
  days: z.array(z.number().int().min(0).max(6)).max(7),
  /** IANA time zone of the person, e.g. "Europe/Lisbon". */
  timeZone: z.string().min(1).max(64),
});
export type QuietHoursDto = z.infer<typeof quietHoursSchema>;

// ---------------------------------------------------------------- inbox

export interface NotificationDto {
  id: string;
  kind: NotificationKind;
  actorId: string | null;
  actorName: string | null;
  /** Team the notification belongs to (for the rail badge), when it has one. */
  teamId: string | null;
  channelId: string | null;
  channelName: string | null;
  messageId: string | null;
  targetKind: string | null;
  targetId: string | null;
  /** The start of the message, or a generic text for a channel that hides previews. */
  summary: string;
  /** True when `summary` is not the message (previews are hidden in that channel). */
  redacted: boolean;
  read: boolean;
  createdAt: string;
}

export interface NotificationPageDto {
  items: NotificationDto[];
  nextCursor: string | null;
}

export const listNotificationsSchema = z.object({
  cursor: z.string().max(120).optional(),
  unread: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Only mentions (and replies), as in the inbox filter. */
  mentions: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(NOTIFY_LIMITS.pageMax)
    .default(NOTIFY_LIMITS.pageDefault),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsSchema>;

export const readNotificationsSchema = z
  .object({
    ids: z.array(idSchema).min(1).max(200).optional(),
    all: z.literal(true).optional(),
    /** With `all`: only what is older than this time. */
    before: z.iso.datetime().optional(),
  })
  .refine((v) => (v.ids ? 1 : 0) + (v.all ? 1 : 0) === 1, 'give ids or all');
export type ReadNotificationsInput = z.infer<typeof readNotificationsSchema>;

export interface NotificationCountDto {
  /** Unread notifications. */
  unread: number;
  /** Of those, mentions and replies. */
  mentions: number;
  /** Unread by team (mentions and replies in its channels). */
  byTeam: Record<string, number>;
  /** Unread direct messages. */
  dms: number;
}

/** Events to `user:<id>`. */
export const NOTIFY_EVENTS = {
  created: 'notification.created',
  read: 'notification.read',
  settingsChanged: 'notification.settings.changed',
} as const;
export interface NotificationReadEvent {
  /** Empty with `all`. */
  ids: string[];
  all: boolean;
}

// ---------------------------------------------------------------- Web Push

export interface VapidKeyDto {
  publicKey: string;
}

export const pushSubscribeSchema = z.object({
  endpoint: z.url().max(1000),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(10).max(100) }),
  userAgent: z.string().max(300).optional(),
});
export type PushSubscribeInput = z.infer<typeof pushSubscribeSchema>;
export const pushUnsubscribeSchema = z.object({ endpoint: z.url().max(1000) });

export interface PushDeviceDto {
  id: string;
  /** The push service's host (not the whole address: it is a secret of the device). */
  service: string;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
}

/** What a push message carries (the service worker shows it; Angular's service worker reads `notification`). */
export interface PushPayload {
  notification: {
    title: string;
    body: string;
    icon?: string;
    tag?: string;
    data: {
      /** Where a click goes. */
      url: string;
      kind: NotificationKind | 'message';
      onActionClick: { default: { operation: 'navigateLastFocusedOrOpen'; url: string } };
    };
  };
}

// ---------------------------------------------------------------- mail links

export const mailActionSchema = z.object({ token: z.string().min(20).max(2000) });
export interface MailActionResultDto {
  action: 'unsubscribe' | 'mute';
  scopeKind: ScopeKind;
  scopeName: string | null;
}
