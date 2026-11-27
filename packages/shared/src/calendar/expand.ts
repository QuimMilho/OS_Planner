import type { EventExceptionDto, EventOverrideDto } from '../dto/calendar';
import { CALENDAR_LIMITS } from '../dto/calendar';
import { expandRule, parseRRule, type RRule } from './rrule';

const DAY = 86_400_000;

/** What expansion needs of an event. Both the server's rows and the web's local copies fit. */
export interface Expandable {
  startAt: string;
  endAt: string;
  allDay: boolean;
  timezone: string;
  rrule: string | null;
  exceptions?: readonly EventExceptionDto[];
}

/** One occurrence of an event, with its exception (if any) applied. */
export interface Occurrence {
  /** The instant the series would have started it at: the key of its exception. */
  originalStart: string;
  start: string;
  end: string;
  /** The fields the occurrence changes (title, place, ...); null when it is as the series says. */
  override: EventOverrideDto | null;
}

const iso = (ms: number) => new Date(ms).toISOString();
/** The canonical text of an instant (`2026-03-30T08:00:00.000Z`), so keys written by different clients compare equal. */
export const instantKey = (value: string): string => iso(new Date(value).getTime());

/** The rule of an event, or null when it does not repeat (or its text is not a rule: such an event is shown once). */
export function ruleOf(event: Pick<Expandable, 'rrule'>): RRule | null {
  if (!event.rrule) return null;
  const parsed = parseRRule(event.rrule);
  return parsed.ok ? parsed.rule : null;
}

/**
 * The occurrences of an event that overlap [fromMs, toMs): a repeating one is expanded in its own zone, cancelled ones are left out and
 * changed ones are moved (a changed occurrence that now falls in the window is found even when its original time does not).
 * `max` bounds the work for one event.
 */
export function expandEvent(
  event: Expandable,
  fromMs: number,
  toMs: number,
  max: number = CALENDAR_LIMITS.itemsPerRequest,
): Occurrence[] {
  const startMs = new Date(event.startAt).getTime();
  const duration = Math.max(0, new Date(event.endAt).getTime() - startMs);
  const rule = ruleOf(event);
  const overlaps = (s: number, e: number) => s < toMs && (e > fromMs || (e === s && s >= fromMs));

  if (!rule)
    return overlaps(startMs, startMs + duration)
      ? [
          {
            originalStart: iso(startMs),
            start: iso(startMs),
            end: iso(startMs + duration),
            override: null,
          },
        ]
      : [];

  const tz = event.allDay ? 'UTC' : event.timezone;
  const byKey = new Map<string, EventExceptionDto>();
  for (const x of event.exceptions ?? []) byKey.set(instantKey(x.originalStart), x);

  const out = new Map<string, Occurrence>();
  const place = (originalMs: number): void => {
    const key = iso(originalMs);
    const x = byKey.get(key);
    if (x?.kind === 'cancelled') return;
    let s = originalMs;
    let e = originalMs + duration;
    if (x?.override?.startAt) {
      s = new Date(x.override.startAt).getTime();
      e = x.override.endAt ? new Date(x.override.endAt).getTime() : s + duration;
    } else if (x?.override?.endAt) e = new Date(x.override.endAt).getTime();
    if (!overlaps(s, e)) return;
    out.set(key, { originalStart: key, start: iso(s), end: iso(e), override: x?.override ?? null });
  };

  // Originals that start before the window can still reach into it.
  for (const at of expandRule({ startMs, tz, rule, fromMs: fromMs - duration - DAY, toMs, max }))
    place(at);
  // A changed occurrence whose original time is outside the window may have been moved into it.
  for (const x of byKey.values()) {
    if (x.kind !== 'override' || !x.override?.startAt) continue;
    if (!out.has(instantKey(x.originalStart))) place(new Date(x.originalStart).getTime());
  }
  return [...out.values()].sort((a, b) =>
    a.start < b.start ? -1 : a.start > b.start ? 1 : a.originalStart < b.originalStart ? -1 : 1,
  );
}

/** The instant `n` days after an instant, on the same wall clock of a zone (used to move an occurrence by whole days). */
export const addDaysMs = (ms: number, days: number): number => ms + days * DAY;
