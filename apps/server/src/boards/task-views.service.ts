import { Injectable } from '@nestjs/common';
import { type BoardPermissionsDto, type MyTaskDto, type TaskQuery } from '@os-planner/shared';
import { compareByDue, dueState } from '@os-planner/shared/boards';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PermissionService } from '../spaces/permission.service.js';
import { TASK_INCLUDE, toTaskDto } from './board-views.js';

/** The lists across boards: "My tasks", and every task of a space. Only what the person can see at the moment they ask. */
@Injectable()
export class TaskViewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionService,
  ) {}

  /** What the person may do on each board and in each space they can see boards in (the web keeps this offline). */
  permissions(userId: string): Promise<BoardPermissionsDto> {
    return this.perms.boardPermissions(userId);
  }

  /** The caller's tasks (`assigned=me`, the default here) in every space whose boards they can see, soonest due first. */
  async mine(userId: string, q: TaskQuery): Promise<MyTaskDto[]> {
    return this.query(userId, { ...q, assigned: q.assigned ?? 'me' }, undefined);
  }

  /** The tasks of one space (404 when the person cannot see its boards). */
  async ofSpace(userId: string, spaceId: string, q: TaskQuery): Promise<MyTaskDto[]> {
    await this.perms.requireBoardSpace(userId, spaceId);
    return this.query(userId, q, spaceId);
  }

  private async query(userId: string, q: TaskQuery, only: string | undefined): Promise<MyTaskDto[]> {
    const spaces = [...(await this.perms.boardSpaces(userId)).keys()].filter((id) => (only ? id === only : q.spaceId ? id === q.spaceId : true));
    if (!spaces.length) return [];
    // Boards that an overwrite hides from the person (their tasks are not theirs to list, even when assigned).
    const hidden: string[] = [];
    for (const id of spaces) hidden.push(...(await this.perms.hiddenBoards(userId, id)));

    const where: Prisma.TaskWhereInput = {
      spaceId: { in: spaces },
      deletedAt: null,
      board: { deletedAt: null, ...(hidden.length ? { id: { notIn: hidden } } : {}) },
      ...(q.assigned === 'me' ? { assignees: { some: { userId } } } : {}),
      ...(q.status === 'open' ? { completedAt: null } : q.status === 'done' ? { completedAt: { not: null } } : {}),
      ...(q.boardId ? { boardId: q.boardId } : {}),
      ...(q.labelId ? { labels: { some: { labelId: q.labelId } } } : {}),
      ...(q.priority ? { priority: q.priority } : {}),
      ...(q.q ? { title: { contains: q.q } } : {}),
    };
    const rows = await this.prisma.task.findMany({ where, include: { ...TASK_INCLUDE, board: { select: { name: true } } }, take: 5000 });
    const now = Date.now();
    return rows
      .map((r) => ({ task: toTaskDto(r), boardName: r.board.name }))
      .filter((r) => !q.due || dueState(r.task, now, q.tz) === q.due)
      .sort((a, b) => compareByDue(a.task, b.task))
      .slice(0, q.limit);
  }
}
