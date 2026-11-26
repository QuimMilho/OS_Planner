import type {
  EffectiveSettingDto,
  EmailMode,
  NotifyLevel,
  QuietHoursDto,
  ScopeKind,
  SettingSource,
} from '../dto/notifications';

/**
 * How a person's notification settings combine. Pure functions: the server decides with them who is told, and the web shows
 * the same answer ("what is in effect here, and where it comes from").
 *
 * A message sits in a chain of scopes, nearest first: channel, the projects above it (nearest first), the team, and the
 * person's global settings. A conversation has just itself and the global settings. Every setting is looked up on its own:
 * the nearest scope that says something wins, `inherit` (or nothing set) falls through, and a built-in default is the last word.
 */
export interface ScopeRule {
  scopeKind: ScopeKind;
  scopeId: string | null;
  level: NotifyLevel;
  suppressEveryone: boolean | null;
  suppressRoles: boolean | null;
  suppressDirect: boolean | null;
  /** When the mute ends (ms since the epoch); null = no mute set at this level. A time already passed is an explicit un-mute. */
  mutedUntil: number | null;
  email: EmailMode;
  emailOnlyWhenAway: boolean | null;
  push: boolean | null;
}

export interface ResolveDefaults {
  /** `all` for conversations, `mentions` for channels. */
  level: 'all' | 'mentions';
}

export interface Effective {
  level: 'all' | 'mentions' | 'none';
  /** A mute is in force (the nearest mute that was set has not ended). */
  muted: boolean;
  mutedUntil: number | null;
  /** Muted or "nothing": everything but a direct mention is silenced. */
  silenced: boolean;
  suppressEveryone: boolean;
  suppressRoles: boolean;
  suppressDirect: boolean;
  email: 'off' | 'mentions' | 'all';
  emailOnlyWhenAway: boolean;
  push: boolean;
  sources: EffectiveSettingDto['sources'];
}

const DEFAULT: SettingSource = { scopeKind: 'default', scopeId: null };
const source = (r: Pick<ScopeRule, 'scopeKind' | 'scopeId'>): SettingSource => ({
  scopeKind: r.scopeKind,
  scopeId: r.scopeId,
});

/** The nearest rule whose `pick` says something (not null / not `inherit`). */
function nearest<T>(
  chain: readonly ScopeRule[],
  pick: (r: ScopeRule) => T | null | undefined,
): { value: T; from: SettingSource } | null {
  for (const r of chain) {
    const v = pick(r);
    if (v !== null && v !== undefined) return { value: v, from: source(r) };
  }
  return null;
}

export function resolveSetting(
  chain: readonly ScopeRule[],
  now: number,
  defaults: ResolveDefaults,
): Effective {
  const level = nearest(chain, (r) => (r.level === 'inherit' ? null : r.level));
  // A mute set at any level covers everything below it, and a lower level that sets its own (even one that has already ended:
  // that is how a conversation or channel is un-muted inside a muted team) decides for itself.
  const mute = nearest(chain, (r) => r.mutedUntil);
  const sup = (pick: (r: ScopeRule) => boolean | null) => nearest(chain, pick);
  const everyone = sup((r) => r.suppressEveryone);
  const roles = sup((r) => r.suppressRoles);
  const direct = sup((r) => r.suppressDirect);
  const email = nearest(chain, (r) => (r.email === 'inherit' ? null : r.email));
  const away = nearest(chain, (r) => r.emailOnlyWhenAway);
  const push = nearest(chain, (r) => r.push);

  const effLevel = level?.value ?? defaults.level;
  const muted = mute !== null && mute.value > now;
  return {
    level: effLevel,
    muted,
    mutedUntil: mute ? mute.value : null,
    silenced: muted || effLevel === 'none',
    suppressEveryone: everyone?.value ?? false,
    suppressRoles: roles?.value ?? false,
    suppressDirect: direct?.value ?? false,
    email: email?.value ?? 'off',
    emailOnlyWhenAway: away?.value ?? true,
    push: push?.value ?? true,
    sources: {
      level: level?.from ?? DEFAULT,
      mute: mute?.from ?? DEFAULT,
      suppressEveryone: everyone?.from ?? DEFAULT,
      suppressRoles: roles?.from ?? DEFAULT,
      suppressDirect: direct?.from ?? DEFAULT,
      email: email?.from ?? DEFAULT,
      emailOnlyWhenAway: away?.from ?? DEFAULT,
      push: push?.from ?? DEFAULT,
    },
  };
}

/** What kind of thing happened, for deciding whether it gets through. */
export type NotifyType =
  /** Mentioned by name, or somebody answered a message of theirs: the last thing to be silenced. */
  | 'direct'
  | 'role'
  | 'everyone'
  | 'here'
  /** An ordinary message (in a conversation, or in a channel for someone who asked for everything). */
  | 'message';

/**
 * Does this reach the person at all? A direct mention only stops when the person turned that off (`suppressDirect`: never
 * offered as a global setting). Everything else stops while the scope is muted or set to "nothing", and each of `@everyone`
 * and `@here`, roles has its own switch. An ordinary message needs the "all" level.
 */
export function shouldNotify(e: Effective, type: NotifyType): boolean {
  switch (type) {
    case 'direct':
      return !e.suppressDirect;
    case 'role':
      return !e.silenced && !e.suppressRoles;
    case 'everyone':
    case 'here':
      return !e.silenced && !e.suppressEveryone;
    case 'message':
      return e.level === 'all' && !e.silenced;
  }
}

/**
 * Does the person's email option for this chat want a mail for it? `mentions` mails the things that notify as mentions,
 * `all` mails every message too (unless the chat is muted), `off` mails nothing.
 */
export function shouldEmail(e: Effective, type: NotifyType): boolean {
  if (e.email === 'off') return false;
  if (type === 'message') return e.email === 'all' && !e.silenced;
  return shouldNotify(e, type);
}

export const MENTION_RANK: readonly NotifyType[] = ['direct', 'role', 'everyone', 'here'];

/** The strongest of these that gets through for this person, or null. */
export function strongest(e: Effective, types: Iterable<NotifyType>): NotifyType | null {
  const wanted = new Set(types);
  for (const t of MENTION_RANK) if (wanted.has(t) && shouldNotify(e, t)) return t;
  return null;
}

// ---------------------------------------------------------------- quiet hours

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The local weekday (0 = Sunday) and minutes since midnight in `timeZone`. A time zone the runtime does not know reads as UTC. */
function localTime(now: Date, timeZone: string): { day: number; minutes: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  }
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '0';
  return {
    day: WEEKDAYS[get('weekday')] ?? 0,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

const minutesOf = (hhmm: string): number =>
  Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * Is this moment inside the person's quiet hours? The window belongs to the day it starts on: 22:00 to 07:00 on Friday runs
 * until Saturday morning. Quiet hours hold back push and email, not the inbox.
 */
export function inQuietHours(q: QuietHoursDto | null | undefined, now: Date): boolean {
  if (!q?.enabled || !q.days.length) return false;
  const from = minutesOf(q.from);
  const to = minutesOf(q.to);
  if (from === to) return false;
  const { day, minutes } = localTime(now, q.timeZone);
  if (from < to) return q.days.includes(day) && minutes >= from && minutes < to;
  return (
    (q.days.includes(day) && minutes >= from) || (q.days.includes((day + 6) % 7) && minutes < to)
  );
}
