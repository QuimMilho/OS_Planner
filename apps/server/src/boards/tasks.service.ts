import { Injectable } from '@nestjs/common';
import {
  BOARD_EVENTS,
  comparePositions,
  evenPositions,
  hasPermission,
  Permission,
  positionBetween,
  POSITION_REBALANCE_LENGTH,
  type ActivityKind,
  type CreateTaskInput,
  type MoveTaskInput,
  type TaskDetailDto,
  type TaskDto,
  type UpdateTaskInput,
} from '@os-planner/shared';
import { BOARD_LIMITS, validateTaskDescription } from '@os-planner/shared/boards';
import { newId } from '../common/crypto.js';
import { changedKeys, guardDelete, guardUpdate } from '../common/merge-scope.js';
import { jsonEquals } from '../common/stable-json.js';
import { Prisma, type BoardColumn } from '../generated/prisma/client.js';
import { NotificationService } from '../notifications/notification.service.js';
import { StorageService } from '../media/storage.service.js';
import { ChangeSeqService } from '../prisma/change-seq.service.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { QuotaService } from '../quota/quota.service.js';
import { PermissionService, type BoardAccess } from '../spaces/permission.service.js';
import { forbidden, idTaken, invalid, notFound, wipLimit } from '../tree/tree.error.js';
import { BoardEvents } from './board-events.js';
import { normalizeAllDay, TASK_INCLUDE, taskBytes, toTaskDto, type TaskRow } from './board-views.js';
import { LabelsService } from './labels.service.js';
import { isOwnTask, OWN_FIELDS, TaskAccess, type TaskContext } from './task-access.js';

type Field = 'title' | 'description' | 'priority' | 'startAt' | 'dueAt' | 'allDay' | 'completed' | 'assigneeIds' | 'labelIds' | 'checklist';

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && new Set(a).size === new Set(b).size && a.every((x) => b.includes(x));
const time = (d: Date | null | undefined) => (d ? d.getTime() : null);

