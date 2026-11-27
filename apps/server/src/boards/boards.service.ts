import { ConflictException, Injectable } from '@nestjs/common';
import {
  BOARD_EVENTS,
  comparePositions,
  Permission,
  permissionsToString,
  positionBetween,
  type BoardDetailDto,
  type BoardDto,
  type BoardMemberDto,
  type ColumnDto,
  type CreateBoardInput,
  type CreateColumnInput,
  type DeleteColumnInput,
  type DuplicateBoardInput,
  type UpdateBoardInput,
  type UpdateColumnInput,
} from '@os-planner/shared';
import { BOARD_LIMITS } from '@os-planner/shared/boards';
import { newId } from '../common/crypto.js';
import { ChangeSeqService } from '../prisma/change-seq.service.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { QuotaService } from '../quota/quota.service.js';
import { PermissionService } from '../spaces/permission.service.js';
import { idTaken, invalid, notFound } from '../tree/tree.error.js';
import { BoardEvents } from './board-events.js';
import { TASK_INCLUDE, toBoardDto, toColumnDto, toTaskDto, taskBytes } from './board-views.js';
import { LabelsService } from './labels.service.js';

const DEFAULT_COLUMNS = [
  { name: 'To do', kind: 'todo' },
  { name: 'Doing', kind: 'doing' },
  { name: 'Done', kind: 'done' },
] as const;

const byPosition = <T extends { position: string; id: string }>(a: T, b: T) => comparePositions(a, b);

