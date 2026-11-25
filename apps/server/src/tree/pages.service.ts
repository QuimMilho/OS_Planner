import { ConflictException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import {
  collectMediaIds,
  CURRENT_SCHEMA_VERSION,
  EMPTY_DOC,
  extractText,
  validateDoc,
  type CreatePageInput,
  type PageDto,
  type PageMetaDto,
  type PutContentInput,
  type PutContentOk,
  type UpdatePageInput,
} from '@notes/shared';
import { jsonEquals } from '../common/stable-json.js';
import type { Prisma } from '../generated/prisma/client.js';
import { ChangeSeqService } from '../prisma/change-seq.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PAGE_META_SELECT, toPageDto, toPageMetaDto } from './mappers.js';
import { idTaken, notFound, parentDeleted } from './tree.error.js';

@Injectable()
export class PagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seq: ChangeSeqService,
  ) {}

  async list(userId: string, filter: { categoryId?: string; notebookId?: string }): Promise<PageMetaDto[]> {
    const rows = await this.prisma.page.findMany({
      where: { userId, deletedAt: null, ...filter },
      select: PAGE_META_SELECT,
    });
    return rows.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0)).map(toPageMetaDto);
  }

  /** Trashed pages can still be fetched (for the Trash preview); the DTO carries deletedAt. */
  async get(userId: string, id: string): Promise<PageDto> {
    const row = await this.prisma.page.findFirst({ where: { id, userId } });
    if (!row) throw notFound();
    return toPageDto(row);
  }

  create(userId: string, input: CreatePageInput): Promise<PageMetaDto> {
    return this.prisma.$transaction(async (tx) => {
      const seq = await this.seq.next(tx, userId);
      const existing = await tx.page.findUnique({ where: { id: input.id }, select: PAGE_META_SELECT });
      if (existing) {
        if (existing.userId !== userId) throw idTaken();
        return toPageMetaDto(existing);
      }
      const category = await tx.category.findFirst({ where: { id: input.categoryId, userId } });
      if (!category) throw notFound('category');
      if (category.deletedAt) throw parentDeleted();

      const row = await tx.page.create({
        data: {
          id: input.id,
          userId,
          notebookId: category.notebookId,
          categoryId: category.id,
          title: input.title,
          content: EMPTY_DOC as Prisma.InputJsonValue,
          contentText: '',
          schemaVersion: CURRENT_SCHEMA_VERSION,
          version: 0,
          position: input.position,
          seq,
        },
        select: PAGE_META_SELECT,
      });
      return toPageMetaDto(row);
    });
  }

  /** Rename, move to another category (possibly in another notebook), or reorder. */
  update(userId: string, id: string, patch: UpdatePageInput): Promise<PageMetaDto> {
    return this.prisma.$transaction(async (tx) => {
      const seq = await this.seq.next(tx, userId);
      const current = await tx.page.findFirst({ where: { id, userId, deletedAt: null }, select: PAGE_META_SELECT });
      if (!current) throw notFound();

      let destination: { categoryId: string; notebookId: string } | undefined;
      if (patch.categoryId !== undefined && patch.categoryId !== current.categoryId) {
        const category = await tx.category.findFirst({ where: { id: patch.categoryId, userId } });
        if (!category) throw notFound('category');
        if (category.deletedAt) throw parentDeleted();
        destination = { categoryId: category.id, notebookId: category.notebookId };
      }

      const row = await tx.page.update({
        where: { id },
        data: {
          ...(patch.title !== undefined && { title: patch.title }),
          ...(patch.position !== undefined && { position: patch.position }),
          ...destination,
          seq,
        },
        select: PAGE_META_SELECT,
      });
      return toPageMetaDto(row);
    });
  }

  /**
   * Saves the document if `baseVersion` is still the stored version (optimistic concurrency).
   *  - success:        { version }
   *  - stale version:  409 with the server's version and document, so the client can keep both
   *  - invalid doc:    422
   */
  async putContent(userId: string, id: string, input: PutContentInput): Promise<PutContentOk> {
    const checked = validateDoc(input.content);
    if (!checked.ok) throw new UnprocessableEntityException({ message: 'invalid_document', detail: checked.error });
    const doc = checked.doc;
    const mediaIds = collectMediaIds(doc);
    const contentText = extractText(doc);

    return this.prisma.$transaction(async (tx) => {
      const seq = await this.seq.next(tx, userId);

      if (mediaIds.length) {
        const owned = await tx.media.findMany({ where: { id: { in: mediaIds }, userId }, select: { id: true } });
        const have = new Set(owned.map((m) => m.id));
        const missing = mediaIds.filter((m) => !have.has(m));
        if (missing.length) throw new UnprocessableEntityException({ message: 'unknown_media', missing });
      }

      const res = await tx.page.updateMany({
        where: { id, userId, deletedAt: null, version: input.baseVersion },
        data: {
          content: doc as Prisma.InputJsonValue,
          contentText,
          schemaVersion: CURRENT_SCHEMA_VERSION,
          version: { increment: 1 },
          seq,
        },
      });

      if (res.count === 1) {
        await tx.pageMedia.deleteMany({ where: { pageId: id, mediaId: { notIn: mediaIds } } });
        if (mediaIds.length) {
          await tx.pageMedia.createMany({ data: mediaIds.map((mediaId) => ({ pageId: id, mediaId })), skipDuplicates: true });
        }
        return { version: input.baseVersion + 1 };
      }

      const current = await tx.page.findFirst({ where: { id, userId } });
      if (!current || current.deletedAt) throw notFound();
      // A retry whose first attempt actually succeeded (lost response) arrives with a stale
      // baseVersion but identical content: report success instead of a phantom conflict.
      if (jsonEquals(current.content, doc)) return { version: current.version };
      throw new ConflictException({
        statusCode: 409,
        message: 'version_conflict',
        version: current.version,
        content: current.content,
      });
    });
  }

  remove(userId: string, id: string): Promise<void> {
    return this.prisma.$transaction(async (tx) => {
      const seq = await this.seq.next(tx, userId);
      await tx.page.updateMany({ where: { id, userId, deletedAt: null }, data: { deletedAt: new Date(), seq } });
    });
  }

  restore(userId: string, id: string): Promise<PageMetaDto> {
    return this.prisma.$transaction(async (tx) => {
      const seq = await this.seq.next(tx, userId);
      const page = await tx.page.findFirst({ where: { id, userId }, select: PAGE_META_SELECT });
      if (!page) throw notFound();
      if (!page.deletedAt) return toPageMetaDto(page);
      const category = await tx.category.findFirst({ where: { id: page.categoryId, userId } });
      if (!category || category.deletedAt) throw parentDeleted();
      const row = await tx.page.update({
        where: { id },
        data: { deletedAt: null, seq },
        select: PAGE_META_SELECT,
      });
      return toPageMetaDto(row);
    });
  }
}
