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

/** Maximum operations accepted in one POST /sync/batch. */
export const SYNC_BATCH_MAX = 200;

const op = <T extends string>(type: T) => z.object({ opId: idSchema, type: z.literal(type) });

/**
 * One entry of the client's offline outbox. Every operation is idempotent, so the client can
 * resend a whole batch after a dropped connection without creating duplicates.
 * Page *content* is not here: it goes through PUT /pages/:id/content, which carries a version check.
 */
export const syncOpSchema = z.discriminatedUnion('type', [
  op('notebook.create').extend(createNotebookSchema.shape),
  op('notebook.update').extend({ id: idSchema }).extend(updateNotebookSchema.shape),
  op('notebook.delete').extend({ id: idSchema }),
  op('notebook.restore').extend({ id: idSchema }),

  op('category.create').extend(createCategorySchema.shape),
  op('category.update').extend({ id: idSchema }).extend(updateCategorySchema.shape),
  op('category.delete').extend({ id: idSchema }),
  op('category.restore').extend({ id: idSchema }),

  op('page.create').extend(createPageSchema.shape),
  op('page.update').extend({ id: idSchema }).extend(updatePageSchema.shape),
  op('page.delete').extend({ id: idSchema }),
  op('page.restore').extend({ id: idSchema }),
]);
export type SyncOp = z.infer<typeof syncOpSchema>;
export type SyncOpType = SyncOp['type'];

export const syncBatchSchema = z.object({
  ops: z.array(z.unknown()).min(1).max(SYNC_BATCH_MAX),
});
export type SyncBatchInput = z.infer<typeof syncBatchSchema>;

/**
 * Why an operation was not applied.
 *  - not_found:      the target does not exist (or was purged); the client should drop the op and pull
 *  - parent_deleted: the parent notebook/category is in the trash
 *  - invalid:        the payload is structurally valid but not allowed (cycle, too deep, ...)
 *  - id_taken:       a create used an id that belongs to someone else
 */
export type SyncErrorCode = 'not_found' | 'parent_deleted' | 'invalid' | 'id_taken' | 'internal';

export type SyncOpResult =
  | { opId: string; ok: true }
  | { opId: string; ok: false; error: SyncErrorCode; message?: string };

export interface SyncBatchResponse {
  results: SyncOpResult[];
}

export const syncChangesQuerySchema = z.object({
  since: z.coerce.number().int().min(0).default(0),
});

export interface SyncChangesDto {
  /** Pass this as `since` next time. Everything up to and including it has been delivered. */
  cursor: number;
  /** True when more changes remain: call again immediately with the new cursor. */
  hasMore: boolean;
  notebooks: NotebookDto[];
  categories: CategoryDto[];
  /** Page metadata only; content is fetched per page. Tombstones have a non-null deletedAt. */
  pages: PageMetaDto[];
}
