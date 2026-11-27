import { CALENDAR_LIMITS } from '../dto/calendar';
import type { EventExceptionDto, EventOverrideDto } from '../dto/calendar';
import { ICS_LIMITS } from '../dto/ics';
import { expandRule, parseRRule, type RRule } from '../calendar/rrule';
import { normalizeTiming } from '../calendar/timing';
import { isValidTimeZone, zonedToUtc } from '../calendar/tz';
import { mapRRule } from './rrule-map';
import { oneLine, plainText, unescapeText, unfold } from './text';
import { WINDOWS_ZONES } from './windows-zones';

// Reading iCalendar files (RFC 5545) from Google, Outlook, Apple and the rest. Tolerant on purpose: what cannot be kept is left out and counted.

export type IcsParseErrorCode = 'ics_not_a_calendar' | 'ics_too_many_events' | 'ics_parse_timeout';

export class IcsParseError extends Error {
  constructor(readonly code: IcsParseErrorCode) {
    super(code);
  }
}

export interface IcsEvent {
  uid: string;
  /** The original start (an instant) of the occurrence this entry replaces; null for a series or a single event. */
  recurrenceId: string | null;
  startAt: string;
  endAt: string;
  allDay: boolean;
  /** IANA zone of the start (`UTC` for all-day events and for times given in UTC). */
  timezone: string;
  title: string;
  description: string;
  location: string | null;
  /** The event's own page. */
  url: string | null;
  /** A link to join (Google Meet, Teams). */
  videoUrl: string | null;
  /** Canonical rule in the subset this calendar evaluates, or null. */
  rrule: string | null;
  /** The rule had parts this calendar cannot keep. */
  simplified: boolean;
  /** Occurrences taken out of the series (instants). */
  exdates: string[];
  status: 'confirmed' | 'tentative' | 'cancelled';
  sequence: number;
  /** Plain names; no addresses are kept. */
  organizer: string | null;
  attendees: string[];
  /** Minutes before the start. */
  alarms: number[];
}

export interface IcsSeries {
  uid: string;
  master: IcsEvent;
  overrides: IcsEvent[];
}

export interface IcsParseResult {
  /** `X-WR-CALNAME`. */
  name: string | null;
  series: IcsSeries[];
  /** Events and overrides read (before they were grouped). */
  eventCount: number;
  /** Parts that are not events, by kind. */
  unsupported: { component: string; count: number }[];
  /** Events that were broken (no start, impossible times...) and left out. */
  skipped: number;
  /** Events whose status is cancelled and that were left out. */
  cancelled: number;
}

export interface ParseOptions {
  /** Zone for times written without one. */
  defaultZone?: string;
  maxEvents?: number;
  /** The whole parse gives up after this long (a guard against hostile files). */
  deadlineMs?: number;
  now?: () => number;
}

// ---------------------------------------------------------------- lines and components

interface Prop {
  name: string;
  params: Map<string, string>;
  value: string;
}

interface Comp {
  name: string;
  props: Prop[];
  children: Comp[];
}

function parseLine(line: string): Prop | null {
  let i = 0;
  while (i < line.length && line[i] !== ';' && line[i] !== ':') i++;
  if (i === 0 || i >= line.length) return null;
  let name = line.slice(0, i).toUpperCase();
  const dot = name.lastIndexOf('.');
  if (dot >= 0) name = name.slice(dot + 1);
  const params = new Map<string, string>();
  while (line[i] === ';') {
    i++;
    let j = i;
    while (j < line.length && line[j] !== '=' && line[j] !== ':' && line[j] !== ';') j++;
    if (line[j] !== '=') {
      i = j;
      continue;
    }
    const key = line.slice(i, j).toUpperCase();
    i = j + 1;
    let value = '';
    for (;;) {
      if (line[i] === '"') {
        const end = line.indexOf('"', i + 1);
        const stop = end < 0 ? line.length : end;
        value += line.slice(i + 1, stop);
        i = stop + 1;
      } else {
        let k = i;
        while (k < line.length && line[k] !== ',' && line[k] !== ';' && line[k] !== ':') k++;
        value += line.slice(i, k);
        i = k;
      }
      if (line[i] === ',') {
        value += ',';
        i++;
        continue;
      }
      break;
    }
    if (!params.has(key)) params.set(key, value);
  }
  if (line[i] !== ':') return null;
  return { name, params, value: line.slice(i + 1) };
}

