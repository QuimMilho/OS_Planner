import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { StorageService } from '../media/storage.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QuotaService } from '../quota/quota.service.js';

const HOUR = 60 * 60 * 1000;

/** A file uploaded for a message that was never sent is kept this long (a message written offline may still be on its way). */
export const UNSENT_ATTACHMENT_GRACE_HOURS = 24;

@Injectable()
export class ChatMaintenance {
  private readonly log = new Logger(ChatMaintenance.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly quota: QuotaService,
  ) {}

  @Cron('40 * * * *')
  async hourly(): Promise<void> {
    try {
      const n = await this.collectUnsentAttachments();
      if (n) this.log.log(`removed ${n} attachments that were never sent`);
      const dead = await this.collectDeadConversations();
      if (dead) this.log.log(`removed ${dead} direct-message conversations that nobody can reach any more`);
    } catch (e) {
      this.log.error(`chat maintenance failed: ${e instanceof Error ? e.stack : e}`);
    }
  }

  /** A conversation whose two accounts are both gone has nobody left to read it: it goes, with its messages. */
  async collectDeadConversations(): Promise<number> {
    let removed = 0;
    for (;;) {
      const dead = await this.prisma.directConversation.findMany({
        where: { userA: null, userB: null },
        select: { channelId: true },
        take: 200,
      });
      if (!dead.length) return removed;
      await this.prisma.channel.deleteMany({ where: { id: { in: dead.map((d) => d.channelId) } } }); // the conversation, messages and read marks cascade
      removed += dead.length;
    }
  }

  /** Deletes uploads no message ever claimed, and gives the space their bytes back. */
  async collectUnsentAttachments(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - UNSENT_ATTACHMENT_GRACE_HOURS * HOUR);
    let removed = 0;
    for (;;) {
      const batch = await this.prisma.media.findMany({
        where: { attachment: { is: { messageId: null, createdAt: { lt: cutoff } } } },
        select: { id: true, userId: true, spaceId: true, size: true },
        take: 200,
      });
      if (!batch.length) return removed;

      const freed = new Map<string, number>();
      for (const m of batch) freed.set(m.spaceId, (freed.get(m.spaceId) ?? 0) + m.size);
      await this.prisma.$transaction(async (tx) => {
        await tx.media.deleteMany({ where: { id: { in: batch.map((m) => m.id) } } }); // the attachment rows go with them
        for (const [spaceId, bytes] of freed) await this.quota.chargeSpace(tx, spaceId, -bytes);
      });
      await Promise.all(
        batch.map((m) => this.storage.remove(m.userId, m.id).catch(() => undefined)),
      );
      removed += batch.length;
    }
  }
}
