import { dateOfDay, dayNumber, daysInMonth, partsInZone, zonedToUtc } from './tz';

// Recurrence rules (RFC 5545 RRULE), the subset a calendar needs. A rule is evaluated on the wall clock of the event's zone, so
// "every Monday 09:00 Europe/Lisbon" stays at 09:00 across a change of summer time. Anything outside the subset is refused when the
// rule is read, which is also what keeps expansion bounded.

export const RRULE_FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const;
export type RRuleFreq = (typeof RRULE_FREQS)[number];

/** Weekday codes, indexed like `Date#getUTCDay` (0 = Sunday). */
export const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
export type WeekdayCode = (typeof WEEKDAYS)[number];

export const RRULE_LIMITS = {
  /** Longest rule text. */
  length: 400,
  interval: 999,
  /** `COUNT` above this is refused (nothing needs more, and it bounds the work of expanding). */
  count: 3650,
  byDay: 14,
  byMonthDay: 31,
  bySetPos: 31,
  /** Periods looked at in one expansion before giving up (a rule that never matches, such as 30 February). */
  periods: 20_000,
} as const;

export interface ByDay {
  /** Day of week, 0 (Sunday) to 6. */
  day: number;
  /** The nth such day of the month (or year); negative counts from the end. Absent: every one. */
  ord?: number;
}

export interface RRule {
  freq: RRuleFreq;
  interval: number;
  count?: number;
  /** The last instant an occurrence may start at (ms since the epoch, inclusive). */
  until?: number;
  byDay?: ByDay[];
  byMonthDay?: number[];
  byMonth?: number[];
  bySetPos?: number[];
  /** First day of the week, 0 (Sunday) to 6. */
  wkst: number;
}

export type RRuleParse = { ok: true; rule: RRule } | { ok: false; error: string };

const fail = (error: string): RRuleParse => ({ ok: false, error });

const intList = (raw: string, lo: number, hi: number, max: number): number[] | null => {
  const parts = raw.split(',');
  if (!parts.length || parts.length > max) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^[+-]?\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n === 0 || n < lo || n > hi) return null;
    out.push(n);
  }
  return out;
};

function parseUntil(raw: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(raw);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const time = m[4] !== undefined;
  const ms = Date.UTC(
    y,
    mo - 1,
    d,
    time ? Number(m[4]) : 23,
    time ? Number(m[5]) : 59,
    time ? Number(m[6]) : 59,
  );
  return Number.isNaN(ms) || new Date(ms).getUTCMonth() !== mo - 1 ? null : ms;
}

