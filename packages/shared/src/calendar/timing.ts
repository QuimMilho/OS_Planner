import { CALENDAR_LIMITS } from '../dto/calendar';
import { lastOccurrence, normalizeRRule, parseRRule } from './rrule';
import { isValidTimeZone } from './tz';

const DAY = 86_400_000;

export interface Timing {
  startAt: string;
  endAt: string;
  allDay: boolean;
  timezone: string;
  rrule: string | null;
}

export type TimingResult =
  | {
      ok: true;
      value: Timing;
      /** When the last occurrence ends; null for a series without an end. */ lastEnd: Date | null;
    }
  | { ok: false; error: string };

const isMidnightUtc = (ms: number) => ms % DAY === 0;

/**
 * Checks and normalises when an event happens: instants are written in one form, an all-day event starts and ends at midnight UTC
 * (its zone is `UTC`: the day is the same everywhere), the zone and the rule must be valid, and the length is bounded.
 */
export function normalizeTiming(input: Timing): TimingResult {
  const start = new Date(input.startAt).getTime();
  const end = new Date(input.endAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return { ok: false, error: 'invalid_time' };
  if (end < start) return { ok: false, error: 'end_before_start' };
  if (end - start > CALENDAR_LIMITS.maxDurationDays * DAY)
    return { ok: false, error: 'event_too_long' };
  if (start < Date.UTC(1900, 0, 1) || end > Date.UTC(2200, 0, 1))
    return { ok: false, error: 'invalid_time' };

  let timezone = input.timezone;
  if (input.allDay) {
    if (!isMidnightUtc(start) || !isMidnightUtc(end))
      return { ok: false, error: 'all_day_not_midnight' };
    if (end <= start) return { ok: false, error: 'end_before_start' };
    timezone = 'UTC';
  } else if (!isValidTimeZone(timezone)) return { ok: false, error: 'invalid_timezone' };

  let rrule: string | null = null;
  let lastEnd: Date | null = new Date(end);
  if (input.rrule) {
    const normal = normalizeRRule(input.rrule);
    if (!normal.ok) return { ok: false, error: normal.error };
    if (!parseRRule(normal.text).ok) return { ok: false, error: 'invalid_rrule' };
    rrule = normal.text;
    const last = lastOccurrence(start, input.allDay ? 'UTC' : timezone, normal.rule);
    lastEnd = last === null ? null : new Date(last + (end - start));
  }
  return {
    ok: true,
    value: {
      startAt: new Date(start).toISOString(),
      endAt: new Date(end).toISOString(),
      allDay: input.allDay,
      timezone,
      rrule,
    },
    lastEnd,
  };
}