function tokenize(
  text: string,
  opts: Required<Pick<ParseOptions, 'now'>> & { deadline: number },
): Comp[] {
  const root: Comp = { name: '', props: [], children: [] };
  const stack: Comp[] = [root];
  let n = 0;
  for (const line of unfold(text)) {
    if (++n % 2000 === 0 && opts.now() > opts.deadline)
      throw new IcsParseError('ics_parse_timeout');
    if (!line) continue;
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      const c: Comp = { name: p.value.trim().toUpperCase(), props: [], children: [] };
      stack.at(-1)!.children.push(c);
      stack.push(c);
      // Real files nest three levels (calendar, event, alarm); anything much deeper is hostile.
      if (stack.length > 16) throw new IcsParseError('ics_not_a_calendar');
    } else if (p.name === 'END') {
      const want = p.value.trim().toUpperCase();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]!.name === want) {
          stack.length = k;
          break;
        }
      }
    } else stack.at(-1)!.props.push(p);
  }
  return root.children;
}

// ---------------------------------------------------------------- time zones

interface Observance {
  onset: number;
  from: number;
  to: number;
  rule: RRule | null;
  rdates: number[];
}

interface Vtz {
  location: string | null;
  obs: Observance[];
}

const DAY = 86_400_000;

const parseOffset = (v: string): number | null => {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(v.trim());
  if (!m) return null;
  const ms = (Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] ?? 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
};

const DATE_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/;
const DATE_ONLY = /^(\d{4})(\d{2})(\d{2})$/;

/** `20261201T090000` as a wall-clock reading (milliseconds as if it were UTC), or null. */
const localMs = (v: string): number | null => {
  const m = DATE_TIME.exec(v.trim());
  if (!m) return null;
  const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
  return Number.isNaN(ms) ? null : ms;
};

function readVtz(c: Comp): { id: string; vtz: Vtz } | null {
  const id = c.props.find((p) => p.name === 'TZID')?.value.trim();
  if (!id) return null;
  const location = c.props.find((p) => p.name === 'X-LIC-LOCATION')?.value.trim() ?? null;
  const obs: Observance[] = [];
  for (const o of c.children) {
    if (o.name !== 'STANDARD' && o.name !== 'DAYLIGHT') continue;
    const onset = localMs(o.props.find((p) => p.name === 'DTSTART')?.value ?? '');
    const to = parseOffset(o.props.find((p) => p.name === 'TZOFFSETTO')?.value ?? '');
    const from = parseOffset(o.props.find((p) => p.name === 'TZOFFSETFROM')?.value ?? '');
    if (onset === null || to === null) continue;
    const ruleText = o.props.find((p) => p.name === 'RRULE')?.value;
    const parsed = ruleText ? parseRRule(ruleText) : null;
    const rdates: number[] = [];
    for (const r of o.props.filter((p) => p.name === 'RDATE'))
      for (const part of r.value.split(',')) {
        const t = localMs(part);
        if (t !== null) rdates.push(t);
      }
    obs.push({ onset, from: from ?? to, to, rule: parsed?.ok ? parsed.rule : null, rdates });
  }
  return obs.length ? { id, vtz: { location, obs } } : null;
}

