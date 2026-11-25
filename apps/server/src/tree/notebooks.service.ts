import { Injectable } from '@nestjs/common';
import { positionBetween, type CreateNotebookInput, type NotebookDto, type UpdateNotebookInput } from '@notes/shared';
import { newId } from '../common/crypto.js';
import { ChangeSeqService } from '../prisma/change-seq.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { idTaken, notFound } from './tree.error.js';
import { PAGE_META_SELECT, toCategoryDto, toNotebookDto, toPageMetaDto } from './mappers.js';

export const DEFAULT_CATEGORY_NAME = 'General';

@Injectable()
export class NotebooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seq: ChangeSeqService,
  ) {}

  async list(userId: string): Promise<NotebookDto[]> {
    const rows = await this.prisma.notebook.findMany({ where: { userId, deletedAt: null } });
    // Sorted here, not in SQL: position keys are case-sensitive but the collation is not.
    return rows.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0)).map(toNotebookDto);
  }

  /** One notebook with its live categories and page metadata, each level in position order. */
  async tree(userId: string, id: string) {
    const notebook = await this.prisma.notebook.findFirst({ where: { id, userId, deletedAt: null } });
    if (!notebook) throw notFound();
    const [categories, pages] = await Promise.all([
      this.prisma.category.findMany({ where: { notebookId: id, userId, deletedAt: null } }),
      this.prisma.page.findMany({ where: { notebookId: id, userId, deletedAt: null }, select: PAGE_META_SELECT }),
    ]);
    const byPosition = <T extends { position: string }>(a: T, b: T) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0);
    return {
      notebook: toNotebookDto(notebook),
      categories: categories.sort(byPosition).map(toCategoryDto),
      pages: pages.sort(byPosition).map(toPageMetaDto),
    };
  }

  /**
   * Idempotent: repeating a create with the same id returns the existing row.
   * `withDefaultCategory` is for REST callers; sync clients send an explicit category.create so
   * the whole thing works offline with client-chosen ids.
   */
  create(userId: string, input: CreateNotebookInput, withDefaultCategory = false): Promise<NotebookDto> {
    return this.prisma.$transaction(async (tx) => {
      const seq = await this.seq.next(tx, userId); // also takes this user's write lock
      const existing = await tx.notebook.findUnique({ where: { id: input.id } });
      if (existing) {
        if (existing.userId !== userId) throw idTaken();
        return toNotebookDto(existing);
      }
      const row = await tx.notebook.create({
        data: {
          id: input.id,
          userId,
          name: input.name,
          icon: input.icon ?? null,
          color: input.color ?? null,
          position: input.position,
          seq,
        },
      });
      if (withDefaultCategory) {
        await tx.category.create({
          data: {
            id: newId(),
            userId,
            notebookId: row.id,
            name: DEFAULT_CATEGORY_NAME,
            position: positionBetween(null, null),
            seq,
          },
        });
      }
      return toNotebookDto(row);
    });
  }

  update(userId: string, id: string, patch: UpdateNotebookInput): Promise<NotebookDto> {
    return this.prisma.$transaction(async (tx) => {
      const seq = await this.seq.next(tx, userId);
      const current = await tx.notebook.findFirst({ where: { id, userId, deletedAt: null } });
      if (!current) throw notFound();
      const row = await tx.notebook.update({
        where: { id },
        data: {
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.icon !== undefined && { icon: patch.icon }),
          ...(patch.color !== undefined && { color: patch.color }),
          ...(patch.position !== undefined && { position: patch.position }),
          seq,
        },
      });
      return toNotebookDto(row);
    });
  }

  /** Moves the notebook and everything in it to the trash under one timestamp (so restore can undo exactly that). */
  remove(userId: string, id: string): Promise<void> {
    return this.prisma.$transaction(async (tx) => {
      const seq = await this.seq.next(tx, userId);
      const nb = await tx.notebook.findFirst({ where: { id, userId } });
      if (!nb || nb.deletedAt) return; // already gone: deleting twice is fine
      const deletedAt = new Date();
      await tx.notebook.update({ where: { id }, data: { deletedAt, seq } });
      await tx.category.updateMany({ where: { notebookId: id, userId, deletedAt: null }, data: { deletedAt, seq } });
      await tx.page.updateMany({ where: { notebookId: id, userId, deletedAt: null }, data: { deletedAt, seq } });
    });
  }

  /** Restores the notebook plus whatever was deleted together with it (items trashed earlier stay trashed). */
  restore(userId: string, id: string): Promise<NotebookDto> {
    return this.prisma.$transaction(async (tx) => {
      const seq = await this.seq.next(tx, userId);
      const nb = await tx.notebook.findFirst({ where: { id, userId } });
      if (!nb) throw notFound();
      if (!nb.deletedAt) return toNotebookDto(nb);
      const stamp = nb.deletedAt;
      const row = await tx.notebook.update({ where: { id }, data: { deletedAt: null, seq } });
      await tx.category.updateMany({ where: { notebookId: id, userId, deletedAt: stamp }, data: { deletedAt: null, seq } });
      await tx.page.updateMany({ where: { notebookId: id, userId, deletedAt: stamp }, data: { deletedAt: null, seq } });
      return toNotebookDto(row);
    });
  }
}
