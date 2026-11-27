import { describe, expect, it } from 'vitest';
import { describeRRule, presetOf, ruleOfPreset } from './describe';
import { expandEvent, instantKey, type Expandable } from './expand';
import { expandRule, formatRRule, lastOccurrence, normalizeRRule, parseRRule } from './rrule';
import { normalizeTiming } from './timing';
import { isValidTimeZone, offsetAt, partsInZone, zonedToUtc } from './tz';

const ms = (iso: string) => new Date(iso).getTime();
const event = (over: Partial<Expandable> & Pick<Expandable, 'startAt' | 'endAt'>): Expandable => ({
  allDay: false,
  timezone: 'UTC',
  rrule: null,
  exceptions: [],
  ...over,
});
const starts = (e: Expandable, from: string, to: string) =>
  expandEvent(e, ms(from), ms(to)).map((o) => o.start);

describe('time zones', () => {
  it('knows zones and refuses everything else', () => {
    expect(isValidTimeZone('Europe/Lisbon')).toBe(true);
    expect(isValidTimeZone('America/Argentina/Buenos_Aires')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('+01:00')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('A'.repeat(70))).toBe(false);
  });

  it('reads the wall clock and the offset of a zone', () => {
    expect(partsInZone(ms('2026-07-01T12:00:00Z'), 'Europe/Lisbon')).toMatchObject({
      y: 2026,
      m: 7,
      d: 1,
      h: 13,
    });
    expect(offsetAt(ms('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(-5 * 3_600_000);
    expect(offsetAt(ms('2026-07-15T12:00:00Z'), 'America/New_York')).toBe(-4 * 3_600_000);
  });

  it('turns a wall clock into an instant, also around a change of summer time', () => {
    const ny = (y: number, m: number, d: number, h: number, mi: number) =>
      new Date(zonedToUtc({ y, m, d, h, mi, s: 0 }, 'America/New_York')).toISOString();
    expect(ny(2026, 1, 10, 9, 0)).toBe('2026-01-10T14:00:00.000Z');
    // 02:30 on 8 March 2026 never happens in New York: it is read with the offset from before the change.
    expect(ny(2026, 3, 8, 2, 30)).toBe('2026-03-08T07:30:00.000Z');
    // 01:30 on 1 November 2026 happens twice: the first one counts.
    expect(ny(2026, 11, 1, 1, 30)).toBe('2026-11-01T05:30:00.000Z');
  });
});

describe('reading rules', () => {
  it('accepts the supported subset and writes it back in one form', () => {
    expect(normalizeRRule('rrule:freq=weekly;byday=we,mo;interval=2')).toMatchObject({
      ok: true,
      text: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE,MO',
    });
    expect(normalizeRRule('FREQ=MONTHLY;BYDAY=-1FR')).toMatchObject({
      ok: true,
      text: 'FREQ=MONTHLY;BYDAY=-1FR',
    });
    const p = parseRRule('FREQ=DAILY;UNTIL=20261231');
    expect(p.ok && p.rule.until).toBe(ms('2026-12-31T23:59:59Z'));
    expect(
      formatRRule(
        (parseRRule('FREQ=DAILY;UNTIL=20261231T120000Z') as { ok: true; rule: never }).rule,
      ),
    ).toBe('FREQ=DAILY;UNTIL=20261231T120000Z');
  });

  it('refuses what could be abused or is not supported', () => {
    const bad = [
      'FREQ=SECONDLY',
      'FREQ=MINUTELY;INTERVAL=1',
      'FREQ=DAILY;BYSECOND=1,2,3',
      'FREQ=DAILY;BYHOUR=1',
      'FREQ=DAILY;BYYEARDAY=1',
      'FREQ=DAILY;COUNT=3651',
      'FREQ=DAILY;COUNT=0',
      'FREQ=DAILY;COUNT=3;UNTIL=20270101',
      'FREQ=DAILY;INTERVAL=0',
      'FREQ=DAILY;INTERVAL=1000',
      'FREQ=DAILY;FREQ=WEEKLY',
      'FREQ=WEEKLY;BYDAY=2MO',
      'FREQ=WEEKLY;BYMONTHDAY=3',
      'FREQ=MONTHLY;BYDAY=6MO',
      'FREQ=MONTHLY;BYMONTHDAY=32',
      'FREQ=MONTHLY;BYMONTHDAY=0',
      'FREQ=MONTHLY;BYSETPOS=1',
      'FREQ=DAILY;BYSETPOS=1;BYDAY=MO',
      'FREQ=DAILY;UNTIL=soon',
      'BYDAY=MO',
      '',
      `FREQ=DAILY;${'X'.repeat(500)}=1`,
    ];
    for (const text of bad) expect(parseRRule(text).ok, text).toBe(false);
  });
});

describe('expanding a series', () => {
  it('daily, with an interval', () => {
    const e = event({
      startAt: '2026-01-01T09:00:00Z',
      endAt: '2026-01-01T10:00:00Z',
      rrule: 'FREQ=DAILY;INTERVAL=3',
    });
    expect(starts(e, '2026-01-01T00:00:00Z', '2026-01-12T00:00:00Z')).toEqual([
      '2026-01-01T09:00:00.000Z',
      '2026-01-04T09:00:00.000Z',
      '2026-01-07T09:00:00.000Z',
      '2026-01-10T09:00:00.000Z',
    ]);
  });

  it('weekly on several days, every second week', () => {
    const e = event({
      startAt: '2026-01-05T09:00:00Z',
      endAt: '2026-01-05T10:00:00Z',
      rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE',
    });
    expect(starts(e, '2026-01-01T00:00:00Z', '2026-02-06T00:00:00Z')).toEqual([
      '2026-01-05T09:00:00.000Z',
      '2026-01-07T09:00:00.000Z',
      '2026-01-19T09:00:00.000Z',
      '2026-01-21T09:00:00.000Z',
      '2026-02-02T09:00:00.000Z',
      '2026-02-04T09:00:00.000Z',
    ]);
  });

  it('weekly without BYDAY repeats on the weekday of the start', () => {
    const e = event({
      startAt: '2026-01-07T09:00:00Z',
      endAt: '2026-01-07T10:00:00Z',
      rrule: 'FREQ=WEEKLY',
    });
    expect(starts(e, '2026-01-01T00:00:00Z', '2026-01-25T00:00:00Z')).toEqual([
      '2026-01-07T09:00:00.000Z',
      '2026-01-14T09:00:00.000Z',
      '2026-01-21T09:00:00.000Z',
    ]);
  });

  it('monthly by day of the month skips the months that lack it', () => {
    const e = event({
      startAt: '2026-01-31T10:00:00Z',
      endAt: '2026-01-31T11:00:00Z',
      rrule: 'FREQ=MONTHLY',
    });
    expect(starts(e, '2026-01-01T00:00:00Z', '2026-08-01T00:00:00Z')).toEqual([
      '2026-01-31T10:00:00.000Z',
      '2026-03-31T10:00:00.000Z',
      '2026-05-31T10:00:00.000Z',
      '2026-07-31T10:00:00.000Z',
    ]);
    const last = event({
      startAt: '2026-01-31T10:00:00Z',
      endAt: '2026-01-31T11:00:00Z',
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=-1',
    });
    expect(starts(last, '2026-01-01T00:00:00Z', '2026-05-01T00:00:00Z')).toEqual([
      '2026-01-31T10:00:00.000Z',
      '2026-02-28T10:00:00.000Z',
      '2026-03-31T10:00:00.000Z',
      '2026-04-30T10:00:00.000Z',
    ]);
  });

  it('monthly on the 2nd Tuesday and on the last Friday', () => {
    const second = event({
      startAt: '2026-01-13T10:00:00Z',
      endAt: '2026-01-13T11:00:00Z',
      rrule: 'FREQ=MONTHLY;BYDAY=2TU',
    });
    expect(starts(second, '2026-01-01T00:00:00Z', '2026-05-01T00:00:00Z')).toEqual([
      '2026-01-13T10:00:00.000Z',
      '2026-02-10T10:00:00.000Z',
      '2026-03-10T10:00:00.000Z',
      '2026-04-14T10:00:00.000Z',
    ]);
    const lastFri = event({
      startAt: '2026-01-30T10:00:00Z',
      endAt: '2026-01-30T11:00:00Z',
      rrule: 'FREQ=MONTHLY;BYDAY=-1FR',
    });
    expect(starts(lastFri, '2026-01-01T00:00:00Z', '2026-04-01T00:00:00Z')).toEqual([
      '2026-01-30T10:00:00.000Z',
      '2026-02-27T10:00:00.000Z',
      '2026-03-27T10:00:00.000Z',
    ]);
  });

  it('monthly on the last working day (BYSETPOS)', () => {
    const e = event({
      startAt: '2026-01-30T10:00:00Z',
      endAt: '2026-01-30T11:00:00Z',
      rrule: 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1',
    });
    expect(starts(e, '2026-01-01T00:00:00Z', '2026-04-01T00:00:00Z')).toEqual([
      '2026-01-30T10:00:00.000Z',
      '2026-02-27T10:00:00.000Z',
      '2026-03-31T10:00:00.000Z',
    ]);
  });

  it('yearly, also on a leap day and in chosen months', () => {
    const leap = event({
      startAt: '2024-02-29T10:00:00Z',
      endAt: '2024-02-29T11:00:00Z',
      rrule: 'FREQ=YEARLY',
    });
    expect(starts(leap, '2024-01-01T00:00:00Z', '2029-01-01T00:00:00Z')).toEqual([
      '2024-02-29T10:00:00.000Z',
      '2028-02-29T10:00:00.000Z',
    ]);
    const months = event({
      startAt: '2026-03-15T10:00:00Z',
      endAt: '2026-03-15T11:00:00Z',
      rrule: 'FREQ=YEARLY;BYMONTH=3,9;BYMONTHDAY=15',
    });
    expect(starts(months, '2026-01-01T00:00:00Z', '2027-12-31T00:00:00Z')).toEqual([
      '2026-03-15T10:00:00.000Z',
      '2026-09-15T10:00:00.000Z',
      '2027-03-15T10:00:00.000Z',
      '2027-09-15T10:00:00.000Z',
    ]);
    const nth = event({
      startAt: '2026-11-26T10:00:00Z',
      endAt: '2026-11-26T11:00:00Z',
      rrule: 'FREQ=YEARLY;BYMONTH=11;BYDAY=4TH',
    });
    expect(starts(nth, '2026-01-01T00:00:00Z', '2028-01-01T00:00:00Z')).toEqual([
      '2026-11-26T10:00:00.000Z',
      '2027-11-25T10:00:00.000Z',
    ]);
  });

  it('COUNT counts from the first occurrence, whatever the window', () => {
    const e = event({
      startAt: '2026-01-01T09:00:00Z',
      endAt: '2026-01-01T10:00:00Z',
      rrule: 'FREQ=DAILY;COUNT=5',
    });
    expect(starts(e, '2025-12-01T00:00:00Z', '2026-06-01T00:00:00Z')).toHaveLength(5);
    expect(starts(e, '2026-01-04T00:00:00Z', '2026-06-01T00:00:00Z')).toEqual([
      '2026-01-04T09:00:00.000Z',
      '2026-01-05T09:00:00.000Z',
    ]);
  });

  it('UNTIL ends the series (inclusive)', () => {
    const e = event({
      startAt: '2026-01-05T09:00:00Z',
      endAt: '2026-01-05T10:00:00Z',
      rrule: 'FREQ=WEEKLY;UNTIL=20260119T090000Z',
    });
    expect(starts(e, '2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z')).toEqual([
      '2026-01-05T09:00:00.000Z',
      '2026-01-12T09:00:00.000Z',
      '2026-01-19T09:00:00.000Z',
    ]);
  });

  it('a window far from the start does not walk every period', () => {
    const e = event({
      startAt: '2000-01-03T09:00:00Z',
      endAt: '2000-01-03T10:00:00Z',
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
    });
    expect(starts(e, '2026-03-01T00:00:00Z', '2026-03-20T00:00:00Z')).toEqual([
      '2026-03-02T09:00:00.000Z',
      '2026-03-09T09:00:00.000Z',
      '2026-03-16T09:00:00.000Z',
    ]);
  });

  it('gives up on a rule that never matches', () => {
    const t0 = Date.now();
    const out = expandRule({
      startMs: ms('2026-01-01T00:00:00Z'),
      tz: 'UTC',
      rule: (parseRRule('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30') as { ok: true; rule: never }).rule,
      fromMs: 0,
      toMs: ms('2200-01-01T00:00:00Z'),
    });
    expect(out).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('finds where a series ends', () => {
    const rule = (text: string) => (parseRRule(text) as { ok: true; rule: never }).rule;
    expect(lastOccurrence(ms('2026-01-01T09:00:00Z'), 'UTC', rule('FREQ=DAILY;COUNT=3'))).toBe(
      ms('2026-01-03T09:00:00Z'),
    );
    expect(
      lastOccurrence(ms('2026-01-01T09:00:00Z'), 'UTC', rule('FREQ=DAILY;UNTIL=20260110T000000Z')),
    ).toBe(ms('2026-01-10T00:00:00Z'));
    expect(lastOccurrence(ms('2026-01-01T09:00:00Z'), 'UTC', rule('FREQ=DAILY'))).toBeNull();
  });
});

describe('summer time', () => {
  it('"every Monday 09:00 Europe/Lisbon" stays at 09:00 when the clocks go forward (29 March 2026)', () => {
    const e = event({
      startAt: '2026-03-16T09:00:00Z',
      endAt: '2026-03-16T10:00:00Z',
      timezone: 'Europe/Lisbon',
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
    });
    const out = expandEvent(e, ms('2026-03-15T00:00:00Z'), ms('2026-04-08T00:00:00Z'));
    expect(out.map((o) => o.start)).toEqual([
      '2026-03-16T09:00:00.000Z',
      '2026-03-23T09:00:00.000Z',
      '2026-03-30T08:00:00.000Z',
      '2026-04-06T08:00:00.000Z',
    ]);
    expect(out.map((o) => new Date(o.end).getTime() - new Date(o.start).getTime())).toEqual([
      3_600_000, 3_600_000, 3_600_000, 3_600_000,
    ]);
  });

  it('and when they go back (25 October 2026)', () => {
    const e = event({
      startAt: '2026-10-19T08:00:00Z',
      endAt: '2026-10-19T09:00:00Z',
      timezone: 'Europe/Lisbon',
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
    });
    expect(starts(e, '2026-10-18T00:00:00Z', '2026-11-05T00:00:00Z')).toEqual([
      '2026-10-19T08:00:00.000Z',
      '2026-10-26T09:00:00.000Z',
      '2026-11-02T09:00:00.000Z',
    ]);
  });

  it('America/New_York, daily across 8 March 2026', () => {
    const e = event({
      startAt: '2026-03-06T13:00:00Z',
      endAt: '2026-03-06T14:00:00Z',
      timezone: 'America/New_York',
      rrule: 'FREQ=DAILY',
    });
    expect(starts(e, '2026-03-06T00:00:00Z', '2026-03-10T00:00:00Z')).toEqual([
      '2026-03-06T13:00:00.000Z',
      '2026-03-07T13:00:00.000Z',
      '2026-03-08T12:00:00.000Z',
      '2026-03-09T12:00:00.000Z',
    ]);
  });

  it('a time inside the gap moves forward, one that happens twice is the first', () => {
    const gap = event({
      startAt: '2026-03-07T07:30:00Z',
      endAt: '2026-03-07T08:30:00Z',
      timezone: 'America/New_York',
      rrule: 'FREQ=DAILY',
    });
    expect(starts(gap, '2026-03-07T00:00:00Z', '2026-03-10T00:00:00Z')).toEqual([
      '2026-03-07T07:30:00.000Z',
      '2026-03-08T07:30:00.000Z',
      '2026-03-09T06:30:00.000Z',
    ]);
    const twice = event({
      startAt: '2026-10-31T05:30:00Z',
      endAt: '2026-10-31T06:30:00Z',
      timezone: 'America/New_York',
      rrule: 'FREQ=DAILY',
    });
    expect(starts(twice, '2026-10-31T00:00:00Z', '2026-11-04T00:00:00Z')).toEqual([
      '2026-10-31T05:30:00.000Z',
      '2026-11-01T05:30:00.000Z',
      '2026-11-02T06:30:00.000Z',
      '2026-11-03T06:30:00.000Z',
    ]);
  });
});

describe('all-day events', () => {
  it('do not move with a zone: midnight UTC, whatever zone is written', () => {
    const e = event({
      startAt: '2026-03-27T00:00:00Z',
      endAt: '2026-03-28T00:00:00Z',
      allDay: true,
      timezone: 'Europe/Lisbon',
      rrule: 'FREQ=WEEKLY',
    });
    expect(starts(e, '2026-03-20T00:00:00Z', '2026-04-10T00:00:00Z')).toEqual([
      '2026-03-27T00:00:00.000Z',
      '2026-04-03T00:00:00.000Z',
    ]);
  });

  it('a multi-day one keeps its length', () => {
    const e = event({
      startAt: '2026-03-27T00:00:00Z',
      endAt: '2026-03-30T00:00:00Z',
      allDay: true,
      rrule: 'FREQ=MONTHLY',
    });
    const out = expandEvent(e, ms('2026-04-01T00:00:00Z'), ms('2026-05-31T00:00:00Z'));
    expect(out.map((o) => [o.start, o.end])).toEqual([
      ['2026-04-27T00:00:00.000Z', '2026-04-30T00:00:00.000Z'],
      ['2026-05-27T00:00:00.000Z', '2026-05-30T00:00:00.000Z'],
    ]);
  });
});

describe('exceptions', () => {
  const base = event({
    startAt: '2026-01-05T09:00:00Z',
    endAt: '2026-01-05T10:00:00Z',
    rrule: 'FREQ=WEEKLY',
    exceptions: [
      { originalStart: '2026-01-12T09:00:00Z', kind: 'cancelled' },
      {
        originalStart: '2026-01-19T09:00:00.000Z',
        kind: 'override',
        override: {
          title: 'Moved',
          startAt: '2026-01-20T11:00:00Z',
          endAt: '2026-01-20T12:30:00Z',
        },
      },
    ],
  });

  it('leaves out a cancelled occurrence and moves a changed one', () => {
    const out = expandEvent(base, ms('2026-01-01T00:00:00Z'), ms('2026-02-01T00:00:00Z'));
    expect(out.map((o) => o.start)).toEqual([
      '2026-01-05T09:00:00.000Z',
      '2026-01-20T11:00:00.000Z',
      '2026-01-26T09:00:00.000Z',
    ]);
    const moved = out[1]!;
    expect(moved.originalStart).toBe('2026-01-19T09:00:00.000Z');
    expect(moved.end).toBe('2026-01-20T12:30:00.000Z');
    expect(moved.override?.title).toBe('Moved');
  });

  it('finds an occurrence moved into the window from outside it, and drops one moved out', () => {
    const into = expandEvent(base, ms('2026-01-20T00:00:00Z'), ms('2026-01-21T00:00:00Z'));
    expect(into.map((o) => o.start)).toEqual(['2026-01-20T11:00:00.000Z']);
    const out = expandEvent(base, ms('2026-01-19T00:00:00Z'), ms('2026-01-20T00:00:00Z'));
    expect(out).toEqual([]);
  });

  it('a single event is one occurrence, found when it overlaps the window', () => {
    const one = event({ startAt: '2026-01-05T23:00:00Z', endAt: '2026-01-06T02:00:00Z' });
    expect(starts(one, '2026-01-06T00:00:00Z', '2026-01-07T00:00:00Z')).toEqual([
      '2026-01-05T23:00:00.000Z',
    ]);
    expect(starts(one, '2026-01-06T02:00:00Z', '2026-01-07T00:00:00Z')).toEqual([]);
  });

  it('normalises the keys of exceptions', () => {
    expect(instantKey('2026-01-12T09:00:00Z')).toBe('2026-01-12T09:00:00.000Z');
    expect(instantKey('2026-01-12T10:00:00+01:00')).toBe('2026-01-12T09:00:00.000Z');
  });
});

describe('timing', () => {
  const base = {
    startAt: '2026-01-05T09:00:00Z',
    endAt: '2026-01-05T10:00:00Z',
    allDay: false,
    timezone: 'Europe/Lisbon',
    rrule: null as string | null,
  };

  it('normalises and checks', () => {
    expect(normalizeTiming(base)).toMatchObject({
      ok: true,
      value: { startAt: '2026-01-05T09:00:00.000Z' },
    });
    expect(normalizeTiming({ ...base, endAt: '2026-01-05T08:00:00Z' })).toMatchObject({
      ok: false,
      error: 'end_before_start',
    });
    expect(normalizeTiming({ ...base, timezone: 'Nowhere/Land' })).toMatchObject({
      ok: false,
      error: 'invalid_timezone',
    });
    expect(normalizeTiming({ ...base, endAt: '2028-01-05T10:00:00Z' })).toMatchObject({
      ok: false,
      error: 'event_too_long',
    });
    expect(normalizeTiming({ ...base, rrule: 'FREQ=DAILY;BYSECOND=1' })).toMatchObject({
      ok: false,
    });
    expect(normalizeTiming({ ...base, rrule: 'freq=weekly' })).toMatchObject({
      ok: true,
      value: { rrule: 'FREQ=WEEKLY' },
      lastEnd: null,
    });
    expect(normalizeTiming({ ...base, rrule: 'FREQ=DAILY;COUNT=3' })).toMatchObject({
      ok: true,
      lastEnd: new Date('2026-01-07T10:00:00Z'),
    });
  });

  it('an all-day event is whole days in UTC', () => {
    const day = {
      startAt: '2026-01-05T00:00:00Z',
      endAt: '2026-01-06T00:00:00Z',
      allDay: true,
      timezone: 'Asia/Tokyo',
      rrule: null,
    };
    expect(normalizeTiming(day)).toMatchObject({ ok: true, value: { timezone: 'UTC' } });
    expect(normalizeTiming({ ...day, startAt: '2026-01-05T09:00:00Z' })).toMatchObject({
      ok: false,
      error: 'all_day_not_midnight',
    });
    expect(normalizeTiming({ ...day, endAt: day.startAt })).toMatchObject({
      ok: false,
      error: 'end_before_start',
    });
  });
});

describe('plain language', () => {
  const dict: Record<string, string> = {
    'rrule.every.day': 'Every day',
    'rrule.every.week': 'Every week',
    'rrule.everyN.week': 'Every {n} weeks',
    'rrule.every.month': 'Every month',
    'rrule.onDays': 'on {days}',
    'rrule.onNth': 'on the {nth} {day}',
    'rrule.nth.2': '2nd',
    'rrule.nth.-1': 'last',
    'rrule.day.MO': 'Monday',
    'rrule.day.WE': 'Wednesday',
    'rrule.day.TU': 'Tuesday',
    'rrule.and': 'and',
    'rrule.times': '{n} times',
    'rrule.until': 'until {date}',
  };
  const t = (key: string, params?: Record<string, string | number>) =>
    (dict[key] ?? key).replace(/\{(\w+)\}/g, (_m, k: string) => String(params?.[k]));

  it('describes a rule from its pieces', () => {
    expect(describeRRule('FREQ=DAILY', t, String)).toBe('Every day');
    expect(describeRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10', t, String)).toBe(
      'Every 2 weeks, on Monday and Wednesday, 10 times',
    );
    expect(describeRRule('FREQ=MONTHLY;BYDAY=2TU', t, String)).toBe(
      'Every month, on the 2nd Tuesday',
    );
    expect(
      describeRRule('FREQ=WEEKLY;UNTIL=20260301T000000Z', t, (n) =>
        new Date(n).toISOString().slice(0, 10),
      ),
    ).toBe('Every week, until 2026-03-01');
  });

  it('maps rules to presets and back', () => {
    expect(presetOf(null, 1, 5)).toBe('none');
    expect(presetOf('FREQ=DAILY', 1, 5)).toBe('daily');
    expect(presetOf('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 1, 5)).toBe('weekdays');
    expect(presetOf('FREQ=WEEKLY;BYDAY=MO', 1, 5)).toBe('weekly');
    expect(presetOf('FREQ=WEEKLY;BYDAY=TU', 1, 5)).toBe('custom');
    expect(presetOf('FREQ=MONTHLY', 1, 5)).toBe('monthly');
    expect(presetOf('FREQ=MONTHLY;BYDAY=2TU', 2, 13)).toBe('custom');
    expect(presetOf('FREQ=DAILY;COUNT=3', 1, 5)).toBe('custom');
    expect(ruleOfPreset('weekly', 3)).toBe('FREQ=WEEKLY;BYDAY=WE');
    expect(ruleOfPreset('none', 3)).toBeNull();
  });
});
