import {
  dateOfDay,
  dayNumber,
  expandEvent,
  partsInZone,
  zonedToUtc,
} from '@os-planner/shared/calendar';
import type { CalendarItemDto, EventDto, TaskDto } from '@os-planner/shared';

export const DAY_MS = 86_400_000;
export const SNAP_MIN = 15;

/** The zone the person's own time is shown in: their setting, else the one of this device. */
export const deviceZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/** One thing on the calendar, ready to draw: an occurrence of an event, or a task with a date. */
export interface Entry {
  key: string;
  source: 'event' | 'task' | 'external';
  id: string;
  spaceId: string;
  title: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  originalStart?: string;
  recurring?: boolean;
  kind?: 'meeting' | 'event';
  rsvp?: string | null;
  completed?: boolean;
  boardId?: string;
  location?: string | null;
  conflict?: boolean;
  /** An event of a calendar the person follows (phase 14): read only, in its own colour. */
  color?: string;
  sourceName?: string;
  url?: string | null;
  note?: string;
}

/** Entries of the calendars the person follows. Their `spaceId` is the id of the calendar, so the same switches hide them. */
export function externalEntries(items: readonly CalendarItemDto[]): Entry[] {
  const out: Entry[] = [];
  for (const i of items) {
    if (i.source !== 'external') continue;
    out.push({
      key: i.key,
      source: 'external',
      id: i.id,
      spaceId: i.calendarId ?? '',
      title: i.title,
      startMs: new Date(i.start).getTime(),
      endMs: new Date(i.end).getTime(),
      allDay: i.allDay,
      ...(i.originalStart ? { originalStart: i.originalStart } : {}),
      ...(i.recurring ? { recurring: true } : {}),
      location: i.location ?? null,
      color: i.color ?? '#6b7280',
      sourceName: i.sourceName ?? '',
      url: i.url ?? null,
      note: i.note ?? '',
    });
  }
  return out;
}

export type View = 'month' | 'week' | 'day' | 'agenda';
export const VIEWS: readonly View[] = ['month', 'week', 'day', 'agenda'];

/** The calendar day (day number) an instant falls on in a zone. */
export const dayOf = (ms: number, tz: string): number => {
  const p = partsInZone(ms, tz);
  return dayNumber(p.y, p.m, p.d);
};

/** The first instant of a calendar day in a zone. */
export const startOfDay = (day: number, tz: string): number => {
  const d = dateOfDay(day);
  return zonedToUtc({ y: d.y, m: d.m, d: d.d, h: 0, mi: 0, s: 0 }, tz);
};

/** The instant at `minutes` after midnight of a day (wall clock), in a zone. */
export const atMinute = (day: number, minutes: number, tz: string): number => {
  const d = dateOfDay(day);
  return zonedToUtc(
    { y: d.y, m: d.m, d: d.d, h: Math.floor(minutes / 60), mi: minutes % 60, s: 0 },
    tz,
  );
};

/** Minutes after midnight of an instant on its day in a zone. */
export const minuteOf = (ms: number, tz: string): number => {
  const p = partsInZone(ms, tz);
  return p.h * 60 + p.mi;
};

export const isoDay = (day: number): string => {
  const d = dateOfDay(day);
  return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
};

export const dayFromIso = (iso: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? dayNumber(Number(m[1]), Number(m[2]), Number(m[3])) : null;
};

/** The first day of the week that holds `day`. */
export const weekStart = (day: number, wkst: number): number =>
  day - ((dateOfDay(day).dow - wkst + 7) % 7);

/** The first of the month of `day`. */
export const monthStart = (day: number): number => {
  const d = dateOfDay(day);
  return dayNumber(d.y, d.m, 1);
};

export const addMonths = (day: number, n: number): number => {
  const d = dateOfDay(day);
  const total = d.y * 12 + (d.m - 1) + n;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return dayNumber(y, m, Math.min(d.d, new Date(Date.UTC(y, m, 0)).getUTCDate()));
};

/** The days an entry covers (day numbers, in the display zone; all-day entries are whole days of the calendar and ignore the zone). */
export function daysOf(e: Entry, tz: string): number[] {
  const first = e.allDay ? dayOf(e.startMs, 'UTC') : dayOf(e.startMs, tz);
  const last = e.allDay
    ? dayOf(Math.max(e.startMs, e.endMs - 1), 'UTC')
    : dayOf(Math.max(e.startMs, e.endMs - 1), tz);
  const out: number[] = [];
  for (let d = first; d <= last && out.length < 400; d++) out.push(d);
  return out;
}

