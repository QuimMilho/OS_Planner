import { ConflictException, Injectable } from '@nestjs/common';
import { BOARD_EVENTS, type TaskAttachmentDto, type TaskAttachmentFields } from '@os-planner/shared';
import { BOARD_LIMITS } from '@os-planner/shared/boards';
import { cleanFileName } from '../chat/attachments.service.js';
import type { Media, TaskAttachment } from '../generated/prisma/client.js';
import { MediaService, type UploadedTempFile } from '../media/media.service.js';
import { StorageService } from '../media/storage.service.js';
import { ChangeSeqService } from '../prisma/change-seq.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QuotaService } from '../quota/quota.service.js';
import { forbidden, invalid, notFound } from '../tree/tree.error.js';
import { BoardEvents } from './board-events.js';
import { TASK_INCLUDE, toTaskDto } from './board-views.js';
import { TaskAccess } from './task-access.js';

const toDto = (a: TaskAttachment, m: Media): TaskAttachmentDto => ({
  id: a.id,
  taskId: a.taskId,
  mediaId: a.mediaId,
  name: a.name,
  size: m.size,
  mime: m.mime,
  kind: m.kind === 'video' ? 'video' : 'image',
  width: m.width,
  height: m.height,
  createdAt: a.createdAt.toISOString(),
});

/**
 * Pictures and videos on a task, through the same pipeline as every other upload: the bytes are checked by content, stripped of
 * EXIF, charged to the space the board lives in (and its team) and refused with `413 quota_exceeded` when they do not fit.
 * Whoever may edit the task attaches; the uploader or whoever may edit any task removes (which gives the bytes back).
 */
@Injectable()
export class TaskAttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seq: ChangeSeqService,
    private readonly media: MediaService,
    private readonly storage: StorageService,
    private readonly quota: QuotaService,
    private readonly events: BoardEvents,
    private readonly access: TaskAccess,
  ) {}

  async upload(userId: string, taskId: string, file: UploadedTempFile, fields: TaskAttachmentFields): Promise<TaskAttachmentDto> {
    try {
      const ctx = this.access.live(await this.access.forUser(userId, taskId));
      this.access.writable(ctx);
      this.access.assertCanEdit(ctx);
      const spaceId = ctx.task.spaceId;
      const name = cleanFileName(fields.name ?? file.originalname);
      const existing = await this.prisma.taskAttachment.findUnique({ where: { id: fields.id }, include: { media: true } });
      if (existing) {
        if (existing.taskId !== taskId) throw new ConflictException('id_taken');
        return toDto(existing, existing.media);
      }
      if ((await this.prisma.taskAttachment.count({ where: { taskId } })) >= BOARD_LIMITS.attachmentsPerTask) throw invalid('too_many_attachments');

      await this.media.store(userId, spaceId, file, fields, async (tx, created) => {
        const seq = await this.seq.next(tx, spaceId);
        await tx.taskAttachment.create({ data: { id: created.id, taskId, mediaId: created.id, uploadedBy: userId, name } });
        await tx.task.update({ where: { id: taskId }, data: { attachmentCount: { increment: 1 }, seq } });
        await this.access.log(tx, taskId, userId, 'attachment_added', { id: created.id, name });
        this.events.emit(tx, BOARD_EVENTS.taskUpdated, {
          spaceId,
          boardId: ctx.task.boardId,
          id: taskId,
          payload: toTaskDto(await tx.task.findUniqueOrThrow({ where: { id: taskId }, include: TASK_INCLUDE })),
        });
      });
      const row = await this.prisma.taskAttachment.findUnique({ where: { id: fields.id }, include: { media: true } });
      if (!row || row.taskId !== taskId) throw new ConflictException('id_taken');
      return toDto(row, row.media);
    } finally {
      await this.storage.discard(file.path);
    }
  }

  async remove(userId: string, taskId: string, attachmentId: string): Promise<void> {
    const attachment = await this.prisma.taskAttachment.findUnique({ where: { id: attachmentId }, include: { media: true } });
    if (!attachment || attachment.taskId !== taskId) {
      await this.access.forUser(userId, taskId); // 404 for somebody who cannot see the task, nothing to do for somebody who can
      return;
    }
    const ctx = this.access.live(await this.access.forUser(userId, taskId));
    this.access.writable(ctx);
    if (attachment.uploadedBy !== userId && !ctx.editAny) throw forbidden();
    await this.prisma.fresh(async (tx) => {
      const seq = await this.seq.next(tx, ctx.task.spaceId);
      const current = await tx.taskAttachment.findUnique({ where: { id: attachmentId } });
      if (!current) return;
      await tx.media.delete({ where: { id: attachment.mediaId } }); // the attachment row goes with it
      await this.quota.chargeSpace(tx, attachment.media.spaceId, -attachment.media.size);
      await tx.task.update({ where: { id: taskId }, data: { attachmentCount: { decrement: 1 }, seq } });
      await this.access.log(tx, taskId, userId, 'attachment_removed', { name: attachment.name });
      this.events.emit(tx, BOARD_EVENTS.taskUpdated, {
        spaceId: ctx.task.spaceId,
        boardId: ctx.task.boardId,
        id: taskId,
        payload: toTaskDto(await tx.task.findUniqueOrThrow({ where: { id: taskId }, include: TASK_INCLUDE })),
      });
    });
    await this.storage.remove(attachment.media.userId, attachment.media.id).catch(() => undefined);
  }
}

export { notFound };
