import { comparePositions, type BoardDto, type ColumnDto, type ColumnKind, type LabelDto, type TaskDocDto, type TaskDto, type TaskPriority } from '@os-planner/shared';
import { fieldSeqDto } from '../common/merge-scope.js';
import type { Board, BoardColumn, ChecklistItem, Label, Task } from '../generated/prisma/client.js';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export const toBoardDto = (b: Board): BoardDto => ({
  id: b.id,
  spaceId: b.spaceId,
  name: b.name,
  description: b.description,
  icon: b.icon,
  color: b.color,
  position: b.position,
  archivedAt: iso(b.archivedAt),
  seq: Number(b.seq),
  createdBy: b.createdBy,
  createdAt: b.createdAt.toISOString(),
  updatedAt: b.updatedAt.toISOString(),
  deletedAt: iso(b.deletedAt),
});

export const toColumnDto = (c: BoardColumn): ColumnDto => ({
  id: c.id,
  boardId: c.boardId,
  spaceId: c.spaceId,
  name: c.name,
  position: c.position,
  wipLimit: c.wipLimit,
  kind: c.kind as ColumnKind,
  color: c.color,
  seq: Number(c.seq),
  deletedAt: iso(c.deletedAt),
});

export const toLabelDto = (l: Label): LabelDto => ({
  id: l.id,
  spaceId: l.spaceId,
  name: l.name,
  color: l.color,
  description: l.description,
  inheritable: l.inheritable,
  seq: Number(l.seq),
  deletedAt: iso(l.deletedAt),
});

/** What a task is loaded with: the people, labels and checklist that travel inside it. */
export const TASK_INCLUDE = {
  assignees: { select: { userId: true } },
  labels: { select: { labelId: true } },
  checklist: true,
} as const;

export type TaskRow = Task & {
  assignees: { userId: string }[];
  labels: { labelId: string }[];
  checklist: ChecklistItem[];
};

export const toTaskDto = (t: TaskRow): TaskDto => ({
  id: t.id,
  boardId: t.boardId,
  columnId: t.columnId,
  spaceId: t.spaceId,
  parentTaskId: t.parentTaskId,
  title: t.title,
  description: (t.description as TaskDocDto | null) ?? null,
  position: t.position,
  priority: t.priority as TaskPriority,
  startAt: iso(t.startAt),
  dueAt: iso(t.dueAt),
  allDay: t.allDay,
  completedAt: iso(t.completedAt),
  assigneeIds: t.assignees.map((a) => a.userId).sort(),
  labelIds: t.labels.map((l) => l.labelId).sort(),
  checklist: t.checklist
    .map((c) => ({ id: c.id, text: c.text, done: c.done, position: c.position }))
    .sort((a, b) => comparePositions(a, b)),
  commentCount: t.commentCount,
  attachmentCount: t.attachmentCount,
  createdBy: t.createdBy,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
  seq: Number(t.seq),
  ...fieldSeqDto(t.fieldSeq),
  deletedAt: iso(t.deletedAt),
});

/** Size a task counts for in the space storage: its title and its description document. */
export const taskBytes = (title: string, description: unknown): number =>
  Buffer.byteLength(title, 'utf8') + (description ? Buffer.byteLength(JSON.stringify(description), 'utf8') : 0);

/** The calendar day of an all-day value at 00:00 UTC: whatever instant arrives, its UTC date part is the day. */
export function normalizeAllDay(iso: string): Date {
  const d = new Date(iso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