/** Expands events and lays tasks over a window of instants. Cancelled and declined ones are not here. */
export function entriesBetween(
  events: readonly EventDto[],
  tasks: readonly TaskDto[],
  me: string,
  fromMs: number,
  toMs: number,
  show: { meetings: boolean; events: boolean; tasks: boolean; declined?: boolean },
): Entry[] {
  const out: Entry[] = [];
  for (const e of events) {
    if (e.deletedAt) continue;
    if (e.kind === 'meeting' ? !show.meetings : !show.events) continue;
    if (e.me?.status === 'declined' && !show.declined) continue;
    for (const o of expandEvent(e, fromMs, toMs, 2000)) {
      out.push({
        key: `${e.id}@${o.originalStart}`,
        source: 'event',
        id: e.id,
        spaceId: e.spaceId,
        title: o.override?.title ?? e.title,
        startMs: new Date(o.start).getTime(),
        endMs: new Date(o.end).getTime(),
        allDay: e.allDay,
        originalStart: o.originalStart,
        recurring: !!e.rrule,
        kind: e.kind,
        rsvp: e.me?.status ?? null,
        location: o.override?.location !== undefined ? o.override.location : e.location,
      });
    }
  }
  if (show.tasks) {
    for (const t of tasks) {
      if (t.deletedAt || !t.assigneeIds.includes(me)) continue;
      const startIso = t.startAt ?? t.dueAt;
      const endIso = t.dueAt ?? t.startAt;
      if (!startIso || !endIso) continue;
      const s = new Date(startIso).getTime();
      let e = new Date(endIso).getTime();
      if (t.allDay) e += DAY_MS;
      if (!(s < toMs && (e > fromMs || (e === s && s >= fromMs)))) continue;
      out.push({
        key: t.id,
        source: 'task',
        id: t.id,
        spaceId: t.spaceId,
        title: t.title,
        startMs: s,
        endMs: e,
        allDay: t.allDay,
        completed: !!t.completedAt,
        boardId: t.boardId,
      });
    }
  }
  // overlapping timed events of the person (not declined) are flagged
  const timed = out
    .filter((x) => x.source === 'event' && !x.allDay && x.rsvp !== 'declined')
    .sort((a, b) => a.startMs - b.startMs);
  for (let i = 0; i < timed.length; i++)
    for (let j = i + 1; j < timed.length && timed[j]!.startMs < timed[i]!.endMs; j++)
      timed[i]!.conflict = timed[j]!.conflict = true;
  return out.sort((a, b) => a.startMs - b.startMs || (a.key < b.key ? -1 : 1));
}

/** A column slot for entries that overlap in a day: `col` of `cols`. */
export interface Placed {
  entry: Entry;
  top: number;
  height: number;
  col: number;
  cols: number;
}

/** Lays the timed entries of one day over the grid (minutes from midnight of that day), side by side where they overlap. */
export function layoutDay(entries: readonly Entry[], day: number, tz: string): Placed[] {
  const dayStart = startOfDay(day, tz);
  const dayEnd = startOfDay(day + 1, tz);
  const items = entries
    .filter(
      (e) =>
        !e.allDay && e.startMs < dayEnd && Math.max(e.endMs, e.startMs + 15 * 60_000) > dayStart,
    )
    .map((e) => {
      const start = Math.max(e.startMs, dayStart);
      const end = Math.min(Math.max(e.endMs, e.startMs + 20 * 60_000), dayEnd);
      return {
        entry: e,
        top: (start - dayStart) / 60_000,
        height: Math.max(20, (end - start) / 60_000),
        col: 0,
        cols: 1,
      };
    })
    .sort((a, b) => a.top - b.top || b.height - a.height);
  // group into clusters of overlapping items, each cluster shares its column count
  let cluster: typeof items = [];
  let clusterEnd = -1;
  const flush = () => {
    const ends: number[] = [];
    for (const it of cluster) {
      let c = ends.findIndex((e) => e <= it.top);
      if (c < 0) c = ends.length;
      ends[c] = it.top + it.height;
      it.col = c;
    }
    for (const it of cluster) it.cols = ends.length;
    cluster = [];
  };
  for (const it of items) {
    if (cluster.length && it.top >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.top + it.height);
  }
  flush();
  return items;
}

/** Colours for spaces: a space keeps the same one (by its id) wherever it is shown. */
const PALETTE = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
  '#f97316',
];
export const spaceColor = (spaceId: string, personal = false): string => {
  if (personal) return '#64748b';
  let h = 0;
  for (let i = 0; i < spaceId.length; i++) h = (h * 31 + spaceId.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
};

/** Minutes between two instants rounded to the snap grid. */
export const snap = (minutes: number): number => Math.round(minutes / SNAP_MIN) * SNAP_MIN;

/** Short clock time of an instant in a zone, in the language of the app. */
export const clock = (ms: number, tz: string, lang: string): string =>
  new Intl.DateTimeFormat(lang === 'pt' ? 'pt-PT' : 'en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: tz,
  }).format(new Date(ms));

export const longDay = (
  day: number,
  lang: string,
  opts: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  },
): string =>
  new Intl.DateTimeFormat(lang === 'pt' ? 'pt-PT' : 'en-GB', { ...opts, timeZone: 'UTC' }).format(
    new Date(day * DAY_MS),
  );

export const weekdayName = (
  dow: number,
  lang: string,
  style: 'short' | 'narrow' | 'long' = 'short',
): string =>
  new Intl.DateTimeFormat(lang === 'pt' ? 'pt-PT' : 'en-GB', {
    weekday: style,
    timeZone: 'UTC',
  }).format(new Date((3 + dow) * DAY_MS)); // 1970-01-04 (day 3) was a Sunday
