import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TRASH_RETENTION_DAYS } from '../media/maintenance.service.js';
import { StorageService } from '../media/storage.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QuotaService } from '../quota/quota.service.js';
import { PermissionService } from '../spaces/permission.service.js';
import { TasksService } from './tasks.service.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** A task due within this long is "due soon": its people hear once. */
export const DUE_SOON_HOURS = 24;

@Injectable()
export class BoardsMaintenance {
  private readonly log = new Logger(BoardsMaintenance.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly notifications: NotificationService,
    private readonly perms: PermissionService,
    private readonly quota: QuotaService,
    private readonly storage: StorageService,
  ) {}

  @Cron('10 * * * *')
  async hourly(): Promise<void> {
    try {
      const n = await this.notifyDue();
      if (n) this.log.log(`told people about ${n} tasks that are due soon`);
    } catch (e) {
      this.log.error(`due-soon sweep failed: ${e instanceof Error ? e.stack : e}`);
    }
  }

  @Cron('30 3 * * *')
  async nightly(): Promise<void> {
    try {
      const n = await this.purgeTrash();
      if (n) this.log.log(`removed ${n} trashed tasks and boards for good`);
    } catch (e) {
      this.log.error(`board cleanup failed: ${e instanceof Error ? e.stack : e}`);
    }
  }

  /**
   * Tells each assignee, once per due date, that an open task is due within the next day (or already overdue and not yet told).
   * Only people who can still see the board are told.
   */
  async notifyDue(now = new Date()): Promise<number> {
    const horizon = new Date(now.getTime() + DUE_SOON_HOURS * HOUR);
    let told = 0;
    for (;;) {
      const batch = await this.prisma.task.findMany({
        where: { deletedAt: null, completedAt: null, dueNotifiedAt: null, dueAt: { not: null, lte: horizon }, assignees: { some: {} }, board: { deletedAt: null, archivedAt: null } },
        include: { assignees: { select: { userId: true } }, board: true },
        take: 200,
        orderBy: { dueAt: 'asc' },
      });
      if (!batch.length) return told;
      for (const task of batch) {
        const viewers = await this.perms.boardViewers(task.board, task.assignees.map((a) => a.userId));
        await this.prisma.fresh(async (tx) => {
          await this.notifications.onTask(tx, {
            kind: 'task_due',
            recipients: [...viewers],
            actorId: null,
            spaceId: task.spaceId,
            boardId: task.boardId,
            taskId: task.id,
            title: task.title,
            summary: task.title,
          });
          await tx.task.update({ where: { id: task.id }, data: { dueNotifiedAt: now } });
        });
        told++;
      }
    }
  }

  /** Trashed tasks and boards older than the retention period go for good; the space gets its bytes back. */
  async purgeTrash(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * DAY);
    let removed = 0;
    // Boards first: a board takes its tasks, columns and the overwrites set on it with it.
    const boards = await this.prisma.board.findMany({ where: { deletedAt: { not: null, lt: cutoff } }, select: { id: true, spaceId: true } });
    for (const b of boards) {
      const tasks = await this.prisma.task.findMany({ where: { boardId: b.id }, select: { id: true } });
      if (tasks.length) await this.tasks.purgeRows(b.spaceId, tasks.map((t) => t.id));
      await this.prisma.fresh(async (tx) => {
        await tx.overwrite.deleteMany({ where: { targetKind: 'board', targetId: b.id } });
        await tx.board.delete({ where: { id: b.id } });
      });
      removed++;
    }
    for (;;) {
      const old = await this.prisma.task.findMany({ where: { deletedAt: { not: null, lt: cutoff }, parentTaskId: null }, select: { id: true, spaceId: true }, take: 200 });
      if (!old.length) return removed;
      const bySpace = new Map<string, string[]>();
      for (const t of old) (bySpace.get(t.spaceId) ?? bySpace.set(t.spaceId, []).get(t.spaceId)!).push(t.id);
      for (const [spaceId, ids] of bySpace) await this.tasks.purgeRows(spaceId, ids);
      removed += old.length;
    }
  }
}
