import { z } from 'zod';
import { idSchema } from './common';
import {
  createCategorySchema,
  createNotebookSchema,
  createPageSchema,
  updateCategorySchema,
  updateNotebookSchema,
  updatePageSchema,
  type CategoryDto,
  type NotebookDto,
  type PageMetaDto,
} from './entities';
import {
  createBoardSchema,
  createColumnSchema,
  createLabelSchema,
  createTaskSchema,
  moveTaskSchema,
  updateBoardSchema,
  updateColumnSchema,
  updateLabelSchema,
  updateTaskSchema,
  type BoardDto,
  type ColumnDto,
  type LabelDto,
  type TaskDto,
} from './boards';
import {
  cancelEventSchema,
  createEventSchema,
  rsvpSchema,
  updateEventSchema,
  type EventDto,
} from './calendar';
import type { MergeEntity, RejectedField } from './merge';
import type { SharedNotebookDto } from './sharing';

/** Maximum operations accepted in one POST /sync/batch. */
export const SYNC_BATCH_MAX = 200;

const op = <T extends string>(type: T) => z.object({ opId: idSchema, type: z.literal(type) });

/**
 * What the device saw when it made a change (phase 15, see merge.ts): merge field -> the version it was based on, and `*` for the
 * entity as a whole. Without it the change is applied as before (the later request wins).
 */
export const mergeBaseSchema = z.record(z.string().min(1).max(40), z.number().int().min(0)).refine((b) => Object.keys(b).length <= 24, 'too many fields');
const withBase = { base: mergeBaseSchema.optional() };

/**
 * One entry of the client's offline outbox. Every operation is idempotent, so the client can
 * resend a whole batch after a dropped connection without creating duplicates.
 * Page *content* is not here: it is a co-edited document (/api/collab); a text kept on a device goes up with the snapshots' "replace".
 */
export const syncOpSchema = z.discriminatedUnion('type', [
  op('notebook.create').extend(createNotebookSchema.shape),
  op('notebook.update').extend({ id: idSchema }).extend(withBase).extend(updateNotebookSchema.shape),
  op('notebook.delete').extend({ id: idSchema }).extend(withBase),
  op('notebook.restore').extend({ id: idSchema }),

  op('category.create').extend(createCategorySchema.shape),
  op('category.update').extend({ id: idSchema }).extend(withBase).extend(updateCategorySchema.shape),
  op('category.delete').extend({ id: idSchema }).extend(withBase),
  op('category.restore').extend({ id: idSchema }),

  op('page.create').extend(createPageSchema.shape),
  op('page.update').extend({ id: idSchema }).extend(withBase).extend(updatePageSchema.shape),
  op('page.delete').extend({ id: idSchema }).extend(withBase),
  op('page.restore').extend({ id: idSchema }),

  // Boards and tasks (phase 12). What a person can do offline: work on tasks. Boards, columns and labels are managed online.
  op('task.create').extend({ boardId: idSchema }).extend(createTaskSchema.shape),
  op('task.update').extend({ id: idSchema }).extend(withBase).extend(updateTaskSchema.shape),
  op('task.move').extend({ id: idSchema }).extend(withBase).extend(moveTaskSchema.shape),
  op('task.delete').extend({ id: idSchema }).extend(withBase),
  op('task.restore').extend({ id: idSchema }),

  // Events (phase 13). What a person can do offline: make, change, cancel and answer. People on an event, reminders and the
  // `following` scope are online-only.
  op('event.create').extend(createEventSchema.shape),
  op('event.update').extend({ id: idSchema }).extend(withBase).extend(updateEventSchema.shape),
  op('event.cancel').extend({ id: idSchema }).extend(withBase).extend(cancelEventSchema.shape),
  op('event.rsvp').extend({ id: idSchema }).extend(rsvpSchema.shape),
]);
export type SyncOp = z.infer<typeof syncOpSchema>;
export type SyncOpType = SyncOp['type'];

export const syncBatchSchema = z.object({
  ops: z.array(z.unknown()).min(1).max(SYNC_BATCH_MAX),
});
export type SyncBatchInput = z.infer<typeof syncBatchSchema>;