/** Tasks: create, change, move, delete and restore. Comments and files are in their own services. */
@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seq: ChangeSeqService,
    private readonly perms: PermissionService,
    private readonly quota: QuotaService,
    private readonly labels: LabelsService,
    private readonly events: BoardEvents,
    private readonly access: TaskAccess,
    private readonly notifications: NotificationService,
    private readonly storage: StorageService,
  ) {}

  // ---------------------------------------------------------------- reading

  /** The task for the drawer: itself, its subtasks, comments, files and the latest of its history. */
  async detail(userId: string, id: string): Promise<TaskDetailDto> {
    const ctx = this.access.live(await this.access.forUser(userId, id));
    const [subtasks, comments, attachments, activity] = await Promise.all([
      this.prisma.task.findMany({ where: { parentTaskId: id, deletedAt: null }, include: TASK_INCLUDE }),
      this.prisma.taskComment.findMany({ where: { taskId: id } }),
      this.prisma.taskAttachment.findMany({ where: { taskId: id }, include: { media: true } }),
      this.prisma.taskActivity.findMany({ where: { taskId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: BOARD_LIMITS.activityPage }),
    ]);
    const names = await this.namesOf([...comments.map((c) => c.authorId), ...activity.map((a) => a.actorId)]);
    return {
      task: toTaskDto(ctx.task),
      subtasks: subtasks.map(toTaskDto).sort(comparePositions),
      comments: comments
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
        .map((c) => ({
          id: c.id,
          taskId: c.taskId,
          authorId: c.authorId,
          authorName: c.authorId ? (names.get(c.authorId) ?? null) : null,
          content: c.content,
          mentions: (c.mentions as { users: string[]; roles: string[]; everyone: boolean; here: boolean } | null) ?? { users: [], roles: [], everyone: false, here: false },
          editedAt: c.editedAt?.toISOString() ?? null,
          createdAt: c.createdAt.toISOString(),
        })),
      attachments: attachments
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((a) => ({
          id: a.id,
          taskId: a.taskId,
          mediaId: a.mediaId,
          name: a.name,
          size: a.media.size,
          mime: a.media.mime,
          kind: a.media.kind === 'video' ? ('video' as const) : ('image' as const),
          width: a.media.width,
          height: a.media.height,
          createdAt: a.createdAt.toISOString(),
        })),
      activity: activity.map((a) => ({
        id: a.id,
        taskId: a.taskId,
        actorId: a.actorId,
        actorName: a.actorId ? (names.get(a.actorId) ?? null) : null,
        kind: a.kind as ActivityKind,
        data: (a.data as Record<string, unknown> | null) ?? {},
        createdAt: a.createdAt.toISOString(),
      })),
      boardName: ctx.board.board.name,
    };
  }

  /** The earlier history of a task, newest first, `before` being the cursor of the last entry of the previous page. */
  async activity(userId: string, id: string, before: string | undefined, limit: number) {
    const ctx = await this.access.forUser(userId, id);
    let cursor: { at: Date; id: string } | null = null;
    if (before) {
      const [isoAt, cid] = Buffer.from(before, 'base64url').toString('utf8').split('|');
      const at = new Date(isoAt ?? '');
      if (cid && !Number.isNaN(at.getTime())) cursor = { at, id: cid };
    }
    const rows = await this.prisma.taskActivity.findMany({
      where: { taskId: ctx.task.id, ...(cursor ? { OR: [{ createdAt: { lt: cursor.at } }, { createdAt: cursor.at, id: { lt: cursor.id } }] } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const names = await this.namesOf(page.map((a) => a.actorId));
    const last = page.at(-1);
    return {
      items: page.map((a) => ({
        id: a.id,
        taskId: a.taskId,
        actorId: a.actorId,
        actorName: a.actorId ? (names.get(a.actorId) ?? null) : null,
        kind: a.kind as ActivityKind,
        data: (a.data as Record<string, unknown> | null) ?? {},
        createdAt: a.createdAt.toISOString(),
      })),
      nextCursor: rows.length > limit && last ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString('base64url') : null,
    };
  }

  /** The trashed top-level tasks of a board (restore or delete them for good). */
  async trash(userId: string, boardId: string): Promise<TaskDto[]> {
    const access = await this.perms.requireBoard(userId, boardId);
    if (access.board.deletedAt) throw notFound();
    const rows = await this.prisma.task.findMany({ where: { boardId, deletedAt: { not: null }, parentTaskId: null }, include: TASK_INCLUDE });
    return rows.map(toTaskDto).sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
  }

  private async namesOf(ids: readonly (string | null)[]): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((i): i is string => !!i))];
    if (!wanted.length) return new Map();
    return new Map((await this.prisma.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((u) => [u.id, u.displayName]));
  }

  // ---------------------------------------------------------------- creating

  /** Idempotent: a repeat with the same id returns the task that exists. */
  async create(userId: string, boardId: string, input: CreateTaskInput): Promise<TaskDto> {
    const access = await this.perms.requireBoard(userId, boardId, Permission.CREATE_TASKS);
    if (access.board.deletedAt) throw notFound();
    if (access.board.archivedAt) throw invalid('board_archived');
    if (input.assigneeIds?.length && !hasPermission(access.perms, Permission.ASSIGN_TASKS)) throw forbidden();
    const doc = this.checkDescription(input.description);
    const spaceId = access.board.spaceId;

    return this.prisma.fresh(async (tx) => {
      const seq = await this.seq.next(tx, spaceId);
      const existing = await tx.task.findUnique({ where: { id: input.id }, include: TASK_INCLUDE });
      if (existing) {
        if (existing.boardId !== boardId) throw idTaken();
        return toTaskDto(existing);
      }
      const column = await tx.boardColumn.findFirst({ where: { id: input.columnId, boardId, deletedAt: null } });
      if (!column) throw notFound();
      let parent: TaskRow | null = null;
      if (input.parentTaskId) {
        parent = await tx.task.findFirst({ where: { id: input.parentTaskId, boardId, deletedAt: null }, include: TASK_INCLUDE });
        if (!parent) throw notFound();
        if (parent.parentTaskId) throw invalid('subtask_of_subtask');
        if ((await tx.task.count({ where: { parentTaskId: parent.id, deletedAt: null } })) >= BOARD_LIMITS.subtasksPerTask) throw invalid('too_many_subtasks');
      } else await this.assertWip(tx, column);
      if ((await tx.task.count({ where: { boardId, deletedAt: null } })) >= BOARD_LIMITS.tasksPerBoard) throw invalid('too_many_tasks');
      this.assertPosition(input.position);

      const allDay = input.allDay ?? false;
      const { startAt, dueAt } = this.dates(input.startAt, input.dueAt, allDay);
      const title = input.title.trim();
      const bytes = taskBytes(title, doc);
      await this.quota.chargeSpace(tx, spaceId, bytes);
      const assigneeIds = [...new Set(input.assigneeIds ?? [])];
      const labelIds = [...new Set(input.labelIds ?? [])];
      await this.checkAssignees(tx, access, assigneeIds);
      await this.labels.assertUsable(tx, spaceId, labelIds);
      const checklist = input.checklist ?? [];
      await this.assertChecklistIds(tx, input.id, checklist);

      const position = await this.settlePosition(tx, { boardId, columnId: column.id, parentTaskId: parent?.id ?? null }, input.id, input.position, seq);
      const done = !parent && column.kind === 'done';
      const row = await tx.task.create({
        data: {
          id: input.id,
          boardId,
          columnId: column.id,
          spaceId,
          parentTaskId: parent?.id ?? null,
          title,
          description: this.json(doc),
          position,
          priority: input.priority ?? 'none',
          startAt,
          dueAt,
          allDay,
          completedAt: done || input.completed ? new Date() : null,
          sizeBytes: bytes,
          createdBy: userId,
          seq,
          assignees: { create: assigneeIds.map((id) => ({ userId: id, assignedBy: userId })) },
          labels: { create: labelIds.map((labelId) => ({ labelId })) },
          checklist: { create: checklist.map((c) => ({ id: c.id, text: c.text, done: c.done, position: c.position })) },
        },
        include: TASK_INCLUDE,
      });
      await this.access.log(tx, row.id, userId, 'created', { column: column.name });
      if (parent) {
        await tx.task.update({ where: { id: parent.id }, data: { seq } });
        await this.access.log(tx, parent.id, userId, 'subtask_added', { id: row.id, title });
        const fresh = await tx.task.findUniqueOrThrow({ where: { id: parent.id }, include: TASK_INCLUDE });
        this.emitTask(tx, BOARD_EVENTS.taskUpdated, fresh);
      }
      if (assigneeIds.length) await this.notifyAssigned(tx, row, assigneeIds, userId);
      this.emitTask(tx, BOARD_EVENTS.taskCreated, row);
      return toTaskDto(row);
    });
  }

  // ---------------------------------------------------------------- changing

  async update(userId: string, id: string, patch: UpdateTaskInput): Promise<TaskDto> {
    const ctx = this.access.live(await this.access.forUser(userId, id));
    this.access.writable(ctx);
    const doc = patch.description !== undefined ? this.checkDescription(patch.description) : undefined;
    const changed = this.changedFields(ctx.task, patch, doc);
    if (!changed.size) return toTaskDto(ctx.task);
    this.gate(ctx, userId, changed);
    const spaceId = ctx.task.spaceId;

    return this.prisma.fresh(async (tx) => {
      const seq = await this.seq.next(tx, spaceId);
      const task = await tx.task.findFirst({ where: { id, deletedAt: null }, include: TASK_INCLUDE });
      if (!task) throw notFound();
      // Offline merge: what was asked for, against what is stored now, minus what somebody else changed since the device saw it.
      const wanted = this.changedFields(task, patch, doc);
      if (!wanted.size) return toTaskDto(task);
      const guard = guardUpdate('task', task, wanted, patch, toTaskDto(task) as unknown as Record<string, unknown>);
      const changed = guard.keys as Set<Field>;
      const data: Prisma.TaskUncheckedUpdateInput = { seq, fieldSeq: guard.next(seq) };
      const log: [ActivityKind, Record<string, unknown>][] = [];

      if (changed.has('title') && patch.title !== undefined) {
        data.title = patch.title.trim();
        log.push(['renamed', { from: task.title, to: data.title }]);
      }
      if (changed.has('description')) {
        data.description = this.json(doc);
        log.push(['described', {}]);
      }
      if (changed.has('title') || changed.has('description')) {
        const bytes = taskBytes((data.title as string | undefined) ?? task.title, changed.has('description') ? doc : task.description);
        await this.quota.chargeSpace(tx, spaceId, bytes - task.sizeBytes);
        data.sizeBytes = bytes;
      }
      if (changed.has('priority') && patch.priority) {
        data.priority = patch.priority;
        log.push(['priority', { from: task.priority, to: patch.priority }]);
      }
      if (changed.has('startAt') || changed.has('dueAt') || changed.has('allDay')) {
        const allDay = patch.allDay ?? task.allDay;
        const { startAt, dueAt } = this.dates(patch.startAt !== undefined ? patch.startAt : (task.startAt?.toISOString() ?? null), patch.dueAt !== undefined ? patch.dueAt : (task.dueAt?.toISOString() ?? null), allDay);
        data.startAt = startAt;
        data.dueAt = dueAt;
        data.allDay = allDay;
        if (time(dueAt) !== time(task.dueAt)) data.dueNotifiedAt = null;
        log.push(['dates', { startAt: startAt?.toISOString() ?? null, dueAt: dueAt?.toISOString() ?? null, allDay }]);
      }
      if (changed.has('completed')) await this.setCompleted(tx, task, !!patch.completed, data, log, seq);
      if (changed.has('assigneeIds')) await this.setAssignees(tx, task, ctx.board, patch.assigneeIds ?? [], userId, log);
      if (changed.has('labelIds')) await this.setLabels(tx, task, patch.labelIds ?? [], log);
      if (changed.has('checklist')) await this.setChecklist(tx, task, patch.checklist ?? [], log);

      await tx.task.update({ where: { id }, data });
      for (const [kind, extra] of log.slice(0, 40)) await this.access.log(tx, id, userId, kind, extra);
      const row = await tx.task.findUniqueOrThrow({ where: { id }, include: TASK_INCLUDE });
      this.emitTask(tx, BOARD_EVENTS.taskUpdated, row);
      return toTaskDto(row);
    });
  }

  /** Which fields of the task the patch really changes. */
  private changedFields(task: TaskRow, patch: UpdateTaskInput, doc: ReturnType<TasksService['checkDescription']> | undefined): Set<Field> {
    const out = new Set<Field>();
    if (patch.title !== undefined && patch.title.trim() !== task.title) out.add('title');
    if (patch.description !== undefined && !jsonEquals(doc ?? null, task.description ?? null)) out.add('description');
    if (patch.priority !== undefined && patch.priority !== task.priority) out.add('priority');
    const allDay = patch.allDay ?? task.allDay;
    const norm = (v: string | null | undefined, cur: Date | null): number | null | undefined =>
      v === undefined ? time(cur) : v === null ? null : (allDay ? normalizeAllDay(v) : new Date(v)).getTime();
    if (patch.allDay !== undefined && patch.allDay !== task.allDay) out.add('allDay');
    if (patch.startAt !== undefined && norm(patch.startAt, task.startAt) !== time(task.startAt)) out.add('startAt');
    if (patch.dueAt !== undefined && norm(patch.dueAt, task.dueAt) !== time(task.dueAt)) out.add('dueAt');
    if (patch.completed !== undefined && patch.completed !== !!task.completedAt) out.add('completed');
    if (patch.assigneeIds !== undefined && !sameSet(patch.assigneeIds, task.assignees.map((a) => a.userId))) out.add('assigneeIds');
    if (patch.labelIds !== undefined && !sameSet(patch.labelIds, task.labels.map((l) => l.labelId))) out.add('labelIds');
    if (patch.checklist !== undefined) {
      const mine = task.checklist.map((c) => ({ id: c.id, text: c.text, done: c.done, position: c.position })).sort(comparePositions);
      const theirs = patch.checklist.map((c) => ({ id: c.id, text: c.text.trim(), done: c.done, position: c.position })).sort(comparePositions);
      if (!jsonEquals(mine, theirs)) out.add('checklist');
    }
    return out;
  }

  /** The rules of who may change what (see OWN_FIELDS). */
  private gate(ctx: TaskContext, userId: string, changed: ReadonlySet<Field>): void {
    if (changed.has('assigneeIds') && !hasPermission(ctx.board.perms, Permission.ASSIGN_TASKS)) throw forbidden();
    const rest = [...changed].filter((f) => f !== 'assigneeIds');
    if (rest.length && !ctx.editAny) {
      if (!isOwnTask(ctx.task, userId) || rest.some((f) => !OWN_FIELDS.has(f))) throw forbidden();
    }
  }

  private checkDescription(input: unknown) {
    const res = validateTaskDescription(input);
    if (!res.ok) throw invalid(`invalid_description:${res.reason}`);
    return res.doc;
  }

  private json(doc: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
    return doc ? (doc as Prisma.InputJsonValue) : Prisma.DbNull;
  }

  private assertPosition(position: string): void {
    try {
      positionBetween(position, null);
    } catch {
      throw invalid('bad_position');
    }
  }

  private dates(start: string | null | undefined, due: string | null | undefined, allDay: boolean): { startAt: Date | null; dueAt: Date | null } {
    const parse = (v: string | null | undefined) => (v ? (allDay ? normalizeAllDay(v) : new Date(v)) : null);
    const startAt = parse(start);
    const dueAt = parse(due);
    if ((startAt && Number.isNaN(startAt.getTime())) || (dueAt && Number.isNaN(dueAt.getTime()))) throw invalid('bad_date');
    if (startAt && dueAt && dueAt < startAt) throw invalid('due_before_start');
    return { startAt, dueAt };
  }

  private async assertWip(tx: Tx, column: BoardColumn, exceptTaskId?: string): Promise<void> {
    if (!column.wipLimit) return;
    const n = await tx.task.count({ where: { columnId: column.id, deletedAt: null, parentTaskId: null, ...(exceptTaskId && { id: { not: exceptTaskId } }) } });
    if (n >= column.wipLimit) throw wipLimit();
  }

  /** Assignees must be able to see the board: assigning anybody else is refused with a clear error. */
  private async checkAssignees(tx: Tx, access: Pick<BoardAccess, 'board'>, ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    const viewers = await this.perms.boardViewers(access.board, ids, tx);
    if (ids.some((id) => !viewers.has(id))) throw invalid('assignee_cannot_view');
  }

  private async assertChecklistIds(tx: Tx, taskId: string, items: readonly { id: string }[]): Promise<void> {
    if (!items.length) return;
    if (new Set(items.map((i) => i.id)).size !== items.length) throw invalid('duplicate_checklist_item');
    const taken = await tx.checklistItem.findMany({ where: { id: { in: items.map((i) => i.id) }, taskId: { not: taskId } }, select: { id: true } });
    if (taken.length) throw idTaken();
  }

  // ---------------------------------------------------------------- one at a time (the same rules as an update with the whole list)

  private async fresh(userId: string, id: string): Promise<TaskRow> {
    return this.access.live(await this.access.forUser(userId, id)).task;
  }

  async addAssignee(userId: string, id: string, who: string): Promise<TaskDto> {
    const task = await this.fresh(userId, id);
    return this.update(userId, id, { assigneeIds: [...task.assignees.map((a) => a.userId), who] });
  }

  async removeAssignee(userId: string, id: string, who: string): Promise<TaskDto> {
    const task = await this.fresh(userId, id);
    return this.update(userId, id, { assigneeIds: task.assignees.map((a) => a.userId).filter((u) => u !== who) });
  }

  async addLabel(userId: string, id: string, labelId: string): Promise<TaskDto> {
    const task = await this.fresh(userId, id);
    return this.update(userId, id, { labelIds: [...task.labels.map((l) => l.labelId), labelId] });
  }

  async removeLabel(userId: string, id: string, labelId: string): Promise<TaskDto> {
    const task = await this.fresh(userId, id);
    return this.update(userId, id, { labelIds: task.labels.map((l) => l.labelId).filter((l) => l !== labelId) });
  }

  private list(task: TaskRow) {
    return task.checklist.map((c) => ({ id: c.id, text: c.text, done: c.done, position: c.position }));
  }

  async checklistAdd(userId: string, id: string, item: { id: string; text: string; position: string; done?: boolean }): Promise<TaskDto> {
    const task = await this.fresh(userId, id);
    if (task.checklist.some((c) => c.id === item.id)) return toTaskDto(task);
    return this.update(userId, id, { checklist: [...this.list(task), { id: item.id, text: item.text, position: item.position, done: item.done ?? false }] });
  }

  async checklistEdit(userId: string, id: string, itemId: string, patch: { text?: string; done?: boolean; position?: string }): Promise<TaskDto> {
    const task = await this.fresh(userId, id);
    if (!task.checklist.some((c) => c.id === itemId)) throw notFound();
    return this.update(userId, id, { checklist: this.list(task).map((c) => (c.id === itemId ? { ...c, ...patch } : c)) });
  }

  async checklistRemove(userId: string, id: string, itemId: string): Promise<TaskDto> {
    const task = await this.fresh(userId, id);
    return this.update(userId, id, { checklist: this.list(task).filter((c) => c.id !== itemId) });
  }

  // ---------------------------------------------------------------- the parts of an update

  private async setCompleted(tx: Tx, task: TaskRow, completed: boolean, data: Prisma.TaskUncheckedUpdateInput, log: [ActivityKind, Record<string, unknown>][], seq: bigint): Promise<void> {
    data.completedAt = completed ? new Date() : null;
    log.push([completed ? 'completed' : 'reopened', {}]);
    if (task.parentTaskId) return; // a subtask has no column of its own to be done in
    const columns = (await tx.boardColumn.findMany({ where: { boardId: task.boardId, deletedAt: null } })).sort(comparePositions);
    const current = columns.find((c) => c.id === task.columnId);
    let target: BoardColumn | undefined;
    if (completed && current?.kind !== 'done') target = columns.find((c) => c.kind === 'done');
    if (!completed && current?.kind === 'done') target = columns.find((c) => c.kind === 'todo') ?? columns.find((c) => c.kind !== 'done');
    if (!target) return;
    if (target.wipLimit) {
      const n = await tx.task.count({ where: { columnId: target.id, deletedAt: null, parentTaskId: null, id: { not: task.id } } });
      // Finishing a task never fails because the done column is full: it just stays where it is, ticked.
      if (n >= target.wipLimit) {
        if (completed) return;
        throw wipLimit();
      }
    }
    const last = (await tx.task.findMany({ where: { columnId: target.id, deletedAt: null, parentTaskId: null, id: { not: task.id } }, select: { id: true, position: true } })).sort(comparePositions).at(-1)?.position ?? null;
    data.columnId = target.id;
    data.position = await this.settlePosition(tx, { boardId: task.boardId, columnId: target.id, parentTaskId: null }, task.id, positionBetween(last, null), seq);
    log.push(['moved', { from: current?.name ?? null, to: target.name }]);
  }

  private async setAssignees(tx: Tx, task: TaskRow, board: BoardAccess, ids: readonly string[], actorId: string, log: [ActivityKind, Record<string, unknown>][]): Promise<void> {
    const want = [...new Set(ids)];
    const have = task.assignees.map((a) => a.userId);
    const added = want.filter((i) => !have.includes(i));
    const removed = have.filter((i) => !want.includes(i));
    await this.checkAssignees(tx, board, added);
    if (added.length) await tx.taskAssignee.createMany({ data: added.map((userId) => ({ taskId: task.id, userId, assignedBy: actorId })) });
    if (removed.length) await tx.taskAssignee.deleteMany({ where: { taskId: task.id, userId: { in: removed } } });
    const names = await this.namesOf([...added, ...removed]);
    for (const u of added) log.push(['assigned', { userId: u, name: names.get(u) ?? null }]);
    for (const u of removed) log.push(['unassigned', { userId: u, name: names.get(u) ?? null }]);
    if (added.length) await this.notifyAssigned(tx, task, added, actorId);
  }

  private async setLabels(tx: Tx, task: TaskRow, ids: readonly string[], log: [ActivityKind, Record<string, unknown>][]): Promise<void> {
    const want = [...new Set(ids)];
    const have = task.labels.map((l) => l.labelId);
    const added = want.filter((i) => !have.includes(i));
    const removed = have.filter((i) => !want.includes(i));
    await this.labels.assertUsable(tx, task.spaceId, added);
    if (added.length) await tx.taskLabel.createMany({ data: added.map((labelId) => ({ taskId: task.id, labelId })) });
    if (removed.length) await tx.taskLabel.deleteMany({ where: { taskId: task.id, labelId: { in: removed } } });
    const names = new Map((await tx.label.findMany({ where: { id: { in: [...added, ...removed] } }, select: { id: true, name: true } })).map((l) => [l.id, l.name]));
    for (const l of added) log.push(['labeled', { labelId: l, name: names.get(l) ?? null }]);
    for (const l of removed) log.push(['unlabeled', { labelId: l, name: names.get(l) ?? null }]);
  }

  private async setChecklist(tx: Tx, task: TaskRow, items: readonly { id: string; text: string; done: boolean; position: string }[], log: [ActivityKind, Record<string, unknown>][]): Promise<void> {
    await this.assertChecklistIds(tx, task.id, items);
    const have = new Map(task.checklist.map((c) => [c.id, c]));
    const want = new Map(items.map((c) => [c.id, c]));
    for (const c of task.checklist) if (!want.has(c.id)) {
      await tx.checklistItem.delete({ where: { id: c.id } });
      log.push(['checklist_removed', { text: c.text }]);
    }
    for (const c of items) {
      const old = have.get(c.id);
      if (!old) {
        await tx.checklistItem.create({ data: { id: c.id, taskId: task.id, text: c.text.trim(), done: c.done, position: c.position } });
        log.push(['checklist_added', { text: c.text.trim() }]);
      } else if (old.text !== c.text.trim() || old.done !== c.done || old.position !== c.position) {
        await tx.checklistItem.update({ where: { id: c.id }, data: { text: c.text.trim(), done: c.done, position: c.position } });
        if (old.done !== c.done) log.push(['checklist_done', { text: c.text.trim(), done: c.done }]);
      }
    }
  }

  private async notifyAssigned(tx: Tx, task: TaskRow, ids: readonly string[], actorId: string): Promise<void> {
    await this.notifications.onTask(tx, {
      kind: 'task_assigned',
      recipients: ids,
      actorId,
      spaceId: task.spaceId,
      boardId: task.boardId,
      taskId: task.id,
      title: task.title,
      summary: task.title,
    });
  }

  // ---------------------------------------------------------------- moving

  /**
   * Moves a task to a column (and a place in it), on the same board or another. A column that is full refuses (`409 wip_limit`).
   * Landing in a "done" column completes the task, leaving one reopens it. Subtasks go with their parent.
   */
  async move(userId: string, id: string, input: MoveTaskInput): Promise<TaskDto> {
    const ctx = this.access.live(await this.access.forUser(userId, id));
    this.access.writable(ctx);
    if (ctx.task.parentTaskId) throw invalid('subtask_has_no_column');
    if (!ctx.editAny && !ctx.own) throw forbidden();
    const crossBoard = !!input.boardId && input.boardId !== ctx.task.boardId;
    const target = crossBoard ? await this.perms.requireBoard(userId, input.boardId!, Permission.CREATE_TASKS) : ctx.board;
    if (crossBoard && (target.board.deletedAt || target.board.archivedAt)) throw notFound();
    this.assertPosition(input.position);
    const from = ctx.task.spaceId;
    const to = target.board.spaceId;

    return this.prisma.fresh(async (tx) => {
      const seqs = new Map<string, bigint>();
      for (const space of [...new Set([from, to])].sort()) seqs.set(space, await this.seq.next(tx, space));
      const seq = seqs.get(to)!;
      const task = await tx.task.findFirst({ where: { id, deletedAt: null }, include: TASK_INCLUDE });
      if (!task) throw notFound();
      // Offline merge: a move is one field (column and place in it); if somebody else moved the task meanwhile, theirs stays.
      const guard = guardUpdate('task', task, new Set(['columnId', 'position', ...(crossBoard ? ['boardId'] : [])]), input, toTaskDto(task) as unknown as Record<string, unknown>, 'move');
      const column = await tx.boardColumn.findFirst({ where: { id: input.columnId, boardId: target.board.id, deletedAt: null } });
      if (!column) throw notFound();
      const old = await tx.boardColumn.findUnique({ where: { id: task.columnId } });
      if (column.id !== task.columnId) await this.assertWip(tx, column, task.id);

      const subs = await tx.task.findMany({ where: { parentTaskId: id }, include: TASK_INCLUDE });
      const log: [ActivityKind, Record<string, unknown>][] = [];
      const data: Prisma.TaskUncheckedUpdateInput = { columnId: column.id, seq, fieldSeq: guard.next(seq) };
      if (crossBoard) {
        data.boardId = target.board.id;
        if (from !== to) data.spaceId = to;
        const viewers = await this.perms.boardViewers(target.board, [...task.assignees, ...subs.flatMap((s) => s.assignees)].map((a) => a.userId), tx);
        const usable = new Set((await this.labels.usable(to, tx)).map((l) => l.id));
        for (const t of [task, ...subs]) {
          const dropAssignees = t.assignees.filter((a) => !viewers.has(a.userId)).map((a) => a.userId);
          if (dropAssignees.length) await tx.taskAssignee.deleteMany({ where: { taskId: t.id, userId: { in: dropAssignees } } });
          const dropLabels = t.labels.filter((l) => !usable.has(l.labelId)).map((l) => l.labelId);
          if (dropLabels.length) await tx.taskLabel.deleteMany({ where: { taskId: t.id, labelId: { in: dropLabels } } });
        }
        if (from !== to) {
          await this.moveBytes(tx, [task, ...subs], from, to);
          // The space it leaves is told, so devices that hold it there drop it.
          await tx.taskMove.createMany({ data: [task, ...subs].map((t) => ({ id: newId(), spaceId: from, taskId: t.id, seq: seqs.get(from)! })) });
        }
        if (subs.length)
          await tx.task.updateMany({ where: { parentTaskId: id }, data: { boardId: target.board.id, spaceId: to, columnId: column.id, seq } });
      } else if (subs.length && column.id !== task.columnId) {
        await tx.task.updateMany({ where: { parentTaskId: id }, data: { columnId: column.id, seq } });
      }
      data.position = await this.settlePosition(tx, { boardId: target.board.id, columnId: column.id, parentTaskId: null }, id, input.position, seq);

      if (column.kind === 'done' && !task.completedAt) {
        data.completedAt = new Date();
        log.push(['completed', {}]);
      } else if (column.kind !== 'done' && old?.kind === 'done' && task.completedAt) {
        data.completedAt = null;
        log.push(['reopened', {}]);
      }
      // Landing in (or leaving) a done column also changes whether the task is completed.
      if (data.completedAt !== undefined) data.fieldSeq = { ...(data.fieldSeq as Record<string, number>), completed: Number(seq) };
      if (column.id !== task.columnId || crossBoard) log.unshift(['moved', { from: old?.name ?? null, to: column.name, board: crossBoard ? target.board.name : undefined }]);

      await tx.task.update({ where: { id }, data });
      for (const [kind, extra] of log) await this.access.log(tx, id, userId, kind, extra);
      const row = await tx.task.findUniqueOrThrow({ where: { id }, include: TASK_INCLUDE });
      this.emitTask(tx, BOARD_EVENTS.taskMoved, row, crossBoard ? task.boardId : undefined);
      return toTaskDto(row);
    });
  }

  /** Re-attributes what a task weighs (its text, its comments and its files) from one space to another, refusing when the target is full. */
  private async moveBytes(tx: Tx, tasks: readonly TaskRow[], from: string, to: string): Promise<void> {
    const ids = tasks.map((t) => t.id);
    const comments = await tx.taskComment.aggregate({ where: { taskId: { in: ids } }, _sum: { sizeBytes: true } });
    const files = await tx.taskAttachment.findMany({ where: { taskId: { in: ids } }, select: { mediaId: true, media: { select: { size: true } } } });
    const bytes = tasks.reduce((n, t) => n + t.sizeBytes, 0) + (comments._sum.sizeBytes ?? 0) + files.reduce((n, f) => n + f.media.size, 0);
    // Give back first, then charge: a move inside one team (net zero) must not be refused for lack of room.
    await this.quota.chargeSpace(tx, from, -bytes);
    await this.quota.chargeSpace(tx, to, bytes);
    if (files.length) await tx.media.updateMany({ where: { id: { in: files.map((f) => f.mediaId) }, spaceId: from }, data: { spaceId: to } });
  }

  /**
   * Decides the key a task is stored under in its list. Two tasks that ended up with the same key (two people dropping at the same
   * place) are told apart by moving the later one just after; a key that has grown too long re-keys the whole list in the same order.
   */
  private async settlePosition(tx: Tx, scope: { boardId: string; columnId: string; parentTaskId: string | null }, taskId: string, wanted: string, seq: bigint): Promise<string> {
    const siblings = await tx.task.findMany({
      where: { boardId: scope.boardId, deletedAt: null, id: { not: taskId }, ...(scope.parentTaskId ? { parentTaskId: scope.parentTaskId } : { columnId: scope.columnId, parentTaskId: null }) },
      select: { id: true, position: true },
    });
    let position = wanted;
    if (siblings.some((s) => s.position === position)) {
      const higher = siblings.map((s) => s.position).filter((p) => p > position).sort()[0] ?? null;
      position = positionBetween(position, higher);
    }
    if (position.length <= POSITION_REBALANCE_LENGTH) return position;
    const ordered = [...siblings, { id: taskId, position }].sort(comparePositions);
    const fresh = evenPositions(ordered.length);
    let mine = position;
    for (let i = 0; i < ordered.length; i++) {
      const o = ordered[i]!;
      if (o.id === taskId) mine = fresh[i]!;
      else if (o.position !== fresh[i]) await tx.task.update({ where: { id: o.id }, data: { position: fresh[i]!, seq } });
    }
    return mine;
  }

  // ---------------------------------------------------------------- deleting

  /** To the trash (with its subtasks): a tombstone that devices see and that can be restored. */
  async remove(userId: string, id: string): Promise<void> {
    const ctx = await this.access.forUser(userId, id);
    if (ctx.board.board.deletedAt || ctx.task.deletedAt) return;
    this.access.writable(ctx);
    if (!ctx.editAny && ctx.task.createdBy !== userId) throw forbidden();
    await this.prisma.fresh(async (tx) => {
      const seq = await this.seq.next(tx, ctx.task.spaceId);
      const current = await tx.task.findFirst({ where: { id, deletedAt: null }, include: TASK_INCLUDE });
      if (!current || !guardDelete(current)) return;
      const deletedAt = new Date();
      await tx.task.updateMany({ where: { OR: [{ id }, { parentTaskId: id, deletedAt: null }] }, data: { deletedAt, seq } });
      await this.access.log(tx, id, userId, 'deleted');
      if (current.parentTaskId) await tx.task.update({ where: { id: current.parentTaskId }, data: { seq } });
      const row = await tx.task.findUniqueOrThrow({ where: { id }, include: TASK_INCLUDE });
      this.emitTask(tx, BOARD_EVENTS.taskDeleted, row);
      if (current.parentTaskId) this.emitTask(tx, BOARD_EVENTS.taskUpdated, await tx.task.findUniqueOrThrow({ where: { id: current.parentTaskId }, include: TASK_INCLUDE }));
    });
  }

  /** Brings a trashed task back (with the subtasks that went with it); into its column, or the first one if that column is gone. */
  async restore(userId: string, id: string): Promise<TaskDto> {
    const ctx = await this.access.forUser(userId, id);
    if (ctx.board.board.deletedAt) throw notFound();
    this.access.writable(ctx);
    if (!ctx.editAny && ctx.task.createdBy !== userId) throw forbidden();
    return this.prisma.fresh(async (tx) => {
      const seq = await this.seq.next(tx, ctx.task.spaceId);
      const task = await tx.task.findUnique({ where: { id }, include: TASK_INCLUDE });
      if (!task) throw notFound();
      if (!task.deletedAt) return toTaskDto(task);
      const stamp = task.deletedAt;
      const columns = (await tx.boardColumn.findMany({ where: { boardId: task.boardId, deletedAt: null } })).sort(comparePositions);
      const column = columns.find((c) => c.id === task.columnId) ?? columns[0];
      if (!column) throw invalid('board_has_no_columns');
      await tx.task.update({ where: { id }, data: { deletedAt: null, columnId: column.id, seq } });
      await tx.task.updateMany({ where: { parentTaskId: id, deletedAt: stamp }, data: { deletedAt: null, columnId: column.id, seq } });
      await this.access.log(tx, id, userId, 'restored');
      const row = await tx.task.findUniqueOrThrow({ where: { id }, include: TASK_INCLUDE });
      this.emitTask(tx, BOARD_EVENTS.taskCreated, row);
      return toTaskDto(row);
    });
  }

  /** Deletes a trashed task for good (with its subtasks, comments and files) and gives its bytes back to the space. */
  async purge(userId: string, id: string): Promise<void> {
    const ctx = await this.access.forUser(userId, id);
    if (!ctx.task.deletedAt) throw invalid('not_in_trash');
    if (!ctx.editAny && ctx.task.createdBy !== userId) throw forbidden();
    await this.purgeRows(ctx.task.spaceId, [id]);
  }

  /** Hard delete of tasks (and what hangs off them) in one space: the bytes go back to the space, the files off the disk. */
  async purgeRows(spaceId: string, ids: readonly string[]): Promise<number> {
    const owners: { id: string; userId: string }[] = [];
    await this.prisma.fresh(async (tx) => {
      await this.seq.next(tx, spaceId);
      const all = await tx.task.findMany({ where: { OR: [{ id: { in: [...ids] } }, { parentTaskId: { in: [...ids] } }] }, select: { id: true, sizeBytes: true } });
      const taskIds = all.map((t) => t.id);
      if (!taskIds.length) return;
      const comments = await tx.taskComment.aggregate({ where: { taskId: { in: taskIds } }, _sum: { sizeBytes: true } });
      const files = await tx.taskAttachment.findMany({ where: { taskId: { in: taskIds } }, select: { media: { select: { id: true, userId: true, size: true } } } });
      const bytes = all.reduce((n, t) => n + t.sizeBytes, 0) + (comments._sum.sizeBytes ?? 0) + files.reduce((n, f) => n + f.media.size, 0);
      if (files.length) await tx.media.deleteMany({ where: { id: { in: files.map((f) => f.media.id) } } });
      owners.push(...files.map((f) => ({ id: f.media.id, userId: f.media.userId })));
      await tx.task.deleteMany({ where: { id: { in: taskIds } } });
      await this.quota.chargeSpace(tx, spaceId, -bytes);
    });
    await Promise.all(owners.map((o) => this.storage.remove(o.userId, o.id).catch(() => undefined)));
    return owners.length;
  }

  // ---------------------------------------------------------------- events

  /** Tells the board's room the task as it now is (and, when it left another board, that board's room that it is gone). */
  private emitTask(tx: Tx, name: (typeof BOARD_EVENTS)[keyof typeof BOARD_EVENTS], row: TaskRow, previousBoardId?: string): void {
    const dto = toTaskDto(row);
    this.events.emit(tx, name, { spaceId: row.spaceId, boardId: row.boardId, id: row.id, payload: dto });
    if (previousBoardId) this.events.emit(tx, BOARD_EVENTS.taskDeleted, { spaceId: row.spaceId, boardId: previousBoardId, id: row.id, payload: { ...dto, deletedAt: dto.deletedAt ?? new Date().toISOString() } });
  }

  /** Used by the board events of comments and files: the task as it is after a change made by another service. */
  async emitCurrent(tx: Tx, taskId: string): Promise<void> {
    const row = await tx.task.findUniqueOrThrow({ where: { id: taskId }, include: TASK_INCLUDE });
    this.emitTask(tx, BOARD_EVENTS.taskUpdated, row);
  }
}
