import { z } from 'zod';
import type { MentionsDto } from '../chat/mentions';
import { colorSchema, iconSchema, idSchema, positionSchema } from './common';

// Boards and tasks (phase 12). The runtime part (schemas, limits) is the separate entry `@os-planner/shared/boards`; the main
// entry only exports the types, so the website's first load does not carry them.

// ---------------------------------------------------------------- limits and enums

export const BOARD_LIMITS = {
  nameMax: 80,
  descriptionMax: 2000,
  titleMax: 200,
  /** Boards (archived ones included, trashed ones not) per space. */
  boardsPerSpace: 100,
  columnsPerBoard: 30,
  /** Tasks and subtasks per board that are not in the trash. */
  tasksPerBoard: 5000,
  subtasksPerTask: 50,
  checklistItems: 100,
  checklistTextMax: 300,
  assigneesPerTask: 20,
  labelsPerTask: 20,
  labelsPerSpace: 200,
  labelNameMax: 40,
  /** UTF-8 size of a task description (JSON). */
  descriptionBytes: 20_000,
  commentMax: 4000,
  attachmentsPerTask: 20,
  wipMax: 999,
  /** Rows one list request returns. */
  listMax: 500,
  activityPage: 100,
} as const;

export const TASK_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export const taskPrioritySchema = z.enum(TASK_PRIORITIES);

/** `done` columns mark the tasks in them as complete. */
export const COLUMN_KINDS = ['todo', 'doing', 'done', 'custom'] as const;
export type ColumnKind = (typeof COLUMN_KINDS)[number];
export const columnKindSchema = z.enum(COLUMN_KINDS);