/** Boards and their columns. Tasks live in TasksService. */
@Injectable()
export class BoardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seq: ChangeSeqService,
    private readonly perms: PermissionService,
    private readonly quota: QuotaService,
    private readonly labels: LabelsService,
    private readonly events: BoardEvents,
  ) {}

  // ---------------------------------------------------------------- reading

  /** The boards of a space the person may see (archived ones included: the client decides how to show them). */
  async list(userId: string, spaceId: string): Promise<BoardDto[]> {
    await this.perms.requireBoardSpace(userId, spaceId);
    const hidden = await this.perms.hiddenBoards(userId, spaceId);
    const rows = await this.prisma.board.findMany({ where: { spaceId, deletedAt: null, ...(hidden.size && { id: { notIn: [...hidden] } }) } });
    return rows.sort(byPosition).map(toBoardDto);
  }

  /** The board with its columns, tasks (subtasks too), usable labels and the people who can be assigned. */
  async detail(userId: string, id: string): Promise<BoardDetailDto> {
    const access = await this.perms.requireBoard(userId, id);
    if (access.board.deletedAt) throw notFound();
    const [columns, tasks, labels, members] = await Promise.all([
      this.prisma.boardColumn.findMany({ where: { boardId: id, deletedAt: null } }),
      this.prisma.task.findMany({ where: { boardId: id, deletedAt: null }, include: TASK_INCLUDE }),
      this.labels.usable(access.board.spaceId),
      this.membersOf(access.board, access.chat?.teamId ?? null, userId),
    ]);
    return {
      board: toBoardDto(access.board),
      columns: columns.sort(byPosition).map(toColumnDto),
      tasks: tasks.map(toTaskDto).sort(byPosition),
      labels: labels.map((l) => ({ id: l.id, spaceId: l.spaceId, name: l.name, color: l.color, description: l.description, inheritable: l.inheritable, seq: Number(l.seq), deletedAt: null })),
      members,
      permissions: permissionsToString(access.perms),
    };
  }

  /** Who can see the board and so may be assigned its tasks (the owner alone, for a personal board). */
  async membersOf(board: { id: string; spaceId: string }, teamId: string | null, ownerCandidate: string): Promise<BoardMemberDto[]> {
    let candidates: string[];
    if (teamId) candidates = (await this.prisma.teamMember.findMany({ where: { teamId }, select: { userId: true } })).map((m) => m.userId);
    else candidates = [ownerCandidate];
    const viewers = await this.perms.boardViewers(board, candidates);
    const ids = [...viewers];
    if (!ids.length) return [];
    const users = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } });
    const nick = teamId ? new Map((await this.prisma.teamMember.findMany({ where: { teamId, userId: { in: ids } }, select: { userId: true, nickname: true } })).map((m) => [m.userId, m.nickname])) : new Map<string, string | null>();
    return users
      .map((u) => ({ userId: u.id, displayName: nick.get(u.id) || u.displayName }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName) || (a.userId < b.userId ? -1 : 1));
  }

  // ---------------------------------------------------------------- boards

  /** Idempotent: a repeat with the same id returns the board that exists. */
  async create(userId: string, spaceId: string, input: CreateBoardInput): Promise<BoardDto> {
    await this.perms.requireBoardSpace(userId, spaceId, Permission.MANAGE_BOARDS);
    return this.prisma.fresh(async (tx) => {
      const seq = await this.seq.next(tx, spaceId);
      const existing = await tx.board.findUnique({ where: { id: input.id } });
      if (existing) {
        if (existing.spaceId !== spaceId) throw idTaken();
        return toBoardDto(existing);
      }
      if ((await tx.board.count({ where: { spaceId, deletedAt: null } })) >= BOARD_LIMITS.boardsPerSpace) throw new ConflictException('board_limit_reached');
      const board = await tx.board.create({
        data: { id: input.id, spaceId, name: input.name, description: input.description ?? '', icon: input.icon ?? null, color: input.color ?? null, position: input.position, createdBy: userId, seq },
      });
      const columns = input.columns?.length ? input.columns : this.defaultColumns();
      if (new Set(columns.map((c) => c.id)).size !== columns.length) throw invalid('duplicate_column');
      for (const c of columns) {
        if (await tx.boardColumn.findUnique({ where: { id: c.id }, select: { id: true } })) throw idTaken();
        await tx.boardColumn.create({
          data: { id: c.id, boardId: board.id, spaceId, name: c.name, position: c.position, kind: c.kind ?? 'custom', wipLimit: c.wipLimit ?? null, color: c.color ?? null, seq },
        });
      }
      await this.announce(tx, board.id);
      return toBoardDto(board);
    });
  }

  private defaultColumns(): CreateColumnInput[] {
    const keys: string[] = [];
    let prev: string | null = null;
    for (let i = 0; i < DEFAULT_COLUMNS.length; i++) keys.push((prev = positionBetween(prev, null)));
    return DEFAULT_COLUMNS.map((c, i) => ({ id: newId(), name: c.name, position: keys[i]!, kind: c.kind }));
  }

  async update(userId: string, id: string, patch: UpdateBoardInput): Promise<BoardDto> {
    const access = await this.perms.requireBoard(userId, id, Permission.MANAGE_BOARDS);
    return this.prisma.fresh(async (tx) => {
      const seq = await this.seq.next(tx, access.board.spaceId);
      const current = await tx.board.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw notFound();
      const row = await tx.board.update({
        where: { id },
        data: {
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.description !== undefined && { description: patch.description }),
          ...(patch.icon !== undefined && { icon: patch.icon }),
          ...(patch.color !== undefined && { color: patch.color }),
          ...(patch.position !== undefined && { position: patch.position }),
          ...(patch.archived !== undefined && { archivedAt: patch.archived ? (current.archivedAt ?? new Date()) : null }),
          seq,
        },
      });
      await this.announce(tx, id);
      return toBoardDto(row);
    });
  }

  /** Moves the board, its columns and its tasks to the trash under one timestamp (restore undoes exactly that). */
  async remove(userId: string, id: string): Promise<void> {
    const access = await this.perms.requireBoard(userId, id, Permission.MANAGE_BOARDS);
    await this.prisma.fresh(async (tx) => {
      const seq = await this.seq.next(tx, access.board.spaceId);
      const current = await tx.board.findUnique({ where: { id } });
      if (!current || current.deletedAt) return;
      const deletedAt = new Date();
      await tx.board.update({ where: { id }, data: { deletedAt, seq } });
      await tx.boardColumn.updateMany({ where: { boardId: id, deletedAt: null }, data: { deletedAt, seq } });
      await tx.task.updateMany({ where: { boardId: id, deletedAt: null }, data: { deletedAt, seq } });
      await this.announce(tx, id);
    });
  }

  async restore(userId: string, id: string): Promise<BoardDto> {
    const access = await this.perms.requireBoard(userId, id, Permission.MANAGE_BOARDS);
    return this.prisma.fresh(async (tx) => {
      const seq = await this.seq.next(tx, access.board.spaceId);
      const current = await tx.board.findUnique({ where: { id } });
      if (!current) throw notFound();
      if (!current.deletedAt) return toBoardDto(current);
      const stamp = current.deletedAt;
      const row = await tx.board.update({ where: { id }, data: { deletedAt: null, seq } });
      await tx.boardColumn.updateMany({ where: { boardId: id, deletedAt: stamp }, data: { deletedAt: null, seq } });
      await tx.task.updateMany({ where: { boardId: id, deletedAt: stamp }, data: { deletedAt: null, seq } });
      await this.announce(tx, id);
      return toBoardDto(row);
    });
  }

  /** A copy in the same space: the same columns, and (with `withTasks`) the tasks with their labels, dates and an unticked checklist. */
  async duplicate(userId: string, id: string, input: DuplicateBoardInput): Promise<BoardDto> {
    const access = await this.perms.requireBoard(userId, id, Permission.MANAGE_BOARDS);
    if (access.board.deletedAt) throw notFound();
    const spaceId = access.board.spaceId;
    const canTasks = input.withTasks && (await this.perms.requireBoardSpace(userId, spaceId, Permission.CREATE_TASKS).then(() => true, () => false));
    return this.prisma.fresh(async (tx) => {
      const seq = await this.seq.next(tx, spaceId);
      const existing = await tx.board.findUnique({ where: { id: input.id } });
      if (existing) {
        if (existing.spaceId !== spaceId) throw idTaken();
        return toBoardDto(existing);
      }
      if ((await tx.board.count({ where: { spaceId, deletedAt: null } })) >= BOARD_LIMITS.boardsPerSpace) throw new ConflictException('board_limit_reached');
      const source = await tx.board.findUnique({ where: { id } });
      if (!source || source.deletedAt) throw notFound();
      const siblings = await tx.board.findMany({ where: { spaceId, deletedAt: null }, select: { id: true, position: true } });
      const last = siblings.sort(byPosition).at(-1)?.position ?? null;
      const copy = await tx.board.create({
        data: { id: input.id, spaceId, name: input.name ?? `${source.name} (copy)`.slice(0, BOARD_LIMITS.nameMax), description: source.description, icon: source.icon, color: source.color, position: positionBetween(last, null), createdBy: userId, seq },
      });
      const columns = (await tx.boardColumn.findMany({ where: { boardId: id, deletedAt: null } })).sort(byPosition);
      const columnMap = new Map<string, string>();
      for (const c of columns) {
        const cid = newId();
        columnMap.set(c.id, cid);
        await tx.boardColumn.create({ data: { id: cid, boardId: copy.id, spaceId, name: c.name, position: c.position, kind: c.kind, wipLimit: c.wipLimit, color: c.color, seq } });
      }
      if (canTasks) {
        const tasks = await tx.task.findMany({ where: { boardId: id, deletedAt: null }, include: TASK_INCLUDE });
        const idMap = new Map(tasks.map((t) => [t.id, newId()]));
        let bytes = 0;
        for (const t of tasks) bytes += taskBytes(t.title, t.description);
        await this.quota.chargeSpace(tx, spaceId, bytes);
        // parents first, so a subtask's parent exists when it is written
        for (const t of [...tasks].sort((a, b) => Number(!!a.parentTaskId) - Number(!!b.parentTaskId))) {
          const nid = idMap.get(t.id)!;
          await tx.task.create({
            data: {
              id: nid,
              boardId: copy.id,
              columnId: columnMap.get(t.columnId) ?? [...columnMap.values()][0]!,
              spaceId,
              parentTaskId: t.parentTaskId ? (idMap.get(t.parentTaskId) ?? null) : null,
              title: t.title,
              description: t.description ?? undefined,
              position: t.position,
              priority: t.priority,
              startAt: t.startAt,
              dueAt: t.dueAt,
              allDay: t.allDay,
              completedAt: t.completedAt,
              sizeBytes: taskBytes(t.title, t.description),
              createdBy: userId,
              seq,
              labels: { create: t.labels.map((l) => ({ labelId: l.labelId })) },
              checklist: { create: t.checklist.map((c) => ({ id: newId(), text: c.text, done: false, position: c.position })) },
            },
          });
          await tx.taskActivity.create({ data: { id: newId(), taskId: nid, actorId: userId, kind: 'created', data: { from: id } } });
        }
      }
      await this.announce(tx, copy.id);
      return toBoardDto(copy);
    });
  }

  // ---------------------------------------------------------------- columns

  async createColumn(userId: string, boardId: string, input: CreateColumnInput): Promise<ColumnDto> {
    const access = await this.perms.requireBoard(userId, boardId, Permission.MANAGE_BOARDS);
    const spaceId = access.board.spaceId;
    return this.prisma.fresh(async (tx) => {
      const seq = await this.seq.next(tx, spaceId);
      const existing = await tx.boardColumn.findUnique({ where: { id: input.id } });
      if (existing) {
        if (existing.boardId !== boardId) throw idTaken();
        return toColumnDto(existing);
      }
      const board = await tx.board.findFirst({ where: { id: boardId, deletedAt: null } });
      if (!board) throw notFound();
      if ((await tx.boardColumn.count({ where: { boardId, deletedAt: null } })) >= BOARD_LIMITS.columnsPerBoard) throw new ConflictException('column_limit_reached');
      const row = await tx.boardColumn.create({
        data: { id: input.id, boardId, spaceId, name: input.name, position: input.position, kind: input.kind ?? 'custom', wipLimit: input.wipLimit ?? null, color: input.color ?? null, seq },
      });
      await this.announce(tx, boardId);
      return toColumnDto(row);
    });
  }

  async updateColumn(userId: string, id: string, patch: UpdateColumnInput): Promise<ColumnDto> {
    const column = await this.prisma.boardColumn.findUnique({ where: { id } });
    if (!column || column.deletedAt) throw notFound();
    const access = await this.perms.requireBoard(userId, column.boardId, Permission.MANAGE_BOARDS);
    return this.prisma.fresh(async (tx) => {
      const seq = await this.seq.next(tx, access.board.spaceId);
      const current = await tx.boardColumn.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw notFound();
      const row = await tx.boardColumn.update({
        where: { id },
        data: {
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.position !== undefined && { position: patch.position }),
          ...(patch.kind !== undefined && { kind: patch.kind }),
          ...(patch.wipLimit !== undefined && { wipLimit: patch.wipLimit }),
          ...(patch.color !== undefined && { color: patch.color }),
          seq,
        },
      });
      // A task in a "done" column is complete: turning a column into one (or out of it) changes the tasks in it.
      if (patch.kind !== undefined && patch.kind !== current.kind) {
        if (patch.kind === 'done') await tx.task.updateMany({ where: { columnId: id, deletedAt: null, completedAt: null }, data: { completedAt: new Date(), seq } });
        else if (current.kind === 'done') await tx.task.updateMany({ where: { columnId: id, deletedAt: null, completedAt: { not: null } }, data: { completedAt: null, seq } });
      }
      await this.announce(tx, current.boardId);
      return toColumnDto(row);
    });
  }

  /** Deleting a column moves its tasks (and gives the column a tombstone). The board always keeps at least one column. */
  async removeColumn(userId: string, id: string, input: DeleteColumnInput): Promise<void> {
    const column = await this.prisma.boardColumn.findUnique({ where: { id } });
    if (!column) throw notFound();
    const access = await this.perms.requireBoard(userId, column.boardId, Permission.MANAGE_BOARDS);
    await this.prisma.fresh(async (tx) => {
      const seq = await this.seq.next(tx, access.board.spaceId);
      const current = await tx.boardColumn.findUnique({ where: { id } });
      if (!current || current.deletedAt) return;
      const others = await tx.boardColumn.findMany({ where: { boardId: current.boardId, deletedAt: null, id: { not: id } } });
      if (!others.length) throw invalid('last_column');
      const tasks = await tx.task.findMany({ where: { columnId: id, deletedAt: null }, select: { id: true, parentTaskId: true, position: true } });
      if (tasks.length) {
        const target = others.find((c) => c.id === input.moveTo);
        if (!target) throw invalid('move_to_required');
        const inTarget = await tx.task.findMany({ where: { columnId: target.id, deletedAt: null, parentTaskId: null }, select: { id: true, position: true } });
        let last = inTarget.sort(byPosition).at(-1)?.position ?? null;
        for (const t of [...tasks].filter((x) => !x.parentTaskId).sort(byPosition)) {
          last = positionBetween(last, null);
          await tx.task.update({ where: { id: t.id }, data: { columnId: target.id, position: last, seq, ...(target.kind === 'done' ? { completedAt: new Date() } : column.kind === 'done' ? { completedAt: null } : {}) } });
        }
        await tx.task.updateMany({ where: { columnId: id, deletedAt: null, parentTaskId: { not: null } }, data: { columnId: target.id, seq } });
      }
      await tx.boardColumn.update({ where: { id }, data: { deletedAt: new Date(), seq } });
      await this.announce(tx, current.boardId);
    });
  }

  // ---------------------------------------------------------------- events

  /** Tells the board's room its board and columns (what a viewer needs to redraw the frame). */
  private async announce(tx: Tx, boardId: string): Promise<void> {
    const board = await tx.board.findUniqueOrThrow({ where: { id: boardId } });
    const columns = await tx.boardColumn.findMany({ where: { boardId } });
    this.events.emit(tx, BOARD_EVENTS.boardUpdated, {
      spaceId: board.spaceId,
      boardId,
      id: boardId,
      payload: { board: toBoardDto(board), columns: columns.sort(byPosition).map(toColumnDto) },
    });
  }
}
