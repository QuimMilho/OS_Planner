import { Injectable, Logger } from '@nestjs/common';
import {
  syncOpSchema,
  type SpaceChangesDto,
  type SyncBatchResponse,
  type SyncChangesDto,
  type SyncChangesQuery,
  type SyncOp,
  type SyncOpResult,
} from '@os-planner/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { QuotaExceeded } from '../quota/quota.errors.js';
import { PermissionService } from '../spaces/permission.service.js';
import { SpacesService } from '../spaces/spaces.service.js';
import { CategoriesService } from './categories.service.js';
import { PAGE_META_SELECT, toCategoryDto, toNotebookDto, toPageMetaDto } from './mappers.js';
import { NotebooksService } from './notebooks.service.js';
import { PagesService } from './pages.service.js';
import { TreeError } from './tree.error.js';

/**
 * Rows per table per pull. Small enough to keep responses light, large enough that most users
 * need one call. Mutable only so tests can exercise pagination without thousands of rows.
 */
export const SYNC_PAGE = { limit: 1000 };

const NOTHING: SpaceChangesDto = { cursor: 0, hasMore: false, notebooks: [], categories: [], pages: [] };

@Injectable()
export class SyncService {
  private readonly log = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notebooks: NotebooksService,
    private readonly categories: CategoriesService,
    private readonly pages: PagesService,
    private readonly perms: PermissionService,
    private readonly spaces: SpacesService,
  ) {}

  /**
   * What changed since the client's cursors.
   *
   *  - `cursors` (one per space the client holds): every space the person may still see answers
   *    under `spaces`; the ones they may not (left or removed from a team, deleted team or
   *    project, no such space) are listed in `revokedSpaces` so the client can purge them.
   *  - `since` (older clients): one cursor for the personal space, answered at the top level.
   */
  async changes(userId: string, query: SyncChangesQuery): Promise<SyncChangesDto> {
    if (query.cursors) {
      const visible = await this.perms.notebookSpaces(userId);
      const spaces: Record<string, SpaceChangesDto> = {};
      const revokedSpaces: string[] = [];
      for (const [spaceId, since] of Object.entries(query.cursors)) {
        if (!visible.has(spaceId)) revokedSpaces.push(spaceId);
        else spaces[spaceId] = await this.spaceChanges(spaceId, since);
      }
      return { ...NOTHING, spaces, revokedSpaces };
    }
    const personal = await this.spaces.personalSpaceId(userId);
    return { ...(await this.spaceChanges(personal, query.since ?? 0)), spaces: {}, revokedSpaces: [] };
  }

  /**
   * Everything in one space that changed after `since`, tombstones included.
   *
   * Consistency: the space's `changeSeq` counter is read first as the ceiling, inside one
   * snapshot. Writers bump it under a row lock, so nothing at or below the ceiling can still
   * be uncommitted, and nothing above it is returned. The cursor handed back is therefore safe.
   *
   * Pagination: rows are cut at a seq boundary. Rows written by one transaction share a seq (a
   * notebook delete touches every page in it), so a boundary may never split a seq group; if a
   * single group is larger than the limit it is returned whole.
   */
  private spaceChanges(spaceId: string, since: number): Promise<SpaceChangesDto> {
    return this.prisma.$transaction(async (tx) => {
      const { changeSeq: head } = await tx.space.findUniqueOrThrow({ where: { id: spaceId }, select: { changeSeq: true } });
      const after = BigInt(since);
      if (after >= head) {
        return { cursor: Number(head), hasMore: false, notebooks: [], categories: [], pages: [] };
      }

      const fetch = (upTo: bigint, take?: number) => {
        const where = { spaceId, seq: { gt: after, lte: upTo } };
        const orderBy = { seq: 'asc' } as const;
        return Promise.all([
          tx.notebook.findMany({ where, orderBy, take }),
          tx.category.findMany({ where, orderBy, take }),
          tx.page.findMany({ where, orderBy, take, select: PAGE_META_SELECT }),
        ] as const);
      };

      const limit = SYNC_PAGE.limit;
      let upTo = head;
      let [nb, cat, pg] = await fetch(upTo, limit + 1);
      const overflow = [nb, cat, pg].filter((rows) => rows.length > limit).map((rows) => rows[limit]!.seq);

      if (overflow.length) {
        const firstOverflow = overflow.reduce((a, b) => (a < b ? a : b));
        // Stop just before the first seq that no longer fits entirely...
        upTo = firstOverflow - 1n;
        // ...unless that leaves nothing, i.e. one seq group alone exceeds the limit: take it whole.
        if (upTo <= after) upTo = firstOverflow;
        [nb, cat, pg] = await fetch(upTo);
      }

      return {
        cursor: Number(upTo),
        hasMore: upTo < head,
        notebooks: nb.map(toNotebookDto),
        categories: cat.map(toCategoryDto),
        pages: pg.map(toPageMetaDto),
      };
    });
  }

  /**
   * Applies queued offline operations in order. Each one stands alone: a failure is reported in
   * its result and the rest still run (a dependent op will then fail with not_found itself).
   */
  async batch(userId: string, rawOps: unknown[]): Promise<SyncBatchResponse> {
    const results: SyncOpResult[] = [];
    for (const raw of rawOps) {
      const parsed = syncOpSchema.safeParse(raw);
      if (!parsed.success) {
        const opId = typeof (raw as { opId?: unknown })?.opId === 'string' ? (raw as { opId: string }).opId : '';
        const issue = parsed.error.issues[0];
        results.push({ opId, ok: false, error: 'invalid', message: `${issue?.path.join('.') || 'op'}: ${issue?.message}` });
        continue;
      }
      const op = parsed.data;
      try {
        await this.apply(userId, op);
        results.push({ opId: op.opId, ok: true });
      } catch (e) {
        if (e instanceof TreeError) {
          results.push({ opId: op.opId, ok: false, error: e.code, message: e.message });
        } else if (e instanceof QuotaExceeded) {
          results.push({ opId: op.opId, ok: false, error: 'quota_exceeded', message: 'quota_exceeded' });
        } else {
          this.log.error(`sync op ${op.type} failed: ${e instanceof Error ? e.stack : e}`);
          results.push({ opId: op.opId, ok: false, error: 'internal' });
        }
      }
    }
    return { results };
  }

  private async apply(userId: string, op: SyncOp): Promise<void> {
    switch (op.type) {
      case 'notebook.create': {
        const { opId: _o, type: _t, ...input } = op;
        await this.notebooks.create(userId, input);
        return;
      }
      case 'notebook.update': {
        const { opId: _o, type: _t, id, ...patch } = op;
        await this.notebooks.update(userId, id, patch);
        return;
      }
      case 'notebook.delete':
        return this.notebooks.remove(userId, op.id);
      case 'notebook.restore':
        await this.notebooks.restore(userId, op.id);
        return;

      case 'category.create': {
        const { opId: _o, type: _t, ...input } = op;
        await this.categories.create(userId, input);
        return;
      }
      case 'category.update': {
        const { opId: _o, type: _t, id, ...patch } = op;
        await this.categories.update(userId, id, patch);
        return;
      }
      case 'category.delete':
        return this.categories.remove(userId, op.id);
      case 'category.restore':
        await this.categories.restore(userId, op.id);
        return;

      case 'page.create': {
        const { opId: _o, type: _t, ...input } = op;
        await this.pages.create(userId, input);
        return;
      }
      case 'page.update': {
        const { opId: _o, type: _t, id, ...patch } = op;
        await this.pages.update(userId, id, patch);
        return;
      }
      case 'page.delete':
        return this.pages.remove(userId, op.id);
      case 'page.restore':
        await this.pages.restore(userId, op.id);
        return;
    }
  }
}