/** Reads `FREQ=WEEKLY;BYDAY=MO,WE` (an `RRULE:` prefix is allowed). Refuses what the calendar does not support. */
export function parseRRule(text: string): RRuleParse {
  const body = text.trim().replace(/^RRULE:/i, '');
  if (!body || body.length > RRULE_LIMITS.length) return fail('rrule_length');
  const seen = new Map<string, string>();
  for (const part of body.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) return fail('rrule_syntax');
    const key = part.slice(0, eq).toUpperCase();
    if (seen.has(key)) return fail('rrule_duplicate');
    seen.set(key, part.slice(eq + 1).toUpperCase());
  }
  const allowed = new Set([
    'FREQ',
    'INTERVAL',
    'COUNT',
    'UNTIL',
    'BYDAY',
    'BYMONTHDAY',
    'BYMONTH',
    'BYSETPOS',
    'WKST',
  ]);
  for (const key of seen.keys()) if (!allowed.has(key)) return fail(`rrule_unsupported:${key}`);

  const freq = seen.get('FREQ') as RRuleFreq | undefined;
  if (!freq || !RRULE_FREQS.includes(freq)) return fail('rrule_freq');
  const rule: RRule = { freq, interval: 1, wkst: 1 };

  const interval = seen.get('INTERVAL');
  if (interval !== undefined) {
    if (
      !/^\d{1,3}$/.test(interval) ||
      Number(interval) < 1 ||
      Number(interval) > RRULE_LIMITS.interval
    )
      return fail('rrule_interval');
    rule.interval = Number(interval);
  }
  const count = seen.get('COUNT');
  const until = seen.get('UNTIL');
  if (count !== undefined && until !== undefined) return fail('rrule_count_and_until');
  if (count !== undefined) {
    if (!/^\d{1,5}$/.test(count) || Number(count) < 1 || Number(count) > RRULE_LIMITS.count)
      return fail('rrule_count');
    rule.count = Number(count);
  }
  if (until !== undefined) {
    const ms = parseUntil(until);
    if (ms === null) return fail('rrule_until');
    rule.until = ms;
  }
  const wkst = seen.get('WKST');
  if (wkst !== undefined) {
    const i = WEEKDAYS.indexOf(wkst as WeekdayCode);
    if (i < 0) return fail('rrule_wkst');
    rule.wkst = i;
  }

  const byDay = seen.get('BYDAY');
  if (byDay !== undefined) {
    const list: ByDay[] = [];
    const parts = byDay.split(',');
    if (parts.length > RRULE_LIMITS.byDay) return fail('rrule_byday');
    for (const p of parts) {
      const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(p);
      if (!m) return fail('rrule_byday');
      const entry: ByDay = { day: WEEKDAYS.indexOf(m[2] as WeekdayCode) };
      if (m[1] !== undefined) {
        const ord = Number(m[1]);
        const max = freq === 'MONTHLY' ? 5 : freq === 'YEARLY' ? 53 : 0;
        if (ord === 0 || Math.abs(ord) > max) return fail('rrule_byday_ordinal');
        entry.ord = ord;
      }
      list.push(entry);
    }
    rule.byDay = list;
  }
  const byMonthDay = seen.get('BYMONTHDAY');
  if (byMonthDay !== undefined) {
    if (freq === 'WEEKLY') return fail('rrule_bymonthday_weekly');
    const list = intList(byMonthDay, -31, 31, RRULE_LIMITS.byMonthDay);
    if (!list) return fail('rrule_bymonthday');
    rule.byMonthDay = list;
  }
  const byMonth = seen.get('BYMONTH');
  if (byMonth !== undefined) {
    const list = intList(byMonth, 1, 12, 12);
    if (!list || list.some((n) => n < 0)) return fail('rrule_bymonth');
    rule.byMonth = list;
  }
  const bySetPos = seen.get('BYSETPOS');
  if (bySetPos !== undefined) {
    const list = intList(bySetPos, -366, 366, RRULE_LIMITS.bySetPos);
    if (!list) return fail('rrule_bysetpos');
    if (
      (freq !== 'MONTHLY' && freq !== 'YEARLY') ||
      (rule.byDay === undefined && rule.byMonthDay === undefined && rule.byMonth === undefined)
    )
      return fail('rrule_bysetpos');
    rule.bySetPos = list;
  }
  return { ok: true, rule };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** The canonical text of a rule (what is stored). */
