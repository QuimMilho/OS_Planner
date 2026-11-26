import { Injectable } from '@nestjs/common';
import { Permission, positionBetween, type CreateNotebookInput, type NotebookDto, type UpdateNotebookInput } from '@os-planner/shared';
import { ConflictException } from '@nestjs/common';
import { newId } from '../common/crypto.js';
import { ChangeSeqService } from '../prisma/change-seq.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QuotaService } from '../quota/quota.service.js';
import { AuditService } from '../roles/audit.service.js';
import { SharesService } from '../sharing/shares.service.js';
import { PermissionService } from '../spaces/permission.service.js';
import { SpacesService } from '../spaces/spaces.service.js';
import { forbidden, idTaken, notFound } from './tree.error.js';
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
    private readonly quota: QuotaService,
    private readonly shares: SharesService,
    private readonly audit: AuditService,
  ) {}

  /** The notebooks of one space: the person's own unless another one (a team or project they can see) is named. */
  async list(userId: string, spaceId?: string): Promise<NotebookDto[]> {
    const space = spaceId ?? (await this.spaces.personalSpaceId(userId));
    await this.perms.requireSpace(userId, space);
    // A notebook the person's overwrites hide is not in the list (and answers 404 everywhere else).
    const hidden = await this.perms.hiddenNotebooks(userId, space);
    const rows = await this.prisma.notebook.findMany({ where: { spaceId: space, deletedAt: null, ...(hidden.size && { id: { notIn: [...hidden] } }) } });
    // Sorted here, not in SQL: position keys are case-sensitive but the collation is not.
    return rows.sort(byPosition).map(toNotebookDto);
  }

  /** One notebook with its live categories and page metadata, each level in position order. */
  async tree(userId: string, id: string) {
    const { notebook } = await this.perms.requireNotebook(userId, id);
    if (notebook.deletedAt) throw notFound();
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

  /** The notebook's space, after checking the person may do `needed` in the notebook (404 if they cannot even see it). */
  private async spaceOf(userId: string, id: string, needed: bigint): Promise<string> {
    const { notebook } = await this.perms.requireNotebook(userId, id, needed);
    return notebook.spaceId;
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
    if (!(await this.prisma.notebook.findUnique({ where: { id }, select: { id: true } }))) return; // gone already: deleting twice is fine
    const { notebook: nb } = await this.perms.requireNotebook(userId, id, Permission.MANAGE_NOTEBOOKS);
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

  /**
   * Moves a notebook (with its categories, pages and files) to another space the person may create notebooks in. Needs
   * MANAGE_NOTEBOOKS where it is now. The storage it uses moves with it, in the same transaction: refused (413) when the target
   * has no room. Shares, links and the notebook's overwrites do not follow it (they are ended), and the space it leaves is told.
   */
  async move(userId: string, id: string, targetSpaceId: string): Promise<NotebookDto> {
    const source = await this.perms.requireNotebook(userId, id, Permission.MANAGE_NOTEBOOKS);
    if (source.via !== 'space' || source.notebook.deletedAt) throw forbidden();
    const from = source.notebook.spaceId;
    if (from === targetSpaceId) return toNotebookDto(source.notebook);
    await this.perms.requireSpace(userId, targetSpaceId, Permission.CREATE_NOTEBOOKS);

    const ended = await this.prisma.$transaction(async (tx) => {
      // Both spaces are locked in the same order by everybody, so two moves in opposite directions cannot deadlock.
      const seqs = new Map<string, bigint>();
      for (const space of [from, targetSpaceId].sort()) seqs.set(space, await this.seq.next(tx, space));
      const current = await tx.notebook.findFirst({ where: { id, spaceId: from } });
      if (!current) throw notFound();

      const pages = await tx.page.findMany({ where: { notebookId: id }, select: { sizeBytes: true } });
      const links = await tx.pageMedia.findMany({ where: { page: { notebookId: id } }, select: { mediaId: true }, distinct: ['mediaId'] });
      const mediaIds = links.map((l) => l.mediaId);
      if (mediaIds.length && (await tx.pageMedia.count({ where: { mediaId: { in: mediaIds }, page: { notebookId: { not: id } } } })) > 0)
        throw new ConflictException('media_shared_with_other_notebook');
      const media = mediaIds.length ? await tx.media.findMany({ where: { id: { in: mediaIds }, spaceId: from }, select: { size: true } }) : [];
      const bytes = pages.reduce((n, p) => n + p.sizeBytes, 0) + media.reduce((n, m) => n + m.size, 0);

      // Give back first, then charge: a move inside one team (net zero) must not be refused for lack of room.
      await this.quota.chargeSpace(tx, from, -bytes);
      await this.quota.chargeSpace(tx, targetSpaceId, bytes);

      const seq = seqs.get(targetSpaceId)!;
      await tx.notebook.update({ where: { id }, data: { spaceId: targetSpaceId, seq } });
      await tx.category.updateMany({ where: { notebookId: id }, data: { spaceId: targetSpaceId, seq } });
      await tx.page.updateMany({ where: { notebookId: id }, data: { spaceId: targetSpaceId, seq } });
      if (mediaIds.length) await tx.media.updateMany({ where: { id: { in: mediaIds }, spaceId: from }, data: { spaceId: targetSpaceId } });
      await tx.notebookMove.create({ data: { id: newId(), spaceId: from, notebookId: id, seq: seqs.get(from)! } });
      await tx.overwrite.deleteMany({ where: { targetKind: 'notebook', targetId: id } });
      const affected = await this.shares.endAll(tx, id);

      for (const space of [from, targetSpaceId]) {
        const owner = await tx.space.findUnique({ where: { id: space }, select: { teamId: true, project: { select: { teamId: true } } } });
        const teamId = owner?.teamId ?? owner?.project?.teamId;
        if (teamId) await this.audit.record(tx, { teamId, actorId: userId, action: 'notebook.move', targetKind: 'notebook', targetId: id, before: { spaceId: from }, after: { spaceId: targetSpaceId } });
      }
      return affected;
    });
    await this.shares.announce(ended);
    return toNotebookDto(await this.prisma.notebook.findUniqueOrThrow({ where: { id } }));
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