/** The offset (ms, east positive) a VTIMEZONE gives to a wall-clock time. */
function vtzOffset(vtz: Vtz, local: number): number {
  let best: { at: number; to: number } | null = null;
  for (const o of vtz.obs) {
    const onsets = [o.onset, ...o.rdates];
    if (o.rule && local >= o.onset)
      onsets.push(
        ...expandRule({
          startMs: o.onset,
          tz: 'UTC',
          rule: o.rule,
          fromMs: o.onset,
          toMs: local,
          max: 2000,
        }),
      );
    for (const t of onsets) if (t <= local && (!best || t > best.at)) best = { at: t, to: o.to };
  }
  if (best) return best.to;
  const first = [...vtz.obs].sort((a, b) => a.onset - b.onset)[0];
  return first?.from ?? 0;
}

type Zone = { kind: 'iana'; name: string } | { kind: 'vtz'; vtz: Vtz };

interface Ctx {
  defaultZone: string;
  vtz: Map<string, Vtz>;
}

function zoneOf(tzid: string | undefined, ctx: Ctx): Zone | null {
  if (!tzid) return null;
  let id = tzid.trim();
  if (isValidTimeZone(id)) return { kind: 'iana', name: id };
  const win = WINDOWS_ZONES[id.replace(/^"|"$/g, '')];
  if (win && isValidTimeZone(win)) return { kind: 'iana', name: win };
  // Mozilla-style identifiers: /mozilla.org/20070129_1/Europe/Lisbon.
  const tail = id.split('/').slice(-2).join('/');
  if (tail !== id && isValidTimeZone(tail)) return { kind: 'iana', name: tail };
  id = tzid.trim();
  const vtz = ctx.vtz.get(id);
  if (vtz) {
    if (vtz.location && isValidTimeZone(vtz.location)) return { kind: 'iana', name: vtz.location };
    return { kind: 'vtz', vtz };
  }
  return null;
}

interface When {
  ms: number;
  allDay: boolean;
  /** The IANA zone the time was written in (`UTC` for a `Z` time). */
  zone: string;
}

function readWhen(value: string, params: Map<string, string>, ctx: Ctx): When | null {
  const v = value.trim();
  const d = DATE_ONLY.exec(v);
  if (d && (params.get('VALUE') === 'DATE' || !params.has('VALUE'))) {
    const ms = Date.UTC(+d[1]!, +d[2]! - 1, +d[3]!);
    if (Number.isNaN(ms) || new Date(ms).getUTCMonth() !== +d[2]! - 1) return null;
    return { ms, allDay: true, zone: 'UTC' };
  }
  const m = DATE_TIME.exec(v);
  if (!m) return null;
  const wall = localMs(v);
  if (wall === null) return null;
  if (m[7]) return { ms: wall, allDay: false, zone: 'UTC' };
  const parts = {
    y: +m[1]!,
    m: +m[2]!,
    d: +m[3]!,
    h: +m[4]!,
    mi: +m[5]!,
    s: +(m[6] ?? 0),
  };
  const zone = zoneOf(params.get('TZID'), ctx);
  if (zone?.kind === 'iana')
    return { ms: zonedToUtc(parts, zone.name), allDay: false, zone: zone.name };
  if (zone?.kind === 'vtz')
    return { ms: wall - vtzOffset(zone.vtz, wall), allDay: false, zone: 'UTC' };
  // Floating time (or a zone nobody knows): the person's own zone.
  return { ms: zonedToUtc(parts, ctx.defaultZone), allDay: false, zone: ctx.defaultZone };
}

// ---------------------------------------------------------------- durations and alarms