export function formatRRule(rule: RRule): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byMonth?.length)
    parts.push(`BYMONTH=${[...rule.byMonth].sort((a, b) => a - b).join(',')}`);
  if (rule.byMonthDay?.length)
    parts.push(`BYMONTHDAY=${[...rule.byMonthDay].sort((a, b) => a - b).join(',')}`);
  if (rule.byDay?.length)
    parts.push(`BYDAY=${rule.byDay.map((b) => `${b.ord ?? ''}${WEEKDAYS[b.day]}`).join(',')}`);
  if (rule.bySetPos?.length) parts.push(`BYSETPOS=${rule.bySetPos.join(',')}`);
  if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`);
  if (rule.until !== undefined) {
    const d = new Date(rule.until);
    parts.push(
      `UNTIL=${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`,
    );
  }
  if (rule.wkst !== 1) parts.push(`WKST=${WEEKDAYS[rule.wkst]}`);
  return parts.join(';');
}

/** Normalises a rule text: the canonical form, or the reason it is refused. */
export function normalizeRRule(
  text: string,
): { ok: true; text: string; rule: RRule } | { ok: false; error: string } {
  const parsed = parseRRule(text);
  return parsed.ok ? { ok: true, text: formatRRule(parsed.rule), rule: parsed.rule } : parsed;
}

// ---------------------------------------------------------------- expansion

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** The days (1..dim) of one month matching the rule's day filters. */
function monthDays(rule: RRule, y: number, m: number, startDay: number): number[] {
  const dim = daysInMonth(y, m);
  let days: number[] | null = null;
  if (rule.byMonthDay?.length)
    days = rule.byMonthDay.map((n) => (n > 0 ? n : dim + n + 1)).filter((d) => d >= 1 && d <= dim);
  if (rule.byDay?.length) {
    const first = dateOfDay(dayNumber(y, m, 1)).dow;
    const hits = new Set<number>();
    for (const b of rule.byDay) {
      const all: number[] = [];
      for (let d = 1 + mod(b.day - first, 7); d <= dim; d += 7) all.push(d);
      if (b.ord === undefined) all.forEach((d) => hits.add(d));
      else {
        const pick = b.ord > 0 ? all[b.ord - 1] : all[all.length + b.ord];
        if (pick !== undefined) hits.add(pick);
      }
    }
    days = days ? days.filter((d) => hits.has(d)) : [...hits];
  }
  if (!days) days = startDay <= dim ? [startDay] : [];
  return [...new Set(days)].sort((a, b) => a - b);
}

/** Every day of a year that is the nth such weekday of the year (YEARLY with BYDAY ordinals and no BYMONTH). */
function yearDays(rule: RRule, y: number): number[] {
  const first = dayNumber(y, 1, 1);
  const total = dayNumber(y + 1, 1, 1) - first;
  const firstDow = dateOfDay(first).dow;
  const out = new Set<number>();
  for (const b of rule.byDay ?? []) {
    const all: number[] = [];
    for (let d = mod(b.day - firstDow, 7); d < total; d += 7) all.push(first + d);
    if (b.ord === undefined) all.forEach((d) => out.add(d));
    else {
      const pick = b.ord > 0 ? all[b.ord - 1] : all[all.length + b.ord];
      if (pick !== undefined) out.add(pick);
    }
  }
  return [...out].sort((a, b) => a - b);
}

const pickSetPos = <T>(set: T[], positions: readonly number[] | undefined): T[] => {
  if (!positions?.length) return set;
  const out = new Set<T>();
  for (const p of positions) {
    const item = p > 0 ? set[p - 1] : set[set.length + p];
    if (item !== undefined) out.add(item);
  }
  return set.filter((x) => out.has(x));
};

export interface ExpandRuleInput {
  /** The first occurrence (the event's start), an instant. */
  startMs: number;
  /** The zone whose wall clock the rule follows. An all-day event passes `UTC` and midnight. */
  tz: string;
  rule: RRule;
  /** Occurrences starting in [fromMs, toMs] are returned. */
  fromMs: number;
  toMs: number;
  /** Stop after this many occurrences in the window. */
  max?: number;
}

/**
 * Start instants of a rule's occurrences inside a window, in order. The rule's own COUNT and UNTIL always apply (COUNT counts from the
 * first occurrence, not from the window). Bounded: a window never costs more than `RRULE_LIMITS.periods` periods.
 */
export function expandRule(input: ExpandRuleInput): number[] {
  const { startMs, tz, rule, fromMs, toMs } = input;
  const max = input.max ?? Number.POSITIVE_INFINITY;
  const out: number[] = [];
  if (toMs < startMs || toMs < fromMs) return out;
  const s = partsInZone(startMs, tz);
  const startDay = dayNumber(s.y, s.m, s.d);
  const startDow = dateOfDay(startDay).dow;
  const time = { h: s.h, mi: s.mi, s: s.s };
  const byMonth = rule.byMonth ? new Set(rule.byMonth) : null;

  const periodCount = (): number => {
    // Where to begin: the first period that can reach the window (all the way back when COUNT has to be counted).
    if (rule.count !== undefined) return 0;
    const f = partsInZone(Math.max(fromMs, startMs), tz);
    const diffDays = dayNumber(f.y, f.m, f.d) - startDay;
    switch (rule.freq) {
      case 'DAILY':
        return Math.max(0, Math.floor(diffDays / rule.interval) - 1);
      case 'WEEKLY':
        return Math.max(0, Math.floor(diffDays / (7 * rule.interval)) - 1);
      case 'MONTHLY':
        return Math.max(0, Math.floor(((f.y - s.y) * 12 + (f.m - s.m)) / rule.interval) - 1);
      case 'YEARLY':
        return Math.max(0, Math.floor((f.y - s.y) / rule.interval) - 1);
    }
  };

  const weekStart = startDay - mod(startDow - rule.wkst, 7);
  let emitted = 0;
  const first = periodCount();
  // With COUNT the occurrences before the window still count: they are walked, not returned.
  for (let i = first, steps = 0; steps < RRULE_LIMITS.periods; i++, steps++) {
    // The days (day numbers) this period offers, in order.
    let days: number[] = [];
    switch (rule.freq) {
      case 'DAILY':
        days = [startDay + i * rule.interval];
        break;
      case 'WEEKLY': {
        const base = weekStart + i * 7 * rule.interval;
        const wanted = rule.byDay?.length ? [...new Set(rule.byDay.map((b) => b.day))] : [startDow];
        days = wanted.map((dow) => base + mod(dow - rule.wkst, 7)).sort((a, b) => a - b);
        break;
      }
      case 'MONTHLY': {
        const total = s.y * 12 + (s.m - 1) + i * rule.interval;
        const y = Math.floor(total / 12);
        const m = (total % 12) + 1;
        days = monthDays(rule, y, m, s.d).map((d) => dayNumber(y, m, d));
        if (rule.bySetPos) days = pickSetPos(days, rule.bySetPos);
        break;
      }
      case 'YEARLY': {
        const y = s.y + i * rule.interval;
        if (!rule.byMonth && !rule.byMonthDay && rule.byDay?.some((b) => b.ord !== undefined)) {
          days = yearDays(rule, y);
        } else {
          const months = rule.byMonth
            ? [...new Set(rule.byMonth)].sort((a, b) => a - b)
            : rule.byMonthDay || rule.byDay
              ? Array.from({ length: 12 }, (_, k) => k + 1)
              : [s.m];
          for (const m of months)
            for (const d of monthDays(rule, y, m, s.d)) days.push(dayNumber(y, m, d));
        }
        if (rule.bySetPos) days = pickSetPos(days, rule.bySetPos);
        break;
      }
    }

    for (const dn of days) {
      const date = dateOfDay(dn);
      if (byMonth && rule.freq !== 'YEARLY' && !byMonth.has(date.m)) continue;
      if (rule.freq === 'DAILY') {
        if (rule.byDay?.length && !rule.byDay.some((b) => b.day === date.dow)) continue;
        if (rule.byMonthDay?.length) {
          const dim = daysInMonth(date.y, date.m);
          if (!rule.byMonthDay.some((n) => (n > 0 ? n : dim + n + 1) === date.d)) continue;
        }
      }
      const at = zonedToUtc({ y: date.y, m: date.m, d: date.d, ...time }, tz);
      if (at < startMs) continue;
      if (rule.until !== undefined && at > rule.until) return out;
      if (at > toMs) return out;
      emitted++;
      if (rule.count !== undefined && emitted > rule.count) return out;
      if (at >= fromMs) {
        out.push(at);
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

/** The start of the last occurrence of a rule that ends (COUNT or UNTIL); null when it never ends. Used to index which events can reach a window. */
export function lastOccurrence(startMs: number, tz: string, rule: RRule): number | null {
  if (rule.until !== undefined && rule.count === undefined) return rule.until;
  if (rule.count === undefined) return null;
  const all = expandRule({
    startMs,
    tz,
    rule,
    fromMs: startMs,
    toMs: Number.MAX_SAFE_INTEGER / 2,
    max: rule.count,
  });
  return all.at(-1) ?? startMs;
}
