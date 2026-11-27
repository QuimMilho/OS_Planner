import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { JSONContent } from '@tiptap/core';
import {
  Permission,
  collectMediaIds,
  validateDoc,
  type PageSnapshotDto,
  type ReplaceContentInput,
  type ReplaceContentOk,
  type SnapshotReason,
} from '@os-planner/shared';
import { applyJSON, docFromState, jsonToYDoc, yDocToJSON } from '@os-planner/shared/collab';
import * as Y from 'yjs';
import { jsonEquals } from '../common/stable-json.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QuotaService } from '../quota/quota.service.js';
import { docBytes } from '../tree/pages.service.js';
import { PermissionService } from '../spaces/permission.service.js';
import { CollabRegistry } from './collab.registry.js';
import { CollabService } from './collab.service.js';

const notFound = () => new NotFoundException();

/**
 * Saved versions of a page: who may look at them and bring one back. Restoring is a new change on top of the page as it is now
 * (the people in it see it appear), not a rollback of its history, and the page as it was is saved first.
 */
@Injectable()
export class SnapshotsService {
  /** One replacement of a page at a time on this instance: two devices sending from the same version, exactly one wins. */
  private readonly replacing = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionService,
    private readonly collab: CollabService,
    private readonly registry: CollabRegistry,
    private readonly quota: QuotaService,
  ) {}

  /** Seeing and restoring versions is a moderator's job: whoever manages the notebook (everything, in one's own). */
  private async require(userId: string, pageId: string, needed: bigint): Promise<void> {
    const page = await this.prisma.page.findUnique({
      where: { id: pageId },
      select: { notebookId: true },
    });
    if (!page) throw notFound();
    await this.perms.requireNotebook(userId, page.notebookId, needed);
  }

  async list(userId: string, pageId: string): Promise<PageSnapshotDto[]> {
    await this.require(userId, pageId, Permission.MANAGE_NOTEBOOKS);
    const rows = await this.prisma.pageYSnapshot.findMany({
      where: { pageId },
      select: { id: true, pageId: true, reason: true, createdAt: true, byUserId: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const ids = [...new Set(rows.map((r) => r.byUserId).filter((x): x is string => !!x))];
    const people = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayName: true },
    });
    const names = new Map(people.map((p) => [p.id, p.displayName]));
    return rows.map((r) => ({
      id: r.id,
      pageId: r.pageId,
      reason: r.reason as SnapshotReason,
      createdAt: r.createdAt.toISOString(),
      byUserId: r.byUserId,
      byName: r.byUserId ? (names.get(r.byUserId) ?? null) : null,
    }));
  }

  /** The document as the snapshot held it. */
  async preview(
    userId: string,
    pageId: string,
    snapshotId: string,
  ): Promise<{ content: JSONContent }> {
    await this.require(userId, pageId, Permission.MANAGE_NOTEBOOKS);
    const row = await this.prisma.pageYSnapshot.findFirst({
      where: { id: snapshotId, pageId },
      select: { state: true },
    });
    if (!row) throw notFound();
    return { content: yDocToJSON(docFromState(row.state)) };
  }

  /** The page as it is right now (live if somebody is in it, else as stored). */
  private async current(pageId: string): Promise<Uint8Array> {
    const live = this.registry.hocuspocus?.documents.get(pageId);
    if (live) return Y.encodeStateAsUpdate(live);
    const stored = await this.prisma.pageYDoc.findUnique({
      where: { pageId },
      select: { state: true },
    });
    if (stored) return stored.state;
    const page = await this.prisma.page.findUnique({
      where: { id: pageId },
      select: { content: true },
    });
    if (!page) throw notFound();
    return Y.encodeStateAsUpdate(jsonToYDoc(page.content as unknown as JSONContent));
  }

  /**
   * A text a device kept replaces the page as it is now, as one new change on top (the people in the page see it appear): the Local
   * history's "Replace" (phase 15), a copy the device made, the text of a page edited before co-editing (phase 17 took the old
   * `PUT /pages/:id/content` away; this answers like it did). The page as it was is saved first, so the replacement can be undone.
   * Whoever may edit the page may do this: it is what editing the page to that text would have been.
   *
   *  - `baseVersion` given and the page changed since: 409 `version_conflict` with the server's version and text (the device keeps
   *    both), unless the text is the same already (a retry whose answer was lost)
   *  - a file the text uses that is not on the server: 422 `unknown_media` with the ids
   *  - a text that does not fit the storage left: 413 `quota_exceeded`, nothing changed
   */
  async replaceContent(userId: string, pageId: string, input: ReplaceContentInput): Promise<ReplaceContentOk> {
    await this.require(userId, pageId, Permission.EDIT_PAGES);
    const checked = validateDoc(input.content);
    if (!checked.ok) throw new UnprocessableEntityException({ message: 'invalid_document', detail: checked.error });
    const before = this.replacing.get(pageId) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(() => this.replaceNow(userId, pageId, input.baseVersion, checked.doc));
    this.replacing.set(pageId, run);
    try {
      return await run;
    } finally {
      if (this.replacing.get(pageId) === run) this.replacing.delete(pageId);
    }
  }

  private async replaceNow(userId: string, pageId: string, baseVersion: number | undefined, content: JSONContent): Promise<ReplaceContentOk> {
    // what people in the page typed and is waiting to be stored is the version the device is compared with
    if (baseVersion !== undefined) await this.registry.flush(pageId);
    const page = await this.prisma.page.findUnique({
      where: { id: pageId },
      select: { spaceId: true, version: true, content: true, sizeBytes: true, deletedAt: true },
    });
    if (!page || page.deletedAt) throw notFound();
    if (baseVersion !== undefined && baseVersion !== page.version) {
      if (jsonEquals(page.content, content)) return { ok: true, version: page.version };
      throw new ConflictException({ statusCode: 409, message: 'version_conflict', version: page.version, content: page.content });
    }
    const mediaIds = collectMediaIds(content);
    if (mediaIds.length) {
      const owned = await this.prisma.media.findMany({ where: { id: { in: mediaIds }, spaceId: page.spaceId }, select: { id: true } });
      const have = new Set(owned.map((m) => m.id));
      const missing = mediaIds.filter((m) => !have.has(m));
      if (missing.length) throw new UnprocessableEntityException({ message: 'unknown_media', missing });
    }
    const growth = docBytes(content) - page.sizeBytes;
    if (growth > 0) await this.quota.assertCanStoreInSpace(page.spaceId, growth);
    // a page nobody ever wrote in has nothing worth keeping
    if (page.version > 0) await this.collab.snapshot(pageId, await this.current(pageId), 'pre_merge', userId);
    await this.registry.change(pageId, (doc) => applyJSON(doc, content), { userId });
    const stored = await this.prisma.page.findUnique({ where: { id: pageId }, select: { version: true } });
    return { ok: true, version: stored?.version ?? page.version };
  }

  async restore(userId: string, pageId: string, snapshotId: string): Promise<void> {
    await this.require(userId, pageId, Permission.MANAGE_NOTEBOOKS);
    const row = await this.prisma.pageYSnapshot.findFirst({
      where: { id: snapshotId, pageId },
      select: { state: true },
    });
    if (!row) throw notFound();
    const target = yDocToJSON(docFromState(row.state));
    await this.collab.snapshot(pageId, await this.current(pageId), 'pre_merge', userId);
    await this.registry.change(pageId, (doc) => applyJSON(doc, target), { userId });
  }
}