/**
 * Why an operation was not applied.
 *  - not_found:      the target does not exist, was purged, or the person may not see it; the client should drop the op and pull
 *  - forbidden:      the person may see it but is not allowed to do this
 *  - parent_deleted: the parent notebook/category is in the trash
 *  - invalid:        the payload is structurally valid but not allowed (cycle, too deep, ...)
 *  - id_taken:       a create used an id that belongs to someone else
 *  - quota_exceeded: the change would store more than the storage limit allows; keep it and retry once space is freed
 *  - wip_limit:      the column the task was moved to is full; the move is dropped and the task shows where it really is
 *  - conflict:       every field of the change was changed online meanwhile; the online values stay (see `rejected`)
 *  - target_deleted: the entity was deleted (or is gone) online; it stays deleted
 *  - deleted_but_changed: a delete of something that changed online after the device saw it; it stays
 */
export type SyncErrorCode = 'conflict' | 'target_deleted' | 'deleted_but_changed' | 'not_found' | 'forbidden' | 'parent_deleted' | 'invalid' | 'id_taken' | 'quota_exceeded' | 'wip_limit' | 'internal';

/** The entity as it is online after the op was dealt with (so the device can show it, and refresh what it holds). */
export interface SyncEntityDto {
  kind: MergeEntity;
  row: NotebookDto | CategoryDto | PageMetaDto | TaskDto | EventDto;
}

export type SyncOpResult =
  | {
      opId: string;
      ok: true;
      /** `merged`: some fields were applied and the ones in `rejected` were not. */
      status?: 'applied' | 'merged';
      rejected?: Record<string, RejectedField>;
      /** The merge fields that were written. */
      applied?: string[];
      entity?: SyncEntityDto;
    }
  | {
      opId: string;
      ok: false;
      status?: 'rejected';
      error: SyncErrorCode;
      message?: string;
      rejected?: Record<string, RejectedField>;
      entity?: SyncEntityDto;
    };

export interface SyncBatchResponse {
  results: SyncOpResult[];
}

/** A space id, or `shared:<notebookId>` for a notebook shared with the person. */
const cursorKeySchema = z.string().regex(/^(shared:)?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);

/** `cursors` arrives as JSON in the query string: { "<spaceId>": <seq>, ... }. */
const cursorsSchema = z
  .string()
  .max(20_000)
  .transform((raw, ctx) => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'cursors must be JSON' });
      return z.NEVER;
    }
  })
  .pipe(z.record(cursorKeySchema, z.number().int().min(0)));

export const syncChangesQuerySchema = z.object({
  /** One cursor per space the client holds (0 for a space it has never synced). Notebooks shared with the person always answer. */
  cursors: cursorsSchema,
});
export type SyncChangesQuery = z.infer<typeof syncChangesQuerySchema>;

/** What changed in one space after the cursor the client sent for it. */
export interface SpaceChangesDto {
  /** Pass this for the space next time. Everything up to and including it has been delivered. */
  cursor: number;
  /** True when more changes remain: call again immediately with the new cursor. */
  hasMore: boolean;
  notebooks: NotebookDto[];
  categories: CategoryDto[];
  /** Page metadata only; content is fetched per page. Tombstones have a non-null deletedAt. */
  pages: PageMetaDto[];
  /** Notebooks of this space the person may not see (a notebook overwrite denies them): drop what is held locally. */
  hiddenNotebooks?: string[];
  /** Notebooks that moved to another space after the cursor: drop them from this one (unless already held under the new space). */
  movedOut?: string[];
  /** Boards, columns, tasks and labels of the space (the person may see boards there); tombstones included. */
  boards?: BoardDto[];
  columns?: ColumnDto[];
  tasks?: TaskDto[];
  labels?: LabelDto[];
  /** Boards of this space the person may not see (a board overwrite denies VIEW_BOARDS): drop what is held locally. */
  hiddenBoards?: string[];
  /** Tasks that moved to a board of another space after the cursor: drop them from this one (unless already held under the new space). */
  movedOutTasks?: string[];
  /** Events of the space the person can see, as they see them (their own place on each); tombstones included. */
  events?: EventDto[];
  /** Events that changed after the cursor and that the person may not see (any more): drop them. */
  hiddenEvents?: string[];
}

export interface SyncChangesDto extends SpaceChangesDto {
  /** With `cursors`: the changes of each requested space the person may see. */
  spaces: Record<string, SpaceChangesDto>;
  /** Requested spaces the person can no longer see (left or removed from a team, deleted team or project): purge them locally. */
  revokedSpaces: string[];
  /** Every notebook currently shared with the person; each has its own cursor key (see sharedCursorKey) in `spaces`. */
  sharedNotebooks?: SharedNotebookDto[];
}
