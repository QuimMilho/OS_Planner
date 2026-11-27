import type { EventExceptionDto } from '../dto/calendar';
import { offsetAt, partsInZone } from '../calendar/tz';
import { parseRRule } from '../calendar/rrule';
import { escapeText, fold } from './text';

// Writing iCalendar files: the feed, and the export of one event or a range. Timed events carry their IANA zone with a generated
// VTIMEZONE (so Outlook, which does not know IANA names, can read them) and are written so that `parseIcs` reads them back identically.

export interface IcsOutEvent {
  uid: string;
  title: string;
  description: string;
  location: string | null;
  url?: string | null;
  startAt: string;
  endAt: string;
  allDay: boolean;
  timezone: string;
  rrule: string | null;
  exceptions?: readonly EventExceptionDto[];
  status?: 'confirmed' | 'tentative' | 'cancelled';
  /** DTSTAMP and LAST-MODIFIED. */
  updatedAt?: string;
  organizer?: string | null;
  /** The person the file is for, with how they answered. */
  attendee?: {
    name: string;
    email: string | null;
    partstat: 'ACCEPTED' | 'DECLINED' | 'TENTATIVE' | 'NEEDS-ACTION';
  } | null;
  /** Minutes before the start. */
  alarms?: readonly number[];
}

export interface BuildOptions {
  name: string;
  /** Used in `PRODID` and for the address of attendees without one. */
  host: string;
  events: readonly IcsOutEvent[];
  /** Tells apps how often to look again (feeds). */
  refreshMinutes?: number;
  /** Default DTSTAMP. */
  now?: string;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

const fmtUtc = (ms: number): string => {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
};

const fmtDate = (ms: number): string => {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
};

const fmtLocal = (ms: number, tz: string): string => {
  const p = partsInZone(ms, tz);
  return `${pad(p.y, 4)}${pad(p.m)}${pad(p.d)}T${pad(p.h)}${pad(p.mi)}${pad(p.s)}`;
};

const fmtOffset = (ms: number): string => {
  const sign = ms < 0 ? '-' : '+';
  const total = Math.abs(Math.round(ms / 1000));
  return `${sign}${pad(Math.floor(total / 3600))}${pad(Math.floor((total % 3600) / 60))}${total % 60 ? pad(total % 60) : ''}`;
};

// ---------------------------------------------------------------- VTIMEZONE

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** The moments the offset of a zone changes between two instants: found by looking day by day, then narrowed to the minute. */
export function zoneTransitions(
  tz: string,
  fromMs: number,
  toMs: number,
): { at: number; from: number; to: number }[] {
  const out: { at: number; from: number; to: number }[] = [];
  let prevT = fromMs;
  let prevO = offsetAt(prevT, tz);
  for (let t = fromMs + DAY; ; t += DAY) {
    const cur = Math.min(t, toMs);
    const o = offsetAt(cur, tz);
    if (o !== prevO) {
      let lo = prevT;
      let hi = cur;
      while (hi - lo > 60_000) {
        const mid = Math.floor((lo + hi) / 2 / 60_000) * 60_000;
        if (mid <= lo) break;
        if (offsetAt(mid, tz) === prevO) lo = mid;
        else hi = mid;
      }
      out.push({ at: hi, from: prevO, to: o });
    }
    prevT = cur;
    prevO = o;
    if (cur >= toMs) break;
  }
  return out;
}

/** The lines of a VTIMEZONE for a zone, covering [fromMs, toMs] (outside it a reader keeps the nearest observance). */
export function vtimezone(tz: string, fromMs: number, toMs: number): string[] {
  const lines = ['BEGIN:VTIMEZONE', `TZID:${tz}`, `X-LIC-LOCATION:${tz}`];
  const changes = zoneTransitions(tz, fromMs, toMs);
  const base = offsetAt(fromMs, tz);
  const all = [base, ...changes.map((c) => c.to)];
  const standard = Math.min(...all);
  const observance = (
    kind: 'STANDARD' | 'DAYLIGHT',
    onsetLocal: string,
    from: number,
    to: number,
  ) => {
    lines.push(
      `BEGIN:${kind}`,
      `DTSTART:${onsetLocal}`,
      `TZOFFSETFROM:${fmtOffset(from)}`,
      `TZOFFSETTO:${fmtOffset(to)}`,
      `END:${kind}`,
    );
  };
  if (!changes.length) {
    observance('STANDARD', '19700101T000000', base, base);
  } else {
    // The state in force at the start of the range, then each change.
    const first = changes[0]!;
    observance(
      base > standard ? 'DAYLIGHT' : 'STANDARD',
      fmtLocal(fromMs - 365 * DAY, 'UTC'),
      first.from,
      base,
    );
    for (const c of changes)
      observance(
        c.to > standard ? 'DAYLIGHT' : 'STANDARD',
        fmtLocal(c.at + c.from, 'UTC'),
        c.from,
        c.to,
      );
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

// ---------------------------------------------------------------- events

const prop = (name: string, value: string, params = ''): string => `${name}${params}:${value}`;
const text = (name: string, value: string, params = ''): string =>
  `${name}${params}:${escapeText(value)}`;
const cnParam = (name: string): string => `;CN="${name.replace(/["\r\n]/g, ' ')}"`;

const alarm = (title: string, minutes: number): string[] => [
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  text('DESCRIPTION', title || 'Reminder'),
  `TRIGGER:${minutes === 0 ? 'PT0S' : `-PT${minutes}M`}`,
  'END:VALARM',
];

/** `UNTIL` of a rule written for an all-day start must be a date. */
const ruleFor = (rrule: string, allDay: boolean): string => {
  const parsed = parseRRule(rrule);
  if (!parsed.ok || !allDay) return rrule;
  return rrule.replace(/UNTIL=(\d{8})T\d{6}Z?/, 'UNTIL=$1');
};

function dtLine(
  name: 'DTSTART' | 'DTEND' | 'RECURRENCE-ID' | 'EXDATE',
  ms: number,
  e: IcsOutEvent,
): string {
  if (e.allDay) return prop(name, fmtDate(ms), ';VALUE=DATE');
  if (e.timezone === 'UTC') return prop(name, fmtUtc(ms));
  return prop(name, fmtLocal(ms, e.timezone), `;TZID=${e.timezone}`);
}

function eventLines(e: IcsOutEvent, now: string, host: string): string[] {
  const start = new Date(e.startAt).getTime();
  const end = new Date(e.endAt).getTime();
  const stamp = fmtUtc(new Date(e.updatedAt ?? now).getTime());
  const common = (title: string, description: string, location: string | null): string[] => {
    const l: string[] = [text('SUMMARY', title)];
    if (description) l.push(text('DESCRIPTION', description));
    if (location) l.push(text('LOCATION', location));
    if (e.url) l.push(prop('URL', e.url));
    return l;
  };
  const lines: string[] = [
    'BEGIN:VEVENT',
    prop('UID', e.uid),
    prop('DTSTAMP', stamp),
    dtLine('DTSTART', start, e),
    dtLine('DTEND', end, e),
  ];
  if (e.rrule) lines.push(prop('RRULE', ruleFor(e.rrule, e.allDay)));
  const cancelled = (e.exceptions ?? []).filter((x) => x.kind === 'cancelled');
  if (e.rrule)
    for (const x of cancelled) lines.push(dtLine('EXDATE', new Date(x.originalStart).getTime(), e));
  lines.push(...common(e.title, e.description, e.location));
  lines.push(prop('STATUS', (e.status ?? 'confirmed').toUpperCase()), prop('LAST-MODIFIED', stamp));
  if (e.organizer) lines.push(prop('ORGANIZER', `mailto:noreply@${host}`, cnParam(e.organizer)));
  if (e.attendee)
    lines.push(
      prop(
        'ATTENDEE',
        `mailto:${e.attendee.email ?? `noreply@${host}`}`,
        `${cnParam(e.attendee.name)};PARTSTAT=${e.attendee.partstat}`,
      ),
    );
  for (const m of e.alarms ?? []) lines.push(...alarm(e.title, m));
  lines.push('END:VEVENT');

  if (e.rrule) {
    const duration = end - start;
    for (const x of e.exceptions ?? []) {
      if (x.kind !== 'override' || !x.override) continue;
      const o = x.override;
      const original = new Date(x.originalStart).getTime();
      const s = o.startAt ? new Date(o.startAt).getTime() : original;
      const en = o.endAt ? new Date(o.endAt).getTime() : s + duration;
      lines.push(
        'BEGIN:VEVENT',
        prop('UID', e.uid),
        prop('DTSTAMP', stamp),
        dtLine('RECURRENCE-ID', original, e),
        dtLine('DTSTART', s, e),
        dtLine('DTEND', en, e),
        ...common(
          o.title ?? e.title,
          o.description ?? e.description,
          o.location !== undefined ? o.location : e.location,
        ),
        prop('STATUS', (e.status ?? 'confirmed').toUpperCase()),
        prop('LAST-MODIFIED', stamp),
      );
      for (const m of e.alarms ?? []) lines.push(...alarm(o.title ?? e.title, m));
      lines.push('END:VEVENT');
    }
  }
  return lines;
}

/** A calendar file, ready to send: CRLF line ends, folded at 75 octets. */
export function buildIcs(o: BuildOptions): string {
  const now = o.now ?? new Date().toISOString();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//OS_Planner//${o.host}//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    text('X-WR-CALNAME', o.name),
  ];
  if (o.refreshMinutes) {
    const dur =
      o.refreshMinutes % 60 === 0 ? `PT${o.refreshMinutes / 60}H` : `PT${o.refreshMinutes}M`;
    lines.push(`REFRESH-INTERVAL;VALUE=DURATION:${dur}`, `X-PUBLISHED-TTL:${dur}`);
  }

  // One VTIMEZONE per zone used, covering the events and a few years beyond (or beyond now for series without an end).
  const nowMs = new Date(now).getTime();
  const spans = new Map<string, { from: number; to: number }>();
  for (const e of o.events) {
    if (e.allDay || e.timezone === 'UTC') continue;
    const s = new Date(e.startAt).getTime();
    const open = e.rrule && !/COUNT=|UNTIL=/.test(e.rrule);
    const hi =
      Math.max(new Date(e.endAt).getTime(), open ? nowMs + 5 * 365 * DAY : 0) +
      (e.rrule ? 366 * DAY : 0);
    const cur = spans.get(e.timezone);
    spans.set(e.timezone, { from: Math.min(cur?.from ?? s, s), to: Math.max(cur?.to ?? hi, hi) });
  }
  for (const [tz, span] of spans) {
    const from = Math.max(span.from - 366 * DAY, Date.UTC(1970, 0, 1), nowMs - 40 * 365 * DAY);
    const to = Math.min(Math.max(span.to, from + HOUR), nowMs + 40 * 365 * DAY);
    lines.push(...vtimezone(tz, from, to));
  }
  for (const e of o.events) lines.push(...eventLines(e, now, o.host));
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
