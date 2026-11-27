import { Injectable } from '@nestjs/common';
import { BOARD_EVENTS, hasPermission, Permission, type CreateCommentInput, type TaskCommentDto, type UpdateCommentInput } from '@os-planner/shared';
import { chatMarkdownToText, extractMentions } from '@os-planner/shared/chat';
import type { TaskComment } from '../generated/prisma/client.js';
import { Prisma } from '../generated/prisma/client.js';
import { NotificationService } from '../notifications/notification.service.js';
import { ChangeSeqService } from '../prisma/change-seq.service.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { QuotaService } from '../quota/quota.service.js';
import { PermissionService } from '../spaces/permission.service.js';
import { forbidden, idTaken, notFound } from '../tree/tree.error.js';
import { BoardEvents } from './board-events.js';
import { TASK_INCLUDE, toTaskDto } from './board-views.js';
import { TaskAccess } from './task-access.js';

type Mentions = { users: string[]; roles: string[]; everyone: boolean; here: boolean };

/**
 * Comments on a task. Mentions work like chat's: tokens in the text, and the server keeps the ones that hold (here: a person who
 * can see the board; roles, `@everyone` and `@here` are plain text on a task). Whoever can see the board may read; writing needs
 * CREATE_TASKS; only the author edits; the author, EDIT_TASKS or MANAGE_BOARDS delete.
 */
