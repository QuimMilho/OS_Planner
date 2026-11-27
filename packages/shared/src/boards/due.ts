import type { DueFilter, TaskDto } from '../dto/boards';

/**
 * Due dates. A timed task is an instant. An all-day task stores the calendar day as that day at 00:00 UTC and means "that day,
 * wherever you are", so the date part is read in UTC and compared with the viewer's own date.
 *
 * "Today" is the viewer's day: callers pass their offset from UTC in minutes (east positive, `-new Date().getTimezoneOffset()`).
 */
export type DueState = DueFilter;

type DueFields = Pick<TaskDto, 'dueAt' | 'allDay' | 'completedAt'>;

const DAY = 86_400_000;

/** The calendar date (`YYYY-MM-DD`) of an instant in a time zone given as an offset in minutes. */
export function dateInZone(instant: number | Date, offsetMinutes = 0): string {
  const ms = typeof instant === 'number' ? instant : instant.getTime();
  return new Date(ms + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** The calendar day an all-day value stands for. */
export const allDayDate = (iso: string): string => iso.slice(0, 10);

/**
 * Where a task stands against the clock: `overdue` (past and not done), `today`, `upcoming`, or `none` (no due date).
 * A finished task has no state worth showing: it counts as `none`.
 */
export function dueState(task: DueFields, now: Date | number, offsetMinutes = 0): DueState {
  if (!task.dueAt || task.completedAt) return 'none';
  const today = dateInZone(now, offsetMinutes);
  if (task.allDay) {
    const day = allDayDate(task.dueAt);
    return day < today ? 'overdue' : day === today ? 'today' : 'upcoming';
  }
  const due = Date.parse(task.dueAt);
  if (Number.isNaN(due)) return 'none';
  const nowMs = typeof now === 'number' ? now : now.getTime();
  if (due < nowMs) return 'overdue';
  return dateInZone(due, offsetMinutes) === today ? 'today' : 'upcoming';
}

/** The moment a due date counts as passed: the end of the day for an all-day task, the instant otherwise (UTC for all-day). */
export function dueInstant(task: Pick<TaskDto, 'dueAt' | 'allDay'>): number | null {
  if (!task.dueAt) return null;
  const t = Date.parse(task.dueAt);
  if (Number.isNaN(t)) return null;
  return task.allDay ? t + DAY : t;
}

/** Sorts by due date (soonest first, no date last), then by title, then by id: the order "My tasks" lists in. */
export function compareByDue(a: TaskDto, b: TaskDto): number {
  const x = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
  const y = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
  if (x !== y) return x < y ? -1 : 1;
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export const DUE_GROUP_ORDER: readonly DueState[] = ['overdue', 'today', 'upcoming', 'none'];

/** The tasks grouped for "My tasks", in `DUE_GROUP_ORDER`, each group sorted by due date. Empty groups are left out. */
export function groupByDue<T extends { task: TaskDto }>(items: readonly T[], now: Date | number, offsetMinutes = 0): { state: DueState; items: T[] }[] {
  const groups = new Map<DueState, T[]>(DUE_GROUP_ORDER.map((s) => [s, []]));
  for (const item of items) groups.get(dueState(item.task, now, offsetMinutes))!.push(item);
  return DUE_GROUP_ORDER.map((state) => ({ state, items: groups.get(state)!.sort((a, b) => compareByDue(a.task, b.task)) })).filter((g) => g.items.length);
}
