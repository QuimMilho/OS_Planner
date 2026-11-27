import { Injectable } from '@nestjs/common';
import { hasPermission, Permission, type ActivityKind } from '@os-planner/shared';
import { newId } from '../common/crypto.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { PermissionService, type BoardAccess } from '../spaces/permission.service.js';
import { forbidden, invalid, notFound } from '../tree/tree.error.js';
import { TASK_INCLUDE, type TaskRow } from './board-views.js';

/** A task together with what the person asking may do with it. */
export interface TaskContext {
  task: TaskRow;
  board: BoardAccess;
  /** EDIT_TASKS: may change any task. */
  editAny: boolean;
  /** Made the task or is assigned to it: may change its title, description, checklist and done state, and move it. */
  own: boolean;
}

/** Fields a person who made a task, or works on it, may change without EDIT_TASKS. */
export const OWN_FIELDS: ReadonlySet<string> = new Set(['title', 'description', 'checklist', 'completed']);

export const isOwnTask = (task: Pick<TaskRow, 'createdBy' | 'assignees'>, userId: string): boolean =>
  task.createdBy === userId || task.assignees.some((a) => a.userId === userId);

/** Finds a task for a person: 404 when the board is invisible to them, with the rights they have on this task. */
@Injectable()
export class TaskAccess {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionService,
  ) {}

  /** The task (trashed ones too: callers decide) and the person's rights. */
  async forUser(userId: string, taskId: string): Promise<TaskContext> {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, include: TASK_INCLUDE });
    if (!task) throw notFound();
    const board = await this.perms.requireBoard(userId, task.boardId); // 404 when the board is not theirs to see
    return {
      task,
      board,
      editAny: hasPermission(board.perms, Permission.EDIT_TASKS),
      own: isOwnTask(task, userId),
    };
  }

  /** The task must be there (not trashed, on a board that is not trashed). */
  live(ctx: TaskContext): TaskContext {
    if (ctx.task.deletedAt || ctx.board.board.deletedAt) throw notFound();
    return ctx;
  }

  /** Nothing on an archived board changes (it is read-only until it is un-archived). */
  writable(ctx: Pick<TaskContext, 'board'>): void {
    if (ctx.board.board.archivedAt) throw invalid('board_archived');
  }

  /** May change this task in the ways `own` allows. */
  assertCanEdit(ctx: TaskContext): void {
    if (!ctx.editAny && !ctx.own) throw forbidden();
  }

  async log(tx: Tx, taskId: string, actorId: string | null, kind: ActivityKind, data: Record<string, unknown> = {}): Promise<void> {
    await tx.taskActivity.create({ data: { id: newId(), taskId, actorId, kind, data: data as object } });
  }
}