/** One `TaskActivity.kind` per thing that can happen to a task (the i18n keys are `activity.<kind>`). */
export const ACTIVITY_KINDS = [
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
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

// ---------------------------------------------------------------- responses

export interface BoardDto {
  id: string;
  spaceId: string;
  name: string;
  description: string;
  icon: string | null;
  color: string | null;
  position: string;
  /** Set while the board is archived (hidden from the list, still readable). */
  archivedAt: string | null;
  seq: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ColumnDto {
  id: string;
  boardId: string;
  spaceId: string;
  name: string;
  position: string;
  /** At most this many tasks (subtasks do not count); null = no limit. */
  wipLimit: number | null;
  kind: ColumnKind;
  color: string | null;
  seq: number;
  deletedAt: string | null;
}

export interface ChecklistItemDto {
  id: string;
  text: string;
  done: boolean;
  position: string;
}

/** A task description: the reduced document of `validateTaskDescription`. */
export interface TaskDocDto {
  type: 'doc';
  content?: unknown[];
}

export interface TaskDto {
  id: string;
  boardId: string;
  columnId: string;
  spaceId: string;
  parentTaskId: string | null;
  title: string;
  description: TaskDocDto | null;
  position: string;
  priority: TaskPriority;
  /** An instant (ISO). For an all-day task the date part is the calendar day and the time is 00:00 UTC. */
  startAt: string | null;
  dueAt: string | null;
  allDay: boolean;
  completedAt: string | null;
  assigneeIds: string[];
  labelIds: string[];
  checklist: ChecklistItemDto[];
  commentCount: number;
  attachmentCount: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  seq: number;
  /** Merge field → seq at which it last changed (phase 15); absent for an entity nobody changed since it was made. */
  fieldSeq?: Record<string, number>;
  deletedAt: string | null;
}

export interface LabelDto {
  id: string;
  spaceId: string;
  name: string;
  color: string;
  description: string;
  /** A team's label is also seen by its projects (and their sub-projects). */
  inheritable: boolean;
  seq: number;
  deletedAt: string | null;
}

export interface TaskCommentDto {
  id: string;
  taskId: string;
  authorId: string | null;
  authorName: string | null;
  content: string;
  mentions: MentionsDto;
  editedAt: string | null;
  createdAt: string;
}

export interface TaskAttachmentDto {
  id: string;
  taskId: string;
  mediaId: string;
  name: string;
  size: number;
  mime: string;
  kind: 'image' | 'video';
  width: number | null;
  height: number | null;
  createdAt: string;
}

export interface TaskActivityDto {
  id: string;
  taskId: string;
  actorId: string | null;
  actorName: string | null;
  kind: ActivityKind;
  /** What the entry needs to be shown: names, from/to values. */
  data: Record<string, unknown>;
  createdAt: string;
}

/** A person who can see a board, so may be assigned to its tasks. */
export interface BoardMemberDto {
  userId: string;
  displayName: string;
}

/** `GET /api/boards/:id`: the board and everything on it. */
export interface BoardDetailDto {
  board: BoardDto;
  columns: ColumnDto[];
  tasks: TaskDto[];
  /** The labels usable on this board: the space's own and the inheritable ones above it. */
  labels: LabelDto[];
  members: BoardMemberDto[];
  /** What the person may do on the board (decimal string of the permission bit field). */
  permissions: string;
}

/** `GET /api/tasks/:id`: what the drawer shows besides the task itself (not synced: fetched on open). */
export interface TaskDetailDto {
  task: TaskDto;
  subtasks: TaskDto[];
  comments: TaskCommentDto[];
  attachments: TaskAttachmentDto[];
  activity: TaskActivityDto[];
  boardName: string;
}

/** A task as `GET /api/me/tasks` lists it. */
export interface MyTaskDto {
  task: TaskDto;
  boardName: string;
}

/** `GET /api/board-permissions`: what the person may do on each board and in each space (for the boards they can see). */
export interface BoardPermissionsDto {
  boards: Record<string, string>;
  spaces: Record<string, string>;
}

// ---------------------------------------------------------------- bodies

const boardName = z.string().trim().min(1).max(BOARD_LIMITS.nameMax);
const taskTitle = z.string().trim().min(1).max(BOARD_LIMITS.titleMax);
const isoSchema = z.iso.datetime({ offset: true });

export const createColumnSchema = z.object({
  id: idSchema,
  name: boardName,
  position: positionSchema,
  kind: columnKindSchema.optional(),
  wipLimit: z.number().int().min(1).max(BOARD_LIMITS.wipMax).nullable().optional(),
  color: colorSchema.optional(),
});
export type CreateColumnInput = z.infer<typeof createColumnSchema>;

export const updateColumnSchema = z
  .object({
    name: boardName,
    position: positionSchema,
    kind: columnKindSchema,
    wipLimit: z.number().int().min(1).max(BOARD_LIMITS.wipMax).nullable(),
    color: colorSchema,
  })
  .partial();
export type UpdateColumnInput = z.infer<typeof updateColumnSchema>;

/** Deleting a column moves its tasks to another one of the board (required when it has tasks). */
export const deleteColumnSchema = z.object({ moveTo: idSchema.optional() });
export type DeleteColumnInput = z.infer<typeof deleteColumnSchema>;

export const createBoardSchema = z.object({
  id: idSchema,
  name: boardName,
  description: z.string().max(BOARD_LIMITS.descriptionMax).optional(),
  icon: iconSchema.optional(),
  color: colorSchema.optional(),
  position: positionSchema,
  /** The columns to start with; when left out the server makes To do, Doing and Done. */
  columns: z.array(createColumnSchema).min(1).max(BOARD_LIMITS.columnsPerBoard).optional(),
});
export type CreateBoardInput = z.infer<typeof createBoardSchema>;

export const updateBoardSchema = z
  .object({
    name: boardName,
    description: z.string().max(BOARD_LIMITS.descriptionMax),
    icon: iconSchema,
    color: colorSchema,
    position: positionSchema,
    archived: z.boolean(),
  })
  .partial();
export type UpdateBoardInput = z.infer<typeof updateBoardSchema>;

export const duplicateBoardSchema = z.object({
  id: idSchema,
  name: boardName.optional(),
  /** Copy the tasks too (and not only the columns). */
  withTasks: z.boolean().default(false),
});
export type DuplicateBoardInput = z.infer<typeof duplicateBoardSchema>;

export const checklistItemSchema = z.object({
  id: idSchema,
  text: z.string().trim().min(1).max(BOARD_LIMITS.checklistTextMax),
  done: z.boolean(),
  position: positionSchema,
});

export const addChecklistItemSchema = checklistItemSchema.omit({ done: true }).extend({ done: z.boolean().optional() });
export type AddChecklistItemInput = z.infer<typeof addChecklistItemSchema>;
export const editChecklistItemSchema = z.object({ text: checklistItemSchema.shape.text, done: z.boolean(), position: positionSchema }).partial();
export type EditChecklistItemInput = z.infer<typeof editChecklistItemSchema>;

/** The fields a task can be created with and changed by; an update sends only what changed. */
const taskFields = {
  title: taskTitle,
  description: z.unknown().nullable(),
  priority: taskPrioritySchema,
  startAt: isoSchema.nullable(),
  dueAt: isoSchema.nullable(),
  allDay: z.boolean(),
  /** Mark done or open again, apart from the column (a subtask has no column of its own to be done in). */
  completed: z.boolean(),
  assigneeIds: z.array(idSchema).max(BOARD_LIMITS.assigneesPerTask),
  labelIds: z.array(idSchema).max(BOARD_LIMITS.labelsPerTask),
  /** The whole checklist: items missing from it are removed, new ids are added. */
  checklist: z.array(checklistItemSchema).max(BOARD_LIMITS.checklistItems),
};

export const createTaskSchema = z.object({
  id: idSchema,
  columnId: idSchema,
  parentTaskId: idSchema.nullable().optional(),
  position: positionSchema,
  ...z.object(taskFields).partial().required({ title: true }).shape,
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z.object(taskFields).partial();
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const moveTaskSchema = z.object({
  columnId: idSchema,
  position: positionSchema,
  /** Another board (the person must be allowed to create tasks there). */
  boardId: idSchema.optional(),
});
export type MoveTaskInput = z.infer<typeof moveTaskSchema>;

export const createLabelSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(BOARD_LIMITS.labelNameMax),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  description: z.string().max(200).optional(),
  inheritable: z.boolean().optional(),
});
export type CreateLabelInput = z.infer<typeof createLabelSchema>;

export const updateLabelSchema = createLabelSchema.omit({ id: true }).partial();
export type UpdateLabelInput = z.infer<typeof updateLabelSchema>;

export const commentContentSchema = z.string().trim().min(1).max(BOARD_LIMITS.commentMax);
export const createCommentSchema = z.object({ id: idSchema, content: commentContentSchema });
export type CreateCommentInput = z.infer<typeof createCommentSchema>;
export const updateCommentSchema = z.object({ content: commentContentSchema });
export type UpdateCommentInput = z.infer<typeof updateCommentSchema>;

/** Multipart fields of a task attachment upload (the file is the `file` part). */
export const taskAttachmentFieldsSchema = z.object({
  id: idSchema,
  name: z.string().max(200).optional(),
  width: z.coerce.number().int().positive().max(100_000).optional(),
  height: z.coerce.number().int().positive().max(100_000).optional(),
  durationSec: z.coerce.number().positive().max(86_400).optional(),
});
export type TaskAttachmentFields = z.infer<typeof taskAttachmentFieldsSchema>;

// ---------------------------------------------------------------- views

export const DUE_FILTERS = ['overdue', 'today', 'upcoming', 'none'] as const;
export type DueFilter = (typeof DUE_FILTERS)[number];

export const taskQuerySchema = z.object({
  /** `me`: only the caller's tasks (the default of /api/me/tasks). */
  assigned: z.enum(['me', 'any']).optional(),
  status: z.enum(['open', 'done', 'all']).default('open'),
  due: z.enum(DUE_FILTERS).optional(),
  spaceId: idSchema.optional(),
  boardId: idSchema.optional(),
  labelId: idSchema.optional(),
  priority: taskPrioritySchema.optional(),
  q: z.string().trim().max(100).optional(),
  /** The caller's offset from UTC in minutes (east positive), so "today" means their day. */
  tz: z.coerce.number().int().min(-840).max(840).default(0),
  limit: z.coerce.number().int().min(1).max(BOARD_LIMITS.listMax).default(200),
});
export type TaskQuery = z.infer<typeof taskQuerySchema>;

export const activityQuerySchema = z.object({
  before: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(BOARD_LIMITS.activityPage).default(50),
});
