import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expandEvent } from '../calendar/expand';
import {
  IcsParseError,
  buildIcs,
  escapeText,
  exceptionsOf,
  fold,
  mapRRule,
  oneLine,
  parseIcs,
  plainText,
  unescapeText,
  unfold,
  vtimezone,
  zoneTransitions,
  type IcsOutEvent,
} from '../ics';

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}.ics`, import.meta.url), 'utf8');

describe('text rules', () => {
  it('folds at 75 octets without cutting a character, and unfolds back', () => {
    const line = 'SUMMARY:' + 'ação 🎉 '.repeat(40);
    const folded = fold(line);
    for (const part of folded.split('\r\n'))
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    expect(unfold(folded)).toEqual([line]);
  });

  it('escapes and unescapes values', () => {
    const v = 'a, b; c\\d\nnext';
    expect(escapeText(v)).toBe('a\\, b\\; c\\\\d\\nnext');
    expect(unescapeText(escapeText(v))).toBe(v);
  });

  it('turns HTML into plain text with links kept as Markdown and scripts dropped', () => {
    const t = plainText(
      '<p>Hi &amp; bye</p><a href="https://x.test/a">link</a><script>boom()</script><style>p{}</style>',
    );
    expect(t).toContain('Hi & bye');
    expect(t).toContain('[link](https://x.test/a)');
    expect(t).not.toMatch(/boom|<|p\{\}/);
    expect(plainText('1 < 2 and 3 > 2')).toBe('1 < 2 and 3 > 2');
    expect(oneLine('  a\n\n b\t c ')).toBe('a b c');
  });
});

describe('rule mapping', () => {
  it('keeps what the calendar supports', () => {
    expect(mapRRule('FREQ=WEEKLY;BYDAY=MO,WE')).toEqual({
      rrule: 'FREQ=WEEKLY;BYDAY=MO,WE',
      simplified: false,
    });
    expect(mapRRule('RRULE:FREQ=MONTHLY;BYDAY=2TU')).toEqual({
      rrule: 'FREQ=MONTHLY;BYDAY=2TU',
      simplified: false,
    });
  });

  it('drops detail it cannot evaluate and cuts what is too large', () => {
    expect(mapRRule('FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=30')).toEqual({
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      simplified: true,
    });
    expect(mapRRule('FREQ=DAILY;COUNT=999999999')).toEqual({
      rrule: 'FREQ=DAILY;COUNT=3650',
      simplified: true,
    });
    expect(mapRRule('FREQ=DAILY;INTERVAL=5000')).toEqual({
      rrule: 'FREQ=DAILY;INTERVAL=999',
      simplified: true,
    });
    expect(mapRRule('FREQ=WEEKLY;BYDAY=1MO').rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
  });

  it('gives up on rules that repeat inside the day, and on nonsense', () => {
    for (const bad of [
      'FREQ=SECONDLY;COUNT=100',
      'FREQ=HOURLY',
      'FREQ=MINUTELY;INTERVAL=1',
      'nonsense',
      'FREQ=',
      '',
    ])
      expect(mapRRule(bad)).toEqual({ rrule: null, simplified: true });
  });

  it('keeps expansion of a rule that never matches bounded in time', () => {
    const m = mapRRule('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30');
    expect(m.rrule).not.toBeNull();
    const t0 = Date.now();
    const out = expandEvent(
      {
        startAt: '2026-01-01T09:00:00.000Z',
        endAt: '2026-01-01T10:00:00.000Z',
        allDay: false,
        timezone: 'UTC',
        rrule: m.rrule,
      },
      Date.UTC(2026, 0, 1),
      Date.UTC(2028, 0, 1),
    );
    expect(out.length).toBeLessThanOrEqual(1);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('Google fixture', () => {
  const r = parseIcs(fixture('google'));

  it('finds the series, the unsupported parts and what was cancelled', () => {
    expect(r.name).toBe('Work');
    expect(r.series.map((s) => s.master.title)).toEqual(['Standup', 'Christmas break', 'Dentist']);
    expect(r.unsupported).toEqual([{ component: 'VTODO', count: 1 }]);
    expect(r.cancelled).toBe(1);
    expect(r.skipped).toBe(0);
    expect(r.eventCount).toBe(5);
  });

  it('reads a weekly series in its zone, with the exclusion, the override and the alarms', () => {
    const s = r.series[0]!;
    const m = s.master;
    expect(m).toMatchObject({
      uid: 'standup-1@google.com',
      startAt: '2026-10-05T08:30:00.000Z', // 09:30 summer time in Lisbon
      endAt: '2026-10-05T09:00:00.000Z',
      timezone: 'Europe/Lisbon',
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      simplified: false,
      location: 'Room 1, HQ',
      description: 'Daily sync\nLink: https://meet.google.com/abc-defg-hij',
      alarms: [10, 60],
      organizer: 'Rui Costa',
      attendees: ['Ana Silva'],
      sequence: 1,
    });
    expect(m.exdates).toEqual(['2026-10-19T08:30:00.000Z']);
    expect(exceptionsOf(s)).toEqual([
      {
        originalStart: '2026-10-12T08:30:00.000Z',
        kind: 'override',
        override: {
          title: 'Standup (moved)',
          startAt: '2026-10-12T10:00:00.000Z',
          endAt: '2026-10-12T10:30:00.000Z',
        },
      },
      { originalStart: '2026-10-19T08:30:00.000Z', kind: 'cancelled' },
    ]);
    // Expanded, the series follows the exceptions.
    const out = expandEvent(
      { ...m, exceptions: exceptionsOf(s) },
      Date.UTC(2026, 9, 1),
      Date.UTC(2026, 10, 1),
    );
    expect(out.map((o) => o.start)).toEqual([
      '2026-10-05T08:30:00.000Z',
      '2026-10-12T10:00:00.000Z',
      '2026-10-26T09:30:00.000Z', // after the clocks went back the same wall time is an hour later in UTC
    ]);
  });

  it('reads all-day and UTC events', () => {
    expect(r.series[1]!.master).toMatchObject({
      allDay: true,
      startAt: '2026-12-25T00:00:00.000Z',
      endAt: '2026-12-27T00:00:00.000Z',
      timezone: 'UTC',
    });
    expect(r.series[2]!.master).toMatchObject({
      allDay: false,
      startAt: '2026-11-10T14:30:00.000Z',
      timezone: 'UTC',
      status: 'tentative',
    });
  });
});

describe('Outlook fixture', () => {
  const r = parseIcs(fixture('outlook'));
  const by = (title: string) => r.series.find((s) => s.master.title === title)!.master;

  it('maps Windows zone names and cleans an HTML description', () => {
    expect(r.series).toHaveLength(6);
    const p = by('Planning');
    expect(p.startAt).toBe('2026-07-15T12:00:00.000Z'); // 14:00 in W. Europe summer time
    expect(p.timezone).toBe('Europe/Berlin');
    expect(p.description).toContain('Agenda');
    expect(p.description).toContain('- One & two');
    expect(p.description).toContain('[The doc](https://example.com/doc)');
    expect(p.description).not.toMatch(/alert|</);
    expect(p.videoUrl).toBe('https://teams.microsoft.com/l/meetup-join/abc');
    expect(p.alarms).toEqual([15]);
    expect(by('Winter review').startAt).toBe('2026-12-15T09:00:00.000Z');
  });

  it('uses the offsets of a VTIMEZONE it cannot name, and reads floating times in the chosen zone', () => {
    expect(by('Mumbai call')).toMatchObject({
      startAt: '2026-10-01T03:30:00.000Z',
      timezone: 'UTC',
    });
    expect(by('Floating').startAt).toBe('2026-10-01T08:00:00.000Z');
    const ny = parseIcs(fixture('outlook'), { defaultZone: 'America/New_York' });
    expect(ny.series.find((s) => s.master.title === 'Floating')!.master).toMatchObject({
      startAt: '2026-10-01T12:00:00.000Z',
      timezone: 'America/New_York',
    });
  });

  it('simplifies rules it cannot evaluate', () => {
    expect(by('Busy rule')).toMatchObject({
      rrule: 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=3650',
      simplified: true,
    });
    expect(by('Every hour')).toMatchObject({ rrule: null, simplified: true });
  });
});

describe('Apple fixture', () => {
  const r = parseIcs(fixture('apple'));

  it('reads the series with quoted names, grouped properties and absolute alarms', () => {
    expect(r.name).toBe('Home');
    const m = r.series[0]!.master;
    expect(m).toMatchObject({
      title: 'Book club',
      startAt: '2026-11-02T17:00:00.000Z',
      endAt: '2026-11-02T18:00:00.000Z',
      timezone: 'Europe/Lisbon',
      rrule: 'FREQ=MONTHLY;BYDAY=1MO',
      url: 'https://example.com/club',
      attendees: ['Silva, Ana'],
      alarms: [60, 120],
      exdates: ['2026-12-07T17:00:00.000Z'],
    });
    expect(r.series[1]!.master).toMatchObject({
      title: 'Anniversary',
      allDay: true,
      rrule: 'FREQ=YEARLY',
    });
  });
});

describe('round trip', () => {
  const events: IcsOutEvent[] = [
    {
      uid: 'one@os',
      title: 'Café, planning; "Q4"',
      description: 'Line one\nLine two, with; punctuation \\ backslash',
      location: 'Sala 2, Lisboa',
      startAt: '2026-12-01T09:00:00.000Z',
      endAt: '2026-12-01T10:30:00.000Z',
      allDay: false,
      timezone: 'Europe/Lisbon',
      rrule: null,
      alarms: [10, 1440],
      updatedAt: '2026-11-01T10:00:00.000Z',
    },
    {
      uid: 'weekly@os',
      title: 'Weekly',
      description: '',
      location: null,
      startAt: '2026-03-02T14:00:00.000Z', // 09:00 in New York before summer time
      endAt: '2026-03-02T15:00:00.000Z',
      allDay: false,
      timezone: 'America/New_York',
      rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=10',
      exceptions: [
        {
          originalStart: '2026-03-16T13:00:00.000Z',
          kind: 'override',
          override: {
            title: 'Moved',
            startAt: '2026-03-16T15:00:00.000Z',
            endAt: '2026-03-16T16:00:00.000Z',
          },
        },
        { originalStart: '2026-03-23T13:00:00.000Z', kind: 'cancelled' },
      ],
      alarms: [5],
    },
    {
      uid: 'allday@os',
      title: 'Holiday 🎉 '.repeat(12).trim(),
      description: 'x'.repeat(300),
      location: null,
      startAt: '2026-12-24T00:00:00.000Z',
      endAt: '2026-12-26T00:00:00.000Z',
      allDay: true,
      timezone: 'UTC',
      rrule: 'FREQ=YEARLY',
    },
    {
      uid: 'utc@os',
      title: 'Call',
      description: '',
      location: null,
      startAt: '2026-11-10T14:30:00.000Z',
      endAt: '2026-11-10T15:00:00.000Z',
      allDay: false,
      timezone: 'UTC',
      rrule: null,
    },
  ];
  const text = buildIcs({
    name: 'Mine',
    host: 'planner.test',
    events,
    now: '2026-11-26T00:00:00.000Z',
    refreshMinutes: 60,
  });
  const back = parseIcs(text);

  it('writes a well-formed file', () => {
    expect(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
    for (const line of text.split('\r\n'))
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(text).toContain('BEGIN:VTIMEZONE\r\nTZID:Europe/Lisbon');
    expect(text).toContain('TZID:America/New_York');
    expect(text).toContain('X-PUBLISHED-TTL:PT1H');
    expect(text).toContain('RECURRENCE-ID;TZID=America/New_York:20260316T090000');
    expect(text).toContain('EXDATE;TZID=America/New_York:20260323T090000');
    expect(text).toContain('RRULE:FREQ=YEARLY');
    // The same input gives the same bytes (so a feed can answer 304).
    expect(
      buildIcs({
        name: 'Mine',
        host: 'planner.test',
        events,
        now: '2026-11-26T00:00:00.000Z',
        refreshMinutes: 60,
      }),
    ).toBe(text);
  });

  it('reads back what was written', () => {
    expect(back.series).toHaveLength(4);
    expect(back.skipped).toBe(0);
    for (const e of events) {
      const s = back.series.find((x) => x.uid === e.uid)!;
      expect(s.master).toMatchObject({
        title: e.title,
        description: e.description,
        location: e.location,
        startAt: e.startAt,
        endAt: e.endAt,
        allDay: e.allDay,
        timezone: e.timezone,
        rrule: e.rrule,
        alarms: e.alarms ?? [],
      });
      expect(exceptionsOf(s)).toEqual(
        [...(e.exceptions ?? [])].sort((a, b) => (a.originalStart < b.originalStart ? -1 : 1)),
      );
    }
  });

  it('reads a moved occurrence on the right side of the change of summer time', () => {
    const s = back.series.find((x) => x.uid === 'weekly@os')!;
    const out = expandEvent(
      { ...s.master, exceptions: exceptionsOf(s) },
      Date.UTC(2026, 2, 1),
      Date.UTC(2026, 3, 10),
    );
    expect(out.map((o) => o.start)).toEqual([
      '2026-03-02T14:00:00.000Z',
      '2026-03-09T13:00:00.000Z', // the clocks went forward on 8 March
      '2026-03-16T15:00:00.000Z', // moved occurrence
      '2026-03-30T13:00:00.000Z', // the 23rd was cancelled
      '2026-04-06T13:00:00.000Z',
    ]);
  });
});

describe('time zones', () => {
  it('finds the changes of a zone and writes them as observances', () => {
    const t = zoneTransitions('Europe/Lisbon', Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31));
    expect(
      t.map((x) => [new Date(x.at).toISOString(), x.from / 3_600_000, x.to / 3_600_000]),
    ).toEqual([
      ['2026-03-29T01:00:00.000Z', 0, 1],
      ['2026-10-25T01:00:00.000Z', 1, 0],
    ]);
    const lines = vtimezone('Europe/Lisbon', Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31));
    expect(lines.filter((l) => l === 'BEGIN:DAYLIGHT')).toHaveLength(1);
    expect(lines).toContain('TZOFFSETTO:+0100');
    expect(vtimezone('Asia/Kolkata', Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31))).toContain(
      'TZOFFSETTO:+0530',
    );
  });
});

describe('hostile input', () => {
  const ev = (n: number) =>
    `BEGIN:VEVENT\nUID:e${n}\nDTSTART:20261001T080000Z\nDTEND:20261001T090000Z\nSUMMARY:E${n}\nEND:VEVENT\n`;

  it('refuses what is not a calendar, nesting without end, and too many events', () => {
    expect(() => parseIcs('hello')).toThrowError(IcsParseError);
    expect(() => parseIcs('<html></html>')).toThrowError(/ics_not_a_calendar/);
    expect(() => parseIcs('BEGIN:VCALENDAR\n' + 'BEGIN:X\n'.repeat(100))).toThrowError(
      /ics_not_a_calendar/,
    );
    expect(() =>
      parseIcs(`BEGIN:VCALENDAR\n${ev(1)}${ev(2)}${ev(3)}END:VCALENDAR\n`, { maxEvents: 2 }),
    ).toThrowError(/ics_too_many_events/);
  });

  it('gives up after its time', () => {
    let t = 0;
    expect(() =>
      parseIcs(fixture('google'), { deadlineMs: 100, now: () => (t += 1000) }),
    ).toThrowError(/ics_parse_timeout/);
  });

  it('skips broken events and counts them', () => {
    const text = `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:a\nSUMMARY:No start\nEND:VEVENT\nBEGIN:VEVENT\nUID:b\nDTSTART:2026-10-01\nEND:VEVENT\nBEGIN:VEVENT\nUID:c\nDTSTART:20261001T080000Z\nDTEND:20261001T090000Z\nSUMMARY:Fine\nEND:VEVENT\nEND:VCALENDAR\n`;
    const r = parseIcs(text);
    expect(r.skipped).toBe(2);
    expect(r.series.map((s) => s.uid)).toEqual(['c']);
  });

  it('keeps a single occurrence that came without its series', () => {
    const text = `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:orphan\nRECURRENCE-ID:20261008T080000Z\nDTSTART:20261008T090000Z\nDTEND:20261008T100000Z\nSUMMARY:Just this one\nEND:VEVENT\nEND:VCALENDAR\n`;
    const r = parseIcs(text);
    expect(r.series).toHaveLength(1);
    expect(r.series[0]!.master).toMatchObject({
      title: 'Just this one',
      rrule: null,
      recurrenceId: null,
      startAt: '2026-10-08T09:00:00.000Z',
    });
  });

  it('reads a large file quickly', () => {
    const body = Array.from({ length: 5000 }, (_v, i) => ev(i)).join('');
    const t0 = Date.now();
    expect(parseIcs(`BEGIN:VCALENDAR\n${body}END:VCALENDAR\n`).series).toHaveLength(5000);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});
