import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from './storage.service.js';

const DAY = 24 * 60 * 60 * 1000;

/** How long trashed items are kept before they are permanently removed. */
export const TRASH_RETENTION_DAYS = 30;
/**
 * Uploads not referenced by any saved page are kept this long. It is generous on purpose: a note
 * written offline references its media from local content that may not sync for days.
 */
export const ORPHAN_MEDIA_GRACE_DAYS = 7;

@Injectable()
export class MaintenanceService {
  private readonly log = new Logger(MaintenanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  @Cron('0 3 * * *')
  async nightly(): Promise<void> {
    try {
      const purged = await this.purgeTrash();
      const media = await this.collectOrphanMedia();
      this.log.log(`nightly: purged ${purged.pages} pages, ${purged.categories} categories, ${purged.notebooks} notebooks; removed ${media} orphan media`);
    } catch (e) {
      this.log.error(`nightly maintenance failed: ${e instanceof Error ? e.stack : e}`);
    }
  }

  /**
   * Permanently deletes items that have been in the trash longer than the retention period.
   * Hard deletes leave no tombstone, so a device that was offline for longer than this will get
   * `not_found` for its stale edits and must keep them as copies.
   */
  async purgeTrash(now = new Date()) {
    const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * DAY);
    const old = { deletedAt: { not: null, lt: cutoff } };
    const pages = await this.prisma.page.deleteMany({ where: old });
    const categories = await this.prisma.category.deleteMany({ where: old });
    const notebooks = await this.prisma.notebook.deleteMany({ where: old });
    return { pages: pages.count, categories: categories.count, notebooks: notebooks.count };
  }

  /** Deletes uploads that no page references any more, and returns the space to the owners' quota. */
  async collectOrphanMedia(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - ORPHAN_MEDIA_GRACE_DAYS * DAY);
    let removed = 0;
    for (;;) {
      const batch = await this.prisma.media.findMany({
        where: { createdAt: { lt: cutoff }, pages: { none: {} } },
        take: 200,
      });
      if (!batch.length) return removed;

      await Promise.all(batch.map((m) => this.storage.remove(m.userId, m.id).catch(() => undefined)));

      const freedByUser = new Map<string, number>();
      for (const m of batch) freedByUser.set(m.userId, (freedByUser.get(m.userId) ?? 0) + m.size);
      await this.prisma.$transaction([
        this.prisma.media.deleteMany({ where: { id: { in: batch.map((m) => m.id) } } }),
        ...[...freedByUser].map(([userId, bytes]) =>
          this.prisma.user.update({ where: { id: userId }, data: { storageUsedBytes: { decrement: bytes } } }),
        ),
      ]);
      removed += batch.length;
    }
  }
}
