import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service.js';
import { QuotaService } from '../quota/quota.service.js';
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
    private readonly quota: QuotaService,
  ) {}

  @Cron('0 3 * * *')
  async nightly(): Promise<void> {
    try {
      const purged = await this.purgeTrash();
      const containers = await this.purgeDeletedContainers();
      const media = await this.collectOrphanMedia();
      this.log.log(
        `nightly: purged ${purged.pages} pages, ${purged.categories} categories, ${purged.notebooks} notebooks, ${containers.teams} teams, ${containers.projects} projects; removed ${media} orphan media`,
      );
    } catch (e) {
      this.log.error(`nightly maintenance failed: ${e instanceof Error ? e.stack : e}`);
    }
  }

  /**
   * Permanently deletes items that have been in the trash longer than the retention period.
   * Hard deletes leave no tombstone, so a device that was offline for longer than this will get
   * `not_found` for its stale edits and must keep them as copies. The space they used goes back
   * to whoever it was charged to.
   */
  async purgeTrash(now = new Date()) {
    const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * DAY);
    const old = { deletedAt: { not: null, lt: cutoff } };
    return this.prisma.$transaction(async (tx) => {
      // Deleting a category or notebook cascades to the pages under it, so work out first which
      // pages will disappear (and what they weigh) in order to hand the space back.
      const notebookIds = (await tx.notebook.findMany({ where: old, select: { id: true } })).map((n) => n.id);
      const categoryIds = (await tx.category.findMany({ where: old, select: { id: true } })).map((c) => c.id);
      const doomed = await tx.page.findMany({
        where: { OR: [old, ...(categoryIds.length ? [{ categoryId: { in: categoryIds } }] : []), ...(notebookIds.length ? [{ notebookId: { in: notebookIds } }] : [])] },
        select: { id: true, spaceId: true, sizeBytes: true },
      });

      const pages = await tx.page.deleteMany({ where: old });
      const categories = await tx.category.deleteMany({ where: old });
      const notebooks = await tx.notebook.deleteMany({ where: old });
      // Overwrites on a notebook are not tied to it by a foreign key: they go with it.
      if (notebookIds.length) await tx.overwrite.deleteMany({ where: { targetKind: 'notebook', targetId: { in: notebookIds } } });

      const freed = new Map<string, number>();
      for (const p of doomed) freed.set(p.spaceId, (freed.get(p.spaceId) ?? 0) + p.sizeBytes);
      for (const [spaceId, bytes] of freed) await this.quota.chargeSpace(tx, spaceId, -bytes);

      return { pages: pages.count, categories: categories.count, notebooks: notebooks.count };
    });
  }

  /**
   * Teams and projects that were deleted more than the retention period ago go for good, with
   * everything in their spaces (uploaded files included). A purged project hands what it stored
   * back to its team's total.
   */
  async purgeDeletedContainers(now = new Date()): Promise<{ teams: number; projects: number }> {
    const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * DAY);
    const old = { deletedAt: { not: null, lt: cutoff } };

    const teams = await this.prisma.team.findMany({ where: old, select: { id: true } });
    const teamIds = teams.map((t) => t.id);
    const projects = await this.prisma.project.findMany({
      where: { OR: [old, ...(teamIds.length ? [{ teamId: { in: teamIds } }] : [])] },
      select: { id: true, teamId: true, spaceId: true },
    });
    if (!teams.length && !projects.length) return { teams: 0, projects: 0 };

    const teamSpaces = await this.prisma.space.findMany({ where: { teamId: { in: teamIds } }, select: { id: true } });
    const spaceIds = [...teamSpaces.map((s) => s.id), ...projects.map((p) => p.spaceId)];
    const files = spaceIds.length ? await this.prisma.media.findMany({ where: { spaceId: { in: spaceIds } }, select: { id: true, userId: true } }) : [];

    await this.prisma.$transaction(async (tx) => {
      // Overwrites on channels are not tied to them by a foreign key: they go with the channels (which go with their spaces).
      const channels = await tx.channel.findMany({ where: { spaceId: { in: spaceIds } }, select: { id: true } });
      if (channels.length) await tx.overwrite.deleteMany({ where: { targetKind: 'channel', targetId: { in: channels.map((c) => c.id) } } });
      const boards = await tx.board.findMany({ where: { spaceId: { in: spaceIds } }, select: { id: true } });
      if (boards.length) await tx.overwrite.deleteMany({ where: { targetKind: 'board', targetId: { in: boards.map((b) => b.id) } } });
      const notebooks = await tx.notebook.findMany({ where: { spaceId: { in: spaceIds } }, select: { id: true } });
      if (notebooks.length) await tx.overwrite.deleteMany({ where: { targetKind: 'notebook', targetId: { in: notebooks.map((n) => n.id) } } });
      // A project that goes while its team stays gives its bytes back to the team's total.
      const survivors = projects.filter((p) => !teamIds.includes(p.teamId));
      if (survivors.length) {
        const spaces = await tx.space.findMany({ where: { id: { in: survivors.map((p) => p.spaceId) } }, select: { id: true, storageUsedBytes: true } });
        const used = new Map(spaces.map((s) => [s.id, Number(s.storageUsedBytes)]));
        const byTeam = new Map<string, number>();
        for (const p of survivors) byTeam.set(p.teamId, (byTeam.get(p.teamId) ?? 0) + (used.get(p.spaceId) ?? 0));
        for (const [teamId, bytes] of byTeam) await this.quota.charge(tx, 'team', teamId, -bytes);
      }
      // Spaces go with their team or project (foreign keys cascade to notebooks, pages and media).
      await tx.project.deleteMany({ where: { id: { in: projects.map((p) => p.id) } } });
      await tx.team.deleteMany({ where: { id: { in: teamIds } } });
    });

    await Promise.all(files.map((m) => this.storage.remove(m.userId, m.id).catch(() => undefined)));
    return { teams: teams.length, projects: projects.length };
  }

  /** Deletes uploads that no page references any more, and returns the space to whoever it was charged to. */
  async collectOrphanMedia(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - ORPHAN_MEDIA_GRACE_DAYS * DAY);
    let removed = 0;
    for (;;) {
      const batch = await this.prisma.media.findMany({
        where: { createdAt: { lt: cutoff }, pages: { none: {} }, attachment: { is: null }, taskAttachment: { is: null } }, // chat and task files live as long as what they belong to
        take: 200,
      });
      if (!batch.length) return removed;

      await Promise.all(batch.map((m) => this.storage.remove(m.userId, m.id).catch(() => undefined)));

      const freedBySpace = new Map<string, number>();
      for (const m of batch) freedBySpace.set(m.spaceId, (freedBySpace.get(m.spaceId) ?? 0) + m.size);
      await this.prisma.$transaction(async (tx) => {
        await tx.media.deleteMany({ where: { id: { in: batch.map((m) => m.id) } } });
        for (const [spaceId, bytes] of freedBySpace) await this.quota.chargeSpace(tx, spaceId, -bytes);
      });
      removed += batch.length;
    }
  }
}