const DURATION = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** A duration in milliseconds (negative for a leading minus), or null. */
function readDuration(v: string): number | null {
  const m = DURATION.exec(v.trim());
  if (!m || v.trim().length <= 1) return null;
  const ms =
    ((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 86400 +
      +(m[4] ?? 0) * 3600 +
      +(m[5] ?? 0) * 60 +
      +(m[6] ?? 0)) *
    1000;
  return m[1] === '-' ? -ms : ms;
}

function readAlarms(c: Comp, start: number, end: number, ctx: Ctx): number[] {
  const out: number[] = [];
  for (const a of c.children) {
    if (a.name !== 'VALARM') continue;
    const t = a.props.find((p) => p.name === 'TRIGGER');
    if (!t) continue;
    let before: number | null = null; // ms before the start
    if (t.params.get('VALUE') === 'DATE-TIME') {
      const w = readWhen(t.value, t.params, ctx);
      if (w) before = start - w.ms;
    } else {
      const d = readDuration(t.value);
      if (d !== null) before = t.params.get('RELATED') === 'END' ? -d - (end - start) : -d;
    }
    if (before === null || before < 0) continue;
    const minutes = Math.round(before / 60_000);
    if (minutes <= CALENDAR_LIMITS.reminderMaxMinutes && !out.includes(minutes)) out.push(minutes);
  }
  return out.sort((a, b) => a - b).slice(0, CALENDAR_LIMITS.remindersPerEvent);
}

// ---------------------------------------------------------------- events

const first = (c: Comp, name: string): Prop | undefined => c.props.find((p) => p.name === name);
const httpUrl = (v: string | undefined): string | null => {
  const s = v?.trim();
  return s && /^https?:\/\/[^\s]+$/i.test(s) && s.length <= CALENDAR_LIMITS.urlMax ? s : null;
};
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

function readEvent(c: Comp, ctx: Ctx): IcsEvent | 'skip' {
  const ds = first(c, 'DTSTART');
  if (!ds) return 'skip';
  const start = readWhen(ds.value, ds.params, ctx);
  if (!start) return 'skip';

  let endMs: number;
  const de = first(c, 'DTEND') ?? first(c, 'DUE');
  const dur = first(c, 'DURATION');
  if (de) {
    const e = readWhen(de.value, de.params, ctx);
    if (!e || e.allDay !== start.allDay) return 'skip';
    endMs = e.ms;
  } else if (dur) {
    const d = readDuration(dur.value);
    if (d === null || d < 0) return 'skip';
    endMs = start.ms + d;
  } else endMs = start.allDay ? start.ms + DAY : start.ms;
  if (start.allDay && endMs <= start.ms) endMs = start.ms + DAY;
  if (endMs < start.ms) endMs = start.ms;

  const rid = first(c, 'RECURRENCE-ID');
  let recurrenceId: string | null = null;
  if (rid) {
    if ((rid.params.get('RANGE') ?? '').toUpperCase() === 'THISANDFUTURE') return 'skip';
    const w = readWhen(rid.value, rid.params, ctx);
    if (!w) return 'skip';
    recurrenceId = new Date(w.ms).toISOString();
  }

  let rrule: string | null = null;
  let simplified = false;
  const rr = first(c, 'RRULE');
  if (rr && !rid) {
    const mapped = mapRRule(rr.value);
    rrule = mapped.rrule;
    simplified = mapped.simplified;
  }
  if (c.props.some((p) => p.name === 'RDATE')) simplified = true;

  const exdates: string[] = [];
  if (!rid)
    for (const x of c.props.filter((p) => p.name === 'EXDATE'))
      for (const part of x.value.split(',')) {
        const w = readWhen(part, x.params, ctx);
        if (!w) continue;
        // An all-day exclusion names a day; a timed series that is excluded by day loses the occurrence at the start's time of day.
        const ms = !w.allDay || start.allDay ? w.ms : w.ms + (start.ms % DAY);
        exdates.push(new Date(ms).toISOString());
      }

  const timing = normalizeTiming({
    startAt: new Date(start.ms).toISOString(),
    endAt: new Date(endMs).toISOString(),
    allDay: start.allDay,
    timezone: start.zone,
    rrule,
  });
  if (!timing.ok) {
    // A rule that does not fit the timing (e.g. an end-less rule on a year-long event) is dropped; anything else is a broken event.
    if (!rrule) return 'skip';
    const bare = normalizeTiming({
      startAt: new Date(start.ms).toISOString(),
      endAt: new Date(endMs).toISOString(),
      allDay: start.allDay,
      timezone: start.zone,
      rrule: null,
    });
    if (!bare.ok) return 'skip';
    rrule = null;
    simplified = true;
    return finish(c, ctx, bare.value, rrule, simplified, exdates, recurrenceId, start.ms, endMs);
  }
  return finish(
    c,
    ctx,
    timing.value,
    timing.value.rrule,
    simplified,
    exdates,
    recurrenceId,
    start.ms,
    endMs,
  );
}

function finish(
  c: Comp,
  ctx: Ctx,
  t: { startAt: string; endAt: string; allDay: boolean; timezone: string },
  rrule: string | null,
  simplified: boolean,
  exdates: string[],
  recurrenceId: string | null,
  startMs: number,
  endMs: number,
): IcsEvent {
  const title = oneLine(unescapeText(first(c, 'SUMMARY')?.value ?? ''));
  const description = plainText(unescapeText(first(c, 'DESCRIPTION')?.value ?? ''));
  const location = oneLine(unescapeText(first(c, 'LOCATION')?.value ?? ''));
  const url = httpUrl(first(c, 'URL')?.value);
  const video =
    httpUrl(first(c, 'X-GOOGLE-CONFERENCE')?.value) ??
    httpUrl(first(c, 'X-MICROSOFT-SKYPETEAMSMEETINGURL')?.value);
  const status = (first(c, 'STATUS')?.value ?? '').trim().toUpperCase();
  const names = (name: string): string[] =>
    c.props
      .filter((p) => p.name === name)
      .map((p) => oneLine(p.params.get('CN') ?? ''))
      .filter(Boolean)
      .map((n) => clip(n, 100));
  const uidRaw = first(c, 'UID')?.value.trim();
  return {
    uid: clip(uidRaw || `noid-${t.startAt}-${title}`, 255),
    recurrenceId,
    startAt: t.startAt,
    endAt: t.endAt,
    allDay: t.allDay,
    timezone: t.timezone,
    title: clip(title || '(no title)', CALENDAR_LIMITS.titleMax),
    description: clip(description, CALENDAR_LIMITS.descriptionMax),
    location: location ? clip(location, CALENDAR_LIMITS.locationMax) : null,
    url,
    videoUrl:
      video ?? (url && /meet\.google\.com|teams\.microsoft\.com|zoom\.us/i.test(url) ? url : null),
    rrule,
    simplified,
    exdates: [...new Set(exdates)],
    status:
      status === 'CANCELLED' ? 'cancelled' : status === 'TENTATIVE' ? 'tentative' : 'confirmed',
    sequence: Math.max(0, parseInt(first(c, 'SEQUENCE')?.value ?? '0', 10) || 0),
    organizer: names('ORGANIZER')[0] ?? null,
    attendees: [...new Set(names('ATTENDEE'))].slice(0, 100),
    alarms: readAlarms(c, startMs, endMs, ctx),
  };
}

// ---------------------------------------------------------------- the file

/** Reads a calendar file. Throws `IcsParseError` for something that is not a calendar, has too many events, or takes too long. */
export function parseIcs(text: string, options: ParseOptions = {}): IcsParseResult {
  const now = options.now ?? (() => Date.now());
  const deadline = now() + (options.deadlineMs ?? 5000);
  const comps = tokenize(text, { now, deadline });
  const calendars = comps.filter((c) => c.name === 'VCALENDAR');
  if (!calendars.length) throw new IcsParseError('ics_not_a_calendar');

  const maxEvents = options.maxEvents ?? ICS_LIMITS.maxEvents;
  const unsupported = new Map<string, number>();
  const events: IcsEvent[] = [];
  let name: string | null = null;
  let skipped = 0;
  let cancelled = 0;

  for (const cal of calendars) {
    const nameProp = first(cal, 'X-WR-CALNAME');
    if (nameProp && !name)
      name = clip(oneLine(unescapeText(nameProp.value)), ICS_LIMITS.nameMax) || null;
    const calZone = first(cal, 'X-WR-TIMEZONE')?.value.trim();
    const ctx: Ctx = {
      defaultZone:
        (options.defaultZone && isValidTimeZone(options.defaultZone)
          ? options.defaultZone
          : null) ?? (calZone && isValidTimeZone(calZone) ? calZone : 'UTC'),
      vtz: new Map(),
    };
    for (const c of cal.children) {
      if (c.name !== 'VTIMEZONE') continue;
      const v = readVtz(c);
      if (v) ctx.vtz.set(v.id, v.vtz);
    }
    for (const c of cal.children) {
      if (now() > deadline) throw new IcsParseError('ics_parse_timeout');
      if (c.name === 'VTIMEZONE') continue;
      if (c.name !== 'VEVENT') {
        unsupported.set(c.name, (unsupported.get(c.name) ?? 0) + 1);
        continue;
      }
      if (events.length + skipped + cancelled >= maxEvents)
        throw new IcsParseError('ics_too_many_events');
      const ev = readEvent(c, ctx);
      if (ev === 'skip') skipped++;
      else events.push(ev);
    }
  }

  // Group by UID: the entry without a recurrence id is the series, the others replace single occurrences.
  const masters = new Map<string, IcsEvent>();
  const overrides = new Map<string, IcsEvent[]>();
  for (const e of events) {
    if (e.recurrenceId === null) {
      const had = masters.get(e.uid);
      if (!had || e.sequence >= had.sequence) masters.set(e.uid, e);
    } else (overrides.get(e.uid) ?? overrides.set(e.uid, []).get(e.uid)!).push(e);
  }
  const series: IcsSeries[] = [];
  for (const [uid, master] of masters) {
    if (master.status === 'cancelled') {
      cancelled++;
      continue;
    }
    series.push({ uid, master, overrides: overrides.get(uid) ?? [] });
  }
  // An override whose series is not in the file (the person was invited to one occurrence) stands alone.
  for (const [uid, list] of overrides) {
    if (masters.has(uid)) continue;
    for (const o of list) {
      if (o.status === 'cancelled') {
        cancelled++;
        continue;
      }
      series.push({
        uid: `${uid}~${o.recurrenceId}`,
        master: {
          ...o,
          uid: `${uid}~${o.recurrenceId}`,
          recurrenceId: null,
          rrule: null,
          exdates: [],
        },
        overrides: [],
      });
    }
  }
  return {
    name,
    series,
    eventCount: events.length,
    unsupported: [...unsupported]
      .map(([component, count]) => ({ component, count }))
      .sort((a, b) => a.component.localeCompare(b.component)),
    skipped,
    cancelled,
  };
}

/** The exceptions of a series: occurrences taken out (EXDATE or a cancelled override) and changed ones, as the calendar stores them. */
export function exceptionsOf(series: IcsSeries): EventExceptionDto[] {
  const m = series.master;
  const out = new Map<string, EventExceptionDto>();
  for (const x of m.exdates) out.set(x, { originalStart: x, kind: 'cancelled' });
  const duration = new Date(m.endAt).getTime() - new Date(m.startAt).getTime();
  for (const o of series.overrides) {
    const original = o.recurrenceId!;
    if (o.status === 'cancelled') {
      out.set(original, { originalStart: original, kind: 'cancelled' });
      continue;
    }
    const ov: EventOverrideDto = {};
    if (o.title !== m.title) ov.title = o.title;
    if (o.description !== m.description) ov.description = o.description;
    if (o.location !== m.location) ov.location = o.location;
    if (o.videoUrl !== m.videoUrl) ov.videoUrl = o.videoUrl;
    const oDuration = new Date(o.endAt).getTime() - new Date(o.startAt).getTime();
    if (o.startAt !== original) {
      ov.startAt = o.startAt;
      ov.endAt = o.endAt;
    } else if (oDuration !== duration) ov.endAt = o.endAt;
    if (Object.keys(ov).length)
      out.set(original, { originalStart: original, kind: 'override', override: ov });
  }
  return [...out.values()]
    .sort((a, b) => (a.originalStart < b.originalStart ? -1 : 1))
    .slice(0, CALENDAR_LIMITS.exceptionsPerEvent);
}
