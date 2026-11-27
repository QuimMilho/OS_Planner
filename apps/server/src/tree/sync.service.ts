import { Injectable, Logger } from '@nestjs/common';
import {
  isSharedCursorKey,
  sharedCursorKey,
  syncOpSchema,
  type SpaceChangesDto,
  type SyncBatchResponse,
  type SyncChangesDto,
  type FieldSeq,
  type SyncChangesQuery,
  type SyncEntityDto,
  type SyncOp,
  type SyncOpResult,
} from '@os-planner/shared';
import { hasPermission, Permission } from '@os-planner/shared';
import { MergeRejected, mergeScope, type MergeScope } from '../common/merge-scope.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QuotaExceeded } from '../quota/quota.errors.js';
import { PermissionService } from '../spaces/permission.service.js';
import { SharesService } from '../sharing/shares.service.js';
import { SpacesService } from '../spaces/spaces.service.js';
import { TASK_INCLUDE, toBoardDto, toColumnDto, toLabelDto, toTaskDto } from '../boards/board-views.js';
import { TasksService } from '../boards/tasks.service.js';
import { canSee, EVENT_INCLUDE, namesNeeded, namesOf, toEventDto, type EventRow } from '../calendar/event-views.js';
import { EventsService } from '../calendar/events.service.js';
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
    private readonly shares: SharesService,
    private readonly tasks: TasksService,
    private readonly events: EventsService,
  ) {}

  /**
   * What changed since the client's cursors.
   *
   *  - `cursors` (one per space the client holds): every space the person may still see answers
   *    under `spaces`; the ones they may not (left or removed from a team, deleted team or
   *    project, no such space) are listed in `revokedSpaces` so the client can purge them.
   *  - Notebooks shared with the person are listed in `sharedNotebooks` and each answers under its own key
   *    (`shared:<notebookId>`, cursor = the owner's space sequence, rows = that notebook only). A key the client holds
   *    for a share that ended is revoked like a space.
   */
  async changes(userId: string, query: SyncChangesQuery): Promise<SyncChangesDto> {
    {
      const visible = await this.perms.notebookSpaces(userId);
      // Boards are asked for separately: a role can see a space's boards without seeing its notebooks, or the other way round.
      const boardSpaces = await this.perms.boardSpaces(userId);
      const calendarSpaces = await this.perms.calendarSpaces(userId);
      const held = calendarSpaces.size ? await this.perms.heldRoleIds(userId) : new Set<string>();
      const spaces: Record<string, SpaceChangesDto> = {};
      const revokedSpaces: string[] = [];
      const shared = await this.shares.sharedWithMe(userId);
      const sharedKeys = new Set(shared.map((s) => sharedCursorKey(s.notebookId)));
      for (const [key, since] of Object.entries(query.cursors)) {
        if (isSharedCursorKey(key)) {
          if (!sharedKeys.has(key)) revokedSpaces.push(key);
          continue;
        }
        if (!visible.has(key) && !boardSpaces.has(key) && !calendarSpaces.has(key)) revokedSpaces.push(key);
        else
          spaces[key] = await this.spaceChanges(key, since, {
            hidden: visible.has(key) ? await this.perms.hiddenNotebooks(userId, key) : undefined,
            notebooks: visible.has(key),
            hiddenBoards: boardSpaces.has(key) ? await this.perms.hiddenBoards(userId, key) : null,
            calendar: calendarSpaces.has(key) ? { userId, held, manager: calendarSpaces.get(key)!.space.kind === 'personal' || hasPermission(calendarSpaces.get(key)!.perms, Permission.MANAGE_MEETINGS) } : undefined,
          });
      }
      for (const s of shared) {
        const key = sharedCursorKey(s.notebookId);
        spaces[key] = await this.spaceChanges(s.spaceId, query.cursors[key] ?? 0, { only: s.notebookId });
      }
      return { ...NOTHING, spaces, revokedSpaces, sharedNotebooks: shared };
    }
  }

  /**
   * Everything in one space that changed after `since`, tombstones included.
   *
   * `hidden`: notebooks of the space the person may not see (their rows are left out and listed, so the client drops what it holds).
   * `only`: just this notebook (a notebook shared with the person); nothing of boards then.
   * `notebooks`: false when the person may not see this space's notebooks at all.
   * `hiddenBoards`: null when they may not see its boards at all; else the boards they may not see (left out and listed like notebooks).
   *
   * Consistency: the space's `changeSeq` counter is read first as the ceiling, inside one
   * snapshot. Writers bump it under a row lock, so nothing at or below the ceiling can still
   * be uncommitted, and nothing above it is returned. The cursor handed back is therefore safe.
   *
   * Pagination: rows are cut at a seq boundary. Rows written by one transaction share a seq (a
   * notebook delete touches every page in it), so a boundary may never split a seq group; if a
   * single group is larger than the limit it is returned whole.
   */
  private spaceChanges(
    spaceId: string,
    since: number,
    opts: { hidden?: ReadonlySet<string>; only?: string; notebooks?: boolean; hiddenBoards?: ReadonlySet<string> | null; calendar?: { userId: string; held: ReadonlySet<string>; manager: boolean } } = {},
  ): Promise<SpaceChangesDto> {
    const { hidden, only } = opts;
    const withNotebooks = opts.notebooks ?? true;
    const withBoards = !only && opts.hiddenBoards !== undefined && opts.hiddenBoards !== null;
    const hiddenIds = hidden ? [...hidden] : [];
    const hiddenBoardIds = opts.hiddenBoards ? [...opts.hiddenBoards] : [];
    // Without opts for boards (the old single-cursor call) a personal space still gets its boards.
    const boardsToo = withBoards || (opts.hiddenBoards === undefined && !only);
    const calendar = opts.calendar;
    return this.prisma.$transaction(async (tx) => {
      const { changeSeq: head } = await tx.space.findUniqueOrThrow({ where: { id: spaceId }, select: { changeSeq: true } });
      const after = BigInt(since);
      const emptyEvents = calendar ? { events: [] as never[] } : {};
      const hiddenNotebooks = hiddenIds.length ? { hiddenNotebooks: hiddenIds } : {};
      const hiddenBoardsOut = hiddenBoardIds.length ? { hiddenBoards: hiddenBoardIds } : {};
      if (after >= head) {
        return { cursor: Number(head), hasMore: false, notebooks: [], categories: [], pages: [], ...(boardsToo ? { boards: [], columns: [], tasks: [], labels: [] } : {}), ...emptyEvents, ...hiddenNotebooks, ...hiddenBoardsOut };
      }

      const fetch = (upTo: bigint, take?: number) => {
        const where = { spaceId, seq: { gt: after, lte: upTo } };
        const orderBy = { seq: 'asc' } as const;
        const rows = { ...where, ...(only ? { notebookId: only } : hiddenIds.length ? { notebookId: { notIn: hiddenIds } } : {}) };
        const nbWhere = { ...where, ...(only ? { id: only } : hiddenIds.length ? { id: { notIn: hiddenIds } } : {}) };
        const boardRows = { ...where, ...(hiddenBoardIds.length ? { boardId: { notIn: hiddenBoardIds } } : {}) };
        const none = Promise.resolve([] as never[]);
        return Promise.all([
          withNotebooks ? tx.notebook.findMany({ where: nbWhere, orderBy, take }) : none,
          withNotebooks ? tx.category.findMany({ where: rows, orderBy, take }) : none,
          withNotebooks ? tx.page.findMany({ where: rows, orderBy, take, select: PAGE_META_SELECT }) : none,
          // A notebook that left the space: only the space it left hears about it (not a shared view of it).
          only || !withNotebooks ? none : tx.notebookMove.findMany({ where, orderBy, take }),
          boardsToo ? tx.board.findMany({ where: { ...where, ...(hiddenBoardIds.length ? { id: { notIn: hiddenBoardIds } } : {}) }, orderBy, take }) : none,
          boardsToo ? tx.boardColumn.findMany({ where: boardRows, orderBy, take }) : none,
          boardsToo ? tx.task.findMany({ where: boardRows, orderBy, take, include: TASK_INCLUDE }) : none,
          boardsToo ? tx.label.findMany({ where, orderBy, take }) : none,
          boardsToo ? tx.taskMove.findMany({ where, orderBy, take }) : none,
          calendar ? tx.event.findMany({ where, orderBy, take, include: EVENT_INCLUDE }) : none,
        ] as const);
      };

      const limit = SYNC_PAGE.limit;
      let upTo = head;
      let [nb, cat, pg, mv, bd, col, tk, lb, tm, ev] = await fetch(upTo, limit + 1);
      const overflow = ([nb, cat, pg, mv, bd, col, tk, lb, tm, ev] as { seq: bigint }[][]).filter((rows) => rows.length > limit).map((rows) => rows[limit]!.seq);

      if (overflow.length) {
        const firstOverflow = overflow.reduce((a, b) => (a < b ? a : b));
        // Stop just before the first seq that no longer fits entirely...
        upTo = firstOverflow - 1n;
        // ...unless that leaves nothing, i.e. one seq group alone exceeds the limit: take it whole.
        if (upTo <= after) upTo = firstOverflow;
        [nb, cat, pg, mv, bd, col, tk, lb, tm, ev] = await fetch(upTo);
      }

      // Events: the ones the person may see, as they see them; the ones that changed and are not theirs (any more) are listed to be dropped.
      let eventsOut: { events: ReturnType<typeof toEventDto>[]; hiddenEvents?: string[] } | Record<string, never> = {};
      if (calendar) {
        const rows = ev as unknown as EventRow[];
        const mine = rows.filter((r) => canSee(r, calendar));
        const names = await namesOf(tx, namesNeeded(mine, calendar));
        const hiddenEvents = rows.filter((r) => !canSee(r, calendar)).map((r) => r.id);
        eventsOut = { events: mine.map((r) => toEventDto(r, calendar, names)), ...(hiddenEvents.length ? { hiddenEvents } : {}) };
      }

      return {
        cursor: Number(upTo),
        hasMore: upTo < head,
        notebooks: nb.map(toNotebookDto),
        categories: cat.map(toCategoryDto),
        pages: pg.map(toPageMetaDto),
        ...(boardsToo ? { boards: bd.map(toBoardDto), columns: col.map(toColumnDto), tasks: tk.map(toTaskDto), labels: lb.map(toLabelDto) } : {}),
        ...eventsOut,
        ...hiddenNotebooks,
        ...hiddenBoardsOut,
        ...(mv.length ? { movedOut: mv.map((m) => m.notebookId) } : {}),
        ...(tm.length ? { movedOutTasks: tm.map((m) => m.taskId) } : {}),
      };
    });
  }

  /**
   * Applies queued offline operations in order. Each one stands alone: a failure is reported in
   * its result and the rest still run (a dependent op will then fail with not_found itself).
   *
   * Offline merge (phase 15): an op that carries `base` (what the device saw) is merged field by field inside the service's own
   * write transaction (see common/merge-scope.ts): fields somebody else changed since stay as they are online and come back in
   * `rejected`, the others are applied (`merged`). An op nothing of which could be applied changes nothing at all (its
   * transaction rolls back) and answers `ok: false` with `conflict`, `target_deleted` or `deleted_but_changed`.
   */
  async batch(userId: string, rawOps: unknown[]): Promise<SyncBatchResponse> {
    const results: SyncOpResult[] = [];
    // What this push has written so far (a device never conflicts with its own earlier ops).
    const own = new Map<string, FieldSeq>();
    for (const raw of rawOps) {
      const parsed = syncOpSchema.safeParse(raw);
      if (!parsed.success) {
        const opId = typeof (raw as { opId?: unknown })?.opId === 'string' ? (raw as { opId: string }).opId : '';
        const issue = parsed.error.issues[0];
        results.push({ opId, ok: false, error: 'invalid', message: `${issue?.path.join('.') || 'op'}: ${issue?.message}` });
        continue;
      }
      const op = parsed.data;
      const scope: MergeScope = { base: 'base' in op ? op.base : undefined, own, result: { applied: [], rejected: {}, merged: false } };
      try {
        const entity = await mergeScope.run(scope, () => this.apply(userId, op));
        const { applied, rejected, merged } = scope.result;
        results.push({
          opId: op.opId,
          ok: true,
          ...(scope.base ? { status: merged ? ('merged' as const) : ('applied' as const), applied } : {}),
          ...(merged ? { rejected } : {}),
          ...(entity && scope.base ? { entity } : {}),
        });
      } catch (e) {
        if (e instanceof MergeRejected) {
          const entity = await this.entityOf(userId, op).catch(() => undefined);
          results.push({ opId: op.opId, ok: false, status: 'rejected', error: e.code, ...(Object.keys(e.rejected).length ? { rejected: e.rejected } : {}), ...(entity ? { entity } : {}) });
        } else if (e instanceof TreeError && e.code === 'not_found' && op.type.endsWith('.delete')) {
          // Deleting what is not there (any more) or what the person may not see is done: both answer alike (nothing tells them
          // apart), and a device that sends its outbox again is not told off. Nothing hidden was touched (the check came first).
          results.push({ opId: op.opId, ok: true });
        } else if (e instanceof TreeError) {
          // A device that sent what it saw (`base`) is told the target is gone, so it keeps its change in the history (not found: deleted, purged, or no longer visible).
          const gone = e.code === 'not_found' && 'base' in op && op.base !== undefined && (op.type.endsWith('.update') || op.type.endsWith('.move'));
          results.push({ opId: op.opId, ok: false, status: gone ? 'rejected' : undefined, error: gone ? 'target_deleted' : e.code, message: e.message });
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

  /** The entity an update-like op is about, as it is online now (what a device refreshes what it holds from). Events are re-read by the device. */
  private async entityOf(userId: string, op: SyncOp): Promise<SyncEntityDto | undefined> {
    const id = 'id' in op ? op.id : undefined;
    if (!id) return undefined;
    const kind = op.type.split('.')[0];
    switch (kind) {
      case 'notebook': {
        const row = await this.prisma.notebook.findUnique({ where: { id } });
        return row && (await this.perms.notebookAccess(userId, id)) ? { kind, row: toNotebookDto(row) } : undefined;
      }
      case 'category': {
        const row = await this.prisma.category.findUnique({ where: { id } });
        return row && (await this.perms.notebookAccess(userId, row.notebookId)) ? { kind, row: toCategoryDto(row) } : undefined;
      }
      case 'page': {
        const row = await this.prisma.page.findUnique({ where: { id }, select: PAGE_META_SELECT });
        return row && (await this.perms.notebookAccess(userId, row.notebookId)) ? { kind, row: toPageMetaDto(row) } : undefined;
      }
      case 'task': {
        const row = await this.prisma.task.findUnique({ where: { id }, include: TASK_INCLUDE });
        return row && (await this.perms.boardAccess(userId, row.boardId)) ? { kind, row: toTaskDto(row) } : undefined;
      }
      default:
        return undefined;
    }
  }

  private async apply(userId: string, op: SyncOp): Promise<SyncEntityDto | undefined | void> {
    switch (op.type) {
      case 'notebook.create': {
        const { opId: _o, type: _t, ...input } = op;
        await this.notebooks.create(userId, input);
        return;
      }
      case 'notebook.update': {
        const { opId: _o, type: _t, id, base: _b, ...patch } = op;
        return { kind: 'notebook', row: await this.notebooks.update(userId, id, patch) };
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
        const { opId: _o, type: _t, id, base: _b, ...patch } = op;
        return { kind: 'category', row: await this.categories.update(userId, id, patch) };
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
        const { opId: _o, type: _t, id, base: _b, ...patch } = op;
        return { kind: 'page', row: await this.pages.update(userId, id, patch) };
      }
      case 'page.delete':
        return this.pages.remove(userId, op.id);
      case 'page.restore':
        await this.pages.restore(userId, op.id);
        return;

      case 'task.create': {
        const { opId: _o, type: _t, boardId, ...input } = op;
        await this.tasks.create(userId, boardId, input);
        return;
      }
      case 'task.update': {
        const { opId: _o, type: _t, id, base: _b, ...patch } = op;
        return { kind: 'task', row: await this.tasks.update(userId, id, patch) };
      }
      case 'task.move': {
        const { opId: _o, type: _t, id, base: _b, ...input } = op;
        return { kind: 'task', row: await this.tasks.move(userId, id, input) };
      }
      case 'task.delete':
        return this.tasks.remove(userId, op.id);
      case 'task.restore':
        await this.tasks.restore(userId, op.id);
        return;

      case 'event.create': {
        const { opId: _o, type: _t, ...input } = op;
        await this.events.create(userId, input);
        return;
      }
      case 'event.update': {
        const { opId: _o, type: _t, id, base: _b, ...patch } = op;
        return { kind: 'event', row: await this.events.update(userId, id, patch) };
      }
      case 'event.cancel': {
        const { opId: _o, type: _t, id, base: _b, ...input } = op;
        return this.events.cancel(userId, id, input);
      }
      case 'event.rsvp': {
        const { opId: _o, type: _t, id, ...input } = op;
        await this.events.rsvp(userId, id, input);
        return;
      }
    }
  }
}
