import { Injectable } from '@nestjs/common';
import { Permission, positionBetween, type CreateNotebookInput, type NotebookDto, type UpdateNotebookInput } from '@os-planner/shared';
import { newId } from '../common/crypto.js';
import { ChangeSeqService } from '../prisma/change-seq.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PermissionService } from '../spaces/permission.service.js';
import { SpacesService } from '../spaces/spaces.service.js';
import { idTaken, notFound } from './tree.error.js';
import { PAGE_META_SELECT, toCategoryDto, toNotebookDto, toPageMetaDto } from './mappers.js';

export const DEFAULT_CATEGORY_NAME = 'General';

const byPosition = <T extends { position: string }>(a: T, b: T) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0);

@Injectable()
export class NotebooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seq: ChangeSeqService,
    private readonly perms: PermissionService,
    private readonly spaces: SpacesService,
  ) {}

  /** The notebooks of one space: the person's own unless another one (a team or project they can see) is named. */
  async list(userId: string, spaceId?: string): Promise<NotebookDto[]> {
    const space = spaceId ?? (await this.spaces.personalSpaceId(userId));
    await this.perms.requireSpace(userId, space);
    const rows = await this.prisma.notebook.findMany({ where: { spaceId: space, deletedAt: null } });
    // Sorted here, not in SQL: position keys are case-sensitive but the collation is not.
    return rows.sort(byPosition).map(toNotebookDto);
  }

  /** One notebook with its live categories and page metadata, each level in position order. */
  async tree(userId: string, id: string) {
    const notebook = await this.prisma.notebook.findFirst({ where: { id, deletedAt: null } });
    if (!notebook) throw notFound();
    await this.perms.requireSpace(userId, notebook.spaceId);
    const [categories, pages] = await Promise.all([
      this.prisma.category.findMany({ where: { notebookId: id, deletedAt: null } }),
      this.prisma.page.findMany({ where: { notebookId: id, deletedAt: null }, select: PAGE_META_SELECT }),
    ]);
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
  async create(userId: string, input: CreateNotebookInput, withDefaultCategory = false): Promise<NotebookDto> {
    const spaceId = input.spaceId ?? (await this.spaces.personalSpaceId(userId));
    await this.perms.requireSpace(userId, spaceId, Permission.CREATE_NOTEBOOKS);
    return this.prisma.$transaction(async (tx) => {
      const seq = await this.seq.next(tx, spaceId); // also takes this space's write lock
      const existing = await tx.notebook.findUnique({ where: { id: input.id } });
      if (existing) {
        if (existing.spaceId !== spaceId) throw idTaken();
        return toNotebookDto(existing);
      }
      const row = await tx.notebook.create({
        data: {
          id: input.id,
          spaceId,
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
            spaceId,
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

  /** The notebook's space, after checking the person may do `needed` there (404 if they cannot even see it). */
  private async spaceOf(userId: string, id: string, needed: bigint): Promise<string> {
    const nb = await this.prisma.notebook.findUnique({ where: { id }, select: { spaceId: true } });
    if (!nb) throw notFound();
    await this.perms.requireSpace(userId, nb.spaceId, needed);
    return nb.spaceId;
  }

  async update(userId: string, id: string, patch: UpdateNotebookInput): Promise<NotebookDto> {
    const spaceId = await this.spaceOf(userId, id, Permission.MANAGE_NOTEBOOKS);
    return this.prisma.$transaction(async (tx) => {
      const seq = await this.seq.next(tx, spaceId);
      const current = await tx.notebook.findFirst({ where: { id, spaceId, deletedAt: null } });
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
  async remove(userId: string, id: string): Promise<void> {
    const nb = await this.prisma.notebook.findUnique({ where: { id }, select: { spaceId: true } });
    if (!nb) return; // gone already: deleting twice is fine (but never confirm what the person cannot see)
    await this.perms.requireSpace(userId, nb.spaceId, Permission.MANAGE_NOTEBOOKS);
    return this.prisma.$transaction(async (tx) => {
      const seq = await this.seq.next(tx, nb.spaceId);
      const current = await tx.notebook.findFirst({ where: { id } });
      if (!current || current.deletedAt) return;
      const deletedAt = new Date();
      await tx.notebook.update({ where: { id }, data: { deletedAt, seq } });
      await tx.category.updateMany({ where: { notebookId: id, deletedAt: null }, data: { deletedAt, seq } });
      await tx.page.updateMany({ where: { notebookId: id, deletedAt: null }, data: { deletedAt, seq } });
    });
  }

  /** Restores the notebook plus whatever was deleted together with it (items trashed earlier stay trashed). */
  async restore(userId: string, id: string): Promise<NotebookDto> {
    const spaceId = await this.spaceOf(userId, id, Permission.MANAGE_NOTEBOOKS);
    return this.prisma.$transaction(async (tx) => {
      const seq = await this.seq.next(tx, spaceId);
      const nb = await tx.notebook.findFirst({ where: { id } });
      if (!nb) throw notFound();
      if (!nb.deletedAt) return toNotebookDto(nb);
      const stamp = nb.deletedAt;
      const row = await tx.notebook.update({ where: { id }, data: { deletedAt: null, seq } });
      await tx.category.updateMany({ where: { notebookId: id, deletedAt: stamp }, data: { deletedAt: null, seq } });
      await tx.page.updateMany({ where: { notebookId: id, deletedAt: stamp }, data: { deletedAt: null, seq } });
      return toNotebookDto(row);
    });
  }
}
