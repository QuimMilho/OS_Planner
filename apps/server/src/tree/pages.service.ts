import { ConflictException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import {
  collectMediaIds,
  CURRENT_SCHEMA_VERSION,
  EMPTY_DOC,
  extractText,
  Permission,
  validateDoc,
  type CreatePageInput,
  type PageDto,
  type PageMetaDto,
  type PutContentInput,
  type PutContentOk,
  type UpdatePageInput,
} from '@os-planner/shared';
import { jsonEquals } from '../common/stable-json.js';
import type { Prisma } from '../generated/prisma/client.js';
import { ChangeSeqService } from '../prisma/change-seq.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QuotaService } from '../quota/quota.service.js';
import { PermissionService } from '../spaces/permission.service.js';
import { SpacesService } from '../spaces/spaces.service.js';
import { PAGE_META_SELECT, toPageDto, toPageMetaDto } from './mappers.js';
import { idTaken, invalid, notFound, parentDeleted } from './tree.error.js';

/** Bytes a document counts toward the storage quota: the UTF-8 size of its JSON. */
export const docBytes = (doc: unknown): number => Buffer.byteLength(JSON.stringify(doc), 'utf8');

const EMPTY_DOC_BYTES = docBytes(EMPTY_DOC);

@Injectable()
export class PagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seq: ChangeSeqService,
    private readonly quota: QuotaService,
    private readonly perms: PermissionService,
    private readonly spaces: SpacesService,
  ) {}

  /** Pages of a category or notebook (which tells the space), or of the person's own space when no filter is given. */
  async list(userId: string, filter: { categoryId?: string; notebookId?: string }): Promise<PageMetaDto[]> {
    let spaceId: string;
    if (filter.categoryId) {
      const cat = await this.prisma.category.findUnique({ where: { id: filter.categoryId }, select: { spaceId: true, notebookId: true } });
      if (!cat) throw notFound();
      spaceId = cat.spaceId;
      await this.perms.requireNotebook(userId, cat.notebookId);
    } else if (filter.notebookId) {
      const nb = await this.prisma.notebook.findUnique({ where: { id: filter.notebookId }, select: { spaceId: true } });
      if (!nb) throw notFound();
      spaceId = nb.spaceId;
      await this.perms.requireNotebook(userId, filter.notebookId);
    } else {
      spaceId = await this.spaces.personalSpaceId(userId);
      await this.perms.requireSpace(userId, spaceId);
    }
    const rows = await this.prisma.page.findMany({
      where: { spaceId, deletedAt: null, ...filter },
      select: PAGE_META_SELECT,
    });
    return rows.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0)).map(toPageMetaDto);
  }

  /** Trashed pages can still be fetched (for the Trash preview); the DTO carries deletedAt. */
  async get(userId: string, id: string): Promise<PageDto> {
    const row = await this.prisma.page.findUnique({ where: { id } });
    if (!row) throw notFound();
    await this.perms.requireNotebook(userId, row.notebookId);
    return toPageDto(row);
  }

  /** The page's space, after checking the person may do `needed` there; null if there is no such page. */
  private async spaceOf(userId: string, id: string, needed: bigint): Promise<string | null> {
    const page = await this.prisma.page.findUnique({ where: { id }, select: { spaceId: true, notebookId: true } });
    if (!page) return null;
    await this.perms.requireNotebook(userId, page.notebookId, needed);
    return page.spaceId;
  }

  async create(userId: string, input: CreatePageInput): Promise<PageMetaDto> {
    const inCategory = await this.prisma.category.findUnique({ where: { id: input.categoryId }, select: { spaceId: true, notebookId: true } });
    if (!inCategory) throw notFound('category');
    const spaceId = inCategory.spaceId;
    await this.perms.requireNotebook(userId, inCategory.notebookId, Permission.EDIT_PAGES);

    return this.prisma.$transaction(async (tx) => {
      const seq = await this.seq.next(tx, spaceId);
      const existing = await tx.page.findUnique({ where: { id: input.id }, select: PAGE_META_SELECT });
      if (existing) {
        if (existing.spaceId !== spaceId) throw idTaken();
        return toPageMetaDto(existing);
      }
      const category = await tx.category.findFirst({ where: { id: input.categoryId, spaceId } });
      if (!category) throw notFound('category');
      if (category.deletedAt) throw parentDeleted();

      await this.quota.chargeSpace(tx, spaceId, EMPTY_DOC_BYTES);
      const row = await tx.page.create({
        data: {
          id: input.id,
          spaceId,
          userId,
          notebookId: category.notebookId,
          categoryId: category.id,
          title: input.title,
          content: EMPTY_DOC as Prisma.InputJsonValue,
          contentText: '',
          sizeBytes: EMPTY_DOC_BYTES,
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

  /** Rename, move to another category (possibly in another notebook of the same space), or reorder. */
  async update(userId: string, id: string, patch: UpdatePageInput): Promise<PageMetaDto> {
    const spaceId = await this.spaceOf(userId, id, Permission.EDIT_PAGES);
    if (!spaceId) throw notFound();
    return this.prisma.$transaction(async (tx) => {
      const seq = await this.seq.next(tx, spaceId);
      const current = await tx.page.findFirst({ where: { id, spaceId, deletedAt: null }, select: PAGE_META_SELECT });
      if (!current) throw notFound();

      let destination: { categoryId: string; notebookId: string } | undefined;
      if (patch.categoryId !== undefined && patch.categoryId !== current.categoryId) {
        const category = await tx.category.findUnique({ where: { id: patch.categoryId } });
        if (!category) throw notFound('category');
        // A page and the files it uses live in one space; it does not move between spaces.
        if (category.spaceId !== spaceId) throw invalid('a page cannot be moved to another space');
        if (category.deletedAt) throw parentDeleted();
        // Moving into another notebook also needs the right to write there (and to see it: otherwise 404).
        if (category.notebookId !== current.notebookId) await this.perms.requireNotebook(userId, category.notebookId, Permission.EDIT_PAGES, tx);
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
   *  - does not fit:   413 quota_exceeded, nothing changed
   */
  async putContent(userId: string, id: string, input: PutContentInput): Promise<PutContentOk> {
    const spaceId = await this.spaceOf(userId, id, Permission.EDIT_PAGES);
    if (!spaceId) throw notFound();
    const checked = validateDoc(input.content);
    if (!checked.ok) throw new UnprocessableEntityException({ message: 'invalid_document', detail: checked.error });
    const doc = checked.doc;
    const mediaIds = collectMediaIds(doc);
    const contentText = extractText(doc);
    const sizeBytes = docBytes(doc);

    return this.prisma.$transaction(async (tx) => {
      const seq = await this.seq.next(tx, spaceId);

      if (mediaIds.length) {
        const owned = await tx.media.findMany({ where: { id: { in: mediaIds }, spaceId }, select: { id: true } });
        const have = new Set(owned.map((m) => m.id));
        const missing = mediaIds.filter((m) => !have.has(m));
        if (missing.length) throw new UnprocessableEntityException({ message: 'unknown_media', missing });
      }

      const before = await tx.page.findFirst({ where: { id, spaceId, deletedAt: null }, select: { sizeBytes: true } });
      const res = await tx.page.updateMany({
        where: { id, spaceId, deletedAt: null, version: input.baseVersion },
        data: {
          content: doc as Prisma.InputJsonValue,
          contentText,
          sizeBytes,
          schemaVersion: CURRENT_SCHEMA_VERSION,
          version: { increment: 1 },
          seq,
        },
      });

      if (res.count === 1) {
        // Text counts toward the quota: charge growth (refused as a whole when it does not fit), refund shrinkage.
        await this.quota.chargeSpace(tx, spaceId, sizeBytes - (before?.sizeBytes ?? 0));
        await tx.pageMedia.deleteMany({ where: { pageId: id, mediaId: { notIn: mediaIds } } });
        if (mediaIds.length) {
          await tx.pageMedia.createMany({ data: mediaIds.map((mediaId) => ({ pageId: id, mediaId })), skipDuplicates: true });
        }
        return { version: input.baseVersion + 1 };
      }

      const current = await tx.page.findFirst({ where: { id, spaceId } });
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

  async remove(userId: string, id: string): Promise<void> {
    const spaceId = await this.spaceOf(userId, id, Permission.DELETE_PAGES);
    if (!spaceId) return; // gone already
    return this.prisma.$transaction(async (tx) => {
      const seq = await this.seq.next(tx, spaceId);
      await tx.page.updateMany({ where: { id, spaceId, deletedAt: null }, data: { deletedAt: new Date(), seq } });
    });
  }

  async restore(userId: string, id: string): Promise<PageMetaDto> {
    const spaceId = await this.spaceOf(userId, id, Permission.DELETE_PAGES);
    if (!spaceId) throw notFound();
    return this.prisma.$transaction(async (tx) => {
      const seq = await this.seq.next(tx, spaceId);
      const page = await tx.page.findFirst({ where: { id, spaceId }, select: PAGE_META_SELECT });
      if (!page) throw notFound();
      if (!page.deletedAt) return toPageMetaDto(page);
      const category = await tx.category.findFirst({ where: { id: page.categoryId, spaceId } });
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
