import type { ActivityKind, DueFilter, TaskDto, TaskPriority } from '@os-planner/shared';
import { dueState, textColorOn } from '@os-planner/shared/boards';
import { toProblem } from '../../core/auth-store';
import { BoardError } from '../../data/board-store';

/** The error codes that have a text of their own (everything else says "something went wrong"). */
export const BOARD_ERRORS = [
  'offline',
  'forbidden',
  'not_found',
  'read_only',
  'invalid',
  'wip_limit',
  'assignee_cannot_view',
  'quota_exceeded',
  'board_limit_reached',
  'column_limit_reached',
  'label_limit_reached',
  'move_to_required',
  'last_column',
  'unknown_label',
  'board_archived',
  'too_many_tasks',
  'too_many_subtasks',
  'too_many_attachments',
  'due_before_start',
  'subtask_of_subtask',
  'unsupported_media_type',
  'error',
] as const;

/** The translation key for an error code. */
export const errKey = (code: string): string => 'board.err.' + ((BOARD_ERRORS as readonly string[]).includes(code) ? code : 'error');

/** The translation key for whatever went wrong: a refusal made here, or the server's answer. */
export const failKey = (e: unknown): string => (e instanceof BoardError ? (e.code === 'wip_limit' ? 'board.wipFull' : errKey(e.code)) : errKey(toProblem(e).code));

export const PRIORITIES: readonly TaskPriority[] = ['none', 'low', 'medium', 'high', 'urgent'];

export const PRIORITY_ICON: Record<TaskPriority, string> = {
  none: 'remove',
  low: 'keyboard_arrow_down',
  medium: 'drag_handle',
  high: 'keyboard_arrow_up',
  urgent: 'priority_high',
};

/** The viewer's offset from UTC in minutes (east positive): what "today" is measured in. */
export const zoneOffset = (): number => -new Date().getTimezoneOffset();

/** Where a task stands against the clock now. */
export const dueOf = (task: TaskDto, now = Date.now()) => dueState(task, now, zoneOffset());

/** `YYYY-MM-DD` of an all-day value (its UTC date), or the local date of an instant. */
export function localDate(iso: string, allDay: boolean): string {
  if (allDay) return iso.slice(0, 10);
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The value of an `<input type="date">` or `<input type="datetime-local">` for a task's date. */
export function toInput(iso: string | null, allDay: boolean): string {
  if (!iso) return '';
  if (allDay) return iso.slice(0, 10);
  const d = new Date(iso);
  return `${localDate(iso, false)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The instant (or all-day marker) to send for what an input holds; null for an empty or unreadable one. */
export function fromInput(value: string, allDay: boolean): string | null {
  if (!value) return null;
  if (allDay) return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** How a date reads on a card: the day, and the time unless the task is all-day. */
export function formatDue(iso: string, allDay: boolean, locale: string): string {
  const d = new Date(iso);
  const tag = locale === 'pt' ? 'pt-PT' : 'en-GB';
  if (allDay) return new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeZone: 'UTC' }).format(d);
  return new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

/** Style for a label or column colour: the background, and a text colour that stays readable on it. */
export const chipStyle = (color: string | null | undefined): Record<string, string> =>
  color ? { background: color, color: textColorOn(color) } : {};

export const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('') || '?';

/** What the board's filter bar holds. */
export interface BoardFilter {
  text: string;
  /** `any`, `none` (nobody), or a person's id. */
  assignee: string;
  labelId: string;
  priority: TaskPriority | '';
  due: DueFilter | '';
  showDone: boolean;
}

export const NO_FILTER: BoardFilter = { text: '', assignee: 'any', labelId: '', priority: '', due: '', showDone: true };

export const isFiltering = (f: BoardFilter): boolean =>
  !!f.text || f.assignee !== 'any' || !!f.labelId || !!f.priority || !!f.due || !f.showDone;

export function matches(task: TaskDto, f: BoardFilter, now = Date.now()): boolean {
  if (!f.showDone && task.completedAt) return false;
  if (f.text && !task.title.toLowerCase().includes(f.text.trim().toLowerCase())) return false;
  if (f.assignee === 'none' && task.assigneeIds.length) return false;
  if (f.assignee !== 'any' && f.assignee !== 'none' && !task.assigneeIds.includes(f.assignee)) return false;
  if (f.labelId && !task.labelIds.includes(f.labelId)) return false;
  if (f.priority && task.priority !== f.priority) return false;
  if (f.due && dueOf(task, now) !== f.due) return false;
  return true;
}

/** `activity.<kind>` keys are listed here so the translation check can see them. */
export const ACTIVITY_KEYS: readonly ActivityKind[] = [
  'created',
  'renamed',
  'described',
  'moved',
  'completed',
  'reopened',
  'priority',
  'dates',
  'assigned',
  'unassigned',
  'labeled',
  'unlabeled',
  'checklist_added',
  'checklist_done',
  'checklist_removed',
  'subtask_added',
  'comment',
  'attachment_added',
  'attachment_removed',
  'deleted',
  'restored',
];

/** The text of a comment with the people it mentions shown by name: [{ text }, { mention: 'Ana' }, …]. */
export function commentParts(content: string, nameOf: (userId: string) => string): { text?: string; mention?: string }[] {
  const out: { text?: string; mention?: string }[] = [];
  const re = /<@user:([0-9a-fA-F-]{36})>/g;
  let last = 0;
  for (let m = re.exec(content); m; m = re.exec(content)) {
    if (m.index > last) out.push({ text: content.slice(last, m.index) });
    out.push({ mention: nameOf(m[1]!.toLowerCase()) || '?' });
    last = m.index + m[0].length;
  }
  if (last < content.length) out.push({ text: content.slice(last) });
  return out;
}