@Injectable()
export class TaskCommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seq: ChangeSeqService,
    private readonly perms: PermissionService,
    private readonly quota: QuotaService,
    private readonly events: BoardEvents,
    private readonly access: TaskAccess,
    private readonly notifications: NotificationService,
  ) {}

  private async acceptMentions(board: { id: string; spaceId: string }, authorId: string, content: string): Promise<Mentions> {
    const claimed = extractMentions(content).users.filter((id) => id !== authorId);
    const viewers = claimed.length ? await this.perms.boardViewers(board, claimed) : new Set<string>();
    return { users: claimed.filter((id) => viewers.has(id)), roles: [], everyone: false, here: false };
  }

  private async toDto(row: TaskComment, name?: string | null): Promise<TaskCommentDto> {
    const author = row.authorId ? (name ?? (await this.prisma.user.findUnique({ where: { id: row.authorId }, select: { displayName: true } }))?.displayName ?? null) : null;
    return {
      id: row.id,
      taskId: row.taskId,
      authorId: row.authorId,
      authorName: author,
      content: row.content,
      mentions: (row.mentions as Mentions | null) ?? { users: [], roles: [], everyone: false, here: false },
      editedAt: row.editedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async create(userId: string, taskId: string, input: CreateCommentInput): Promise<TaskCommentDto> {
    const ctx = this.access.live(await this.access.forUser(userId, taskId));
    this.access.writable(ctx);
    if (!hasPermission(ctx.board.perms, Permission.CREATE_TASKS)) throw forbidden();
    const content = input.content.trim();
    const mentions = await this.acceptMentions(ctx.board.board, userId, content);
    const spaceId = ctx.task.spaceId;

    const row = await this.prisma.fresh(async (tx) => {
      const seq = await this.seq.next(tx, spaceId);
      const existing = await tx.taskComment.findUnique({ where: { id: input.id } });
      if (existing) {
        if (existing.taskId !== taskId) throw idTaken();
        return existing;
      }
      const task = await tx.task.findFirst({ where: { id: taskId, deletedAt: null }, include: TASK_INCLUDE });
      if (!task) throw notFound();
      const bytes = Buffer.byteLength(content, 'utf8');
      await this.quota.chargeSpace(tx, spaceId, bytes);
      const created = await tx.taskComment.create({
        data: { id: input.id, taskId, authorId: userId, content, mentions: mentions as unknown as Prisma.InputJsonValue, sizeBytes: bytes },
      });
      await tx.task.update({ where: { id: taskId }, data: { commentCount: { increment: 1 }, seq } });
      await this.access.log(tx, taskId, userId, 'comment', { id: created.id });

      const text = chatMarkdownToText(content);
      const mentioned = new Set(mentions.users);
      await this.notifications.onTask(tx, { kind: 'mention_user', recipients: mentions.users, actorId: userId, spaceId, boardId: task.boardId, taskId, title: task.title, summary: text });
      const involved = [...task.assignees.map((a) => a.userId), ...(task.createdBy ? [task.createdBy] : [])].filter((id) => !mentioned.has(id));
      if (involved.length) {
        const viewers = await this.perms.boardViewers(ctx.board.board, involved, tx);
        await this.notifications.onTask(tx, { kind: 'task_comment', recipients: involved.filter((id) => viewers.has(id)), actorId: userId, spaceId, boardId: task.boardId, taskId, title: task.title, summary: text });
      }

      const dto = await this.toDto(created);
      this.events.emit(tx, BOARD_EVENTS.commentCreated, { spaceId, boardId: task.boardId, id: created.id, payload: dto });
      this.events.emit(tx, BOARD_EVENTS.taskUpdated, {
        spaceId,
        boardId: task.boardId,
        id: taskId,
        payload: toTaskDto(await tx.task.findUniqueOrThrow({ where: { id: taskId }, include: TASK_INCLUDE })),
      });
      return created;
    });
    return this.toDto(row);
  }

  async update(userId: string, commentId: string, input: UpdateCommentInput): Promise<TaskCommentDto> {
    const comment = await this.prisma.taskComment.findUnique({ where: { id: commentId } });
    if (!comment) throw notFound();
    const ctx = this.access.live(await this.access.forUser(userId, comment.taskId));
    this.access.writable(ctx);
    if (comment.authorId !== userId) throw forbidden();
    const content = input.content.trim();
    const mentions = await this.acceptMentions(ctx.board.board, userId, content);
    const spaceId = ctx.task.spaceId;
    return this.prisma.fresh(async (tx) => {
      const seq = await this.seq.next(tx, spaceId);
      const current = await tx.taskComment.findUnique({ where: { id: commentId } });
      if (!current) throw notFound();
      if (current.content === content) return this.toDto(current);
      const bytes = Buffer.byteLength(content, 'utf8');
      await this.quota.chargeSpace(tx, spaceId, bytes - current.sizeBytes);
      const row = await tx.taskComment.update({ where: { id: commentId }, data: { content, mentions: mentions as unknown as Prisma.InputJsonValue, sizeBytes: bytes, editedAt: new Date() } });
      await tx.task.update({ where: { id: comment.taskId }, data: { seq } });
      // Somebody newly mentioned by the edit is told; people already told are not told again.
      const before = new Set(((current.mentions as Mentions | null)?.users) ?? []);
      const fresh = mentions.users.filter((id) => !before.has(id));
      if (fresh.length) {
        const task = await tx.task.findUniqueOrThrow({ where: { id: comment.taskId } });
        await this.notifications.onTask(tx, { kind: 'mention_user', recipients: fresh, actorId: userId, spaceId, boardId: task.boardId, taskId: task.id, title: task.title, summary: chatMarkdownToText(content) });
      }
      const dto = await this.toDto(row);
      this.events.emit(tx, BOARD_EVENTS.commentCreated, { spaceId, boardId: ctx.task.boardId, id: row.id, payload: dto });
      return dto;
    });
  }

  /** Removes the comment for good and gives its bytes back. */
  async remove(userId: string, commentId: string): Promise<void> {
    const comment = await this.prisma.taskComment.findUnique({ where: { id: commentId } });
    if (!comment) throw notFound();
    const ctx = this.access.live(await this.access.forUser(userId, comment.taskId));
    this.access.writable(ctx);
    const mayModerate = ctx.editAny || hasPermission(ctx.board.perms, Permission.MANAGE_BOARDS);
    if (comment.authorId !== userId && !mayModerate) throw forbidden();
    await this.prisma.fresh(async (tx) => {
      const seq = await this.seq.next(tx, ctx.task.spaceId);
      const current = await tx.taskComment.findUnique({ where: { id: commentId } });
      if (!current) return;
      await tx.taskComment.delete({ where: { id: commentId } });
      await this.quota.chargeSpace(tx, ctx.task.spaceId, -current.sizeBytes);
      await tx.task.update({ where: { id: comment.taskId }, data: { commentCount: { decrement: 1 }, seq } });
      this.events.emit(tx, BOARD_EVENTS.taskUpdated, {
        spaceId: ctx.task.spaceId,
        boardId: ctx.task.boardId,
        id: comment.taskId,
        payload: toTaskDto(await tx.task.findUniqueOrThrow({ where: { id: comment.taskId }, include: TASK_INCLUDE })),
      });
    });
  }
}

/** Kept for callers that only need the type of the transaction in this module. */
export type { Tx };
