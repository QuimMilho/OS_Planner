// Wall-clock arithmetic in an IANA time zone, built on Intl only (no tables, no library): the same code runs in Node and in browsers.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** A wall-clock time. `m` is 1–12. */
export interface LocalParts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

const ZONE_NAME = /^(UTC|[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){1,2})$/;

/** True for a zone the runtime knows (`Europe/Lisbon`, `UTC`). Offsets such as `+01:00` are not zones. */
export function isValidTimeZone(tz: string): boolean {
  if (tz.length > 64 || !ZONE_NAME.test(tz)) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** The wall clock of an instant in a zone. */
export function partsInZone(ms: number, tz: string): LocalParts {
  if (tz === 'UTC') {
    const d = new Date(ms);
    return {
      y: d.getUTCFullYear(),
      m: d.getUTCMonth() + 1,
      d: d.getUTCDate(),
      h: d.getUTCHours(),
      mi: d.getUTCMinutes(),
      s: d.getUTCSeconds(),
    };
  }
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms)))
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  return {
    y: out['year']!,
    m: out['month']!,
    d: out['day']!,
    h: out['hour']! % 24,
    mi: out['minute']!,
    s: out['second']!,
  };
}

const asUtc = (p: LocalParts): number => Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);

/** The zone's offset from UTC at an instant, in milliseconds (east positive). */
export function offsetAt(ms: number, tz: string): number {
  if (tz === 'UTC') return 0;
  return asUtc(partsInZone(ms, tz)) - Math.floor(ms / 1000) * 1000;
}

const DAY = 86_400_000;

/**
 * The instant at which a zone's wall clock shows `p`. A time that happens twice (the clocks went back) is the first one; a time that
 * never happens (the clocks went forward) is read with the offset from before the change, so 02:30 in the gap is 03:30 afterwards.
 */
export function zonedToUtc(p: LocalParts, tz: string): number {
  const wanted = asUtc(p);
  if (tz === 'UTC') return wanted;
  const candidates = [
    ...new Set([wanted - offsetAt(wanted - DAY, tz), wanted - offsetAt(wanted + DAY, tz)]),
  ];
  const valid = candidates.filter((c) => asUtc(partsInZone(c, tz)) === wanted);
  return valid.length ? Math.min(...valid) : Math.max(...candidates);
}

/** Days since 1970-01-01 of a calendar date (proleptic Gregorian). */
export const dayNumber = (y: number, m: number, d: number): number =>
  Math.floor(Date.UTC(y, m - 1, d) / DAY);

/** The calendar date of a day number; `dow` is 0 (Sunday) to 6. */
export function dateOfDay(n: number): { y: number; m: number; d: number; dow: number } {
  const dt = new Date(n * DAY);
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
    dow: dt.getUTCDay(),
  };
}

export const daysInMonth = (y: number, m: number): number =>
  new Date(Date.UTC(y, m, 0)).getUTCDate();
