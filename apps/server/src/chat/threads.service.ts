import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  hasPermission,
  Permission,
  type CreateThreadInput,
  type ThreadPageDto,
  type ThreadSummaryDto,
  type UpdateThreadInput,
} from '@os-planner/shared';
import { CHAT_EVENTS, CHAT_LIMITS } from '@os-planner/shared/chat';
import { newId } from '../common/crypto.js';
import type { Thread } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { PermissionService } from '../spaces/permission.service.js';
import type { ChatAccess } from './channel-access.js';
import { ChannelsService } from './channels.service.js';
import { ChatEvents } from './chat-events.js';
import { MessageView } from './message-view.js';

/** A thread branches off one message of a channel; there is one per message. Its replies stay out of the channel list. */
@Injectable()
export class ThreadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionService,
    private readonly channels: ChannelsService,
    private readonly view: MessageView,
    private readonly events: ChatEvents,
  ) {}

  /** Whether the person may be in the room of a thread: the thread exists and they can see its channel. */
  async canJoin(userId: string, threadId: string): Promise<boolean> {
    const thread = await this.prisma.thread.findUnique({
      where: { id: threadId },
      select: { channelId: true },
    });
    if (!thread) return false;
    const access = await this.perms.channelAccess(userId, thread.channelId);
    return access !== null && access.channel.kind === 'text';
  }

  private async threadAccess(
    userId: string,
    threadId: string,
  ): Promise<{ thread: Thread; access: ChatAccess & { chat: NonNullable<ChatAccess['chat']> } }> {
    const thread = await this.prisma.thread.findUnique({ where: { id: threadId } });
    if (!thread) throw new NotFoundException();
    return { thread, access: await this.channels.teamTextChannel(userId, thread.channelId) };
  }

  private async summary(
    tx: Tx | PrismaService,
    threadId: string,
    teamId: string,
  ): Promise<ThreadSummaryDto> {
    const thread = await tx.thread.findUniqueOrThrow({ where: { id: threadId } });
    const root = await tx.message.findUniqueOrThrow({ where: { id: thread.rootMessageId } });
    return (await this.view.dto(root, teamId, tx)).thread!;
  }

  async create(
    userId: string,
    messageId: string,
    input: CreateThreadInput,
  ): Promise<ThreadSummaryDto> {
    const root = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!root || root.deletedAt) throw new NotFoundException();
    const access = await this.channels.teamTextChannel(userId, root.channelId); // a direct message has no threads: 404
    if (root.threadId) throw new NotFoundException(); // a reply cannot start a thread of its own
    if (!hasPermission(access.perms, Permission.CREATE_THREADS))
      throw new ForbiddenException('forbidden');
    if (access.channel.archivedAt) throw new ConflictException('channel_archived');
    if (await this.prisma.thread.findUnique({ where: { rootMessageId: messageId } }))
      throw new ConflictException('thread_exists');

    try {
      return await this.prisma.$transaction(async (tx) => {
        const seq = (
          await tx.channel.update({
            where: { id: root.channelId },
            data: { lastSeq: { increment: 1 } },
            select: { lastSeq: true },
          })
        ).lastSeq;
        const thread = await tx.thread.create({
          data: {
            id: newId(),
            channelId: root.channelId,
            rootMessageId: messageId,
            name: input.name,
            createdBy: userId,
          },
        });
        await tx.message.update({ where: { id: messageId }, data: { seq } });
        const summary = await this.summary(tx, thread.id, access.chat.teamId);
        this.events.toChannel(tx, root.channelId, CHAT_EVENTS.threadCreated, {
          channelId: root.channelId,
          thread: summary,
          rootMessageId: messageId,
        });
        return summary;
      });
    } catch (e) {
      // Two people starting a thread on the same message at once: the unique key lets one of them win.
      if ((e as { code?: string }).code === 'P2002') throw new ConflictException('thread_exists');
      throw e;
    }
  }

  async messages(
    userId: string,
    threadId: string,
    q: { before?: string; limit: number },
  ): Promise<ThreadPageDto> {
    const { thread, access } = await this.threadAccess(userId, threadId);
    const cutoff = hasPermission(access.perms, Permission.READ_MESSAGE_HISTORY)
      ? null
      : await this.channels.touch(userId, access.channel.id);
    const limit = Math.min(q.limit, CHAT_LIMITS.pageMax);
    const rows = await this.prisma.message.findMany({
      where: {
        threadId,
        ...(q.before ? { id: { lt: q.before } } : {}),
        ...(cutoff ? { createdAt: { gte: cutoff } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    const root = await this.prisma.message.findUniqueOrThrow({
      where: { id: thread.rootMessageId },
    });
    const [items, rootDto] = await Promise.all([
      this.view.dtos(rows.slice(0, limit).reverse(), access.chat.teamId),
      this.view.dto(root, access.chat.teamId),
    ]);
    return {
      items,
      hasMore: rows.length > limit,
      lastSeq: access.channel.lastSeq.toString(10),
      thread: rootDto.thread!,
      root: rootDto,
    };
  }

  /** Rename or archive: the person who started it, or a moderator. */
  async update(
    userId: string,
    threadId: string,
    input: UpdateThreadInput,
  ): Promise<ThreadSummaryDto> {
    const { thread, access } = await this.threadAccess(userId, threadId);
    if (thread.createdBy !== userId && !hasPermission(access.perms, Permission.MANAGE_MESSAGES))
      throw new ForbiddenException('forbidden');
    return this.prisma.$transaction(async (tx) => {
      const seq = (
        await tx.channel.update({
          where: { id: thread.channelId },
          data: { lastSeq: { increment: 1 } },
          select: { lastSeq: true },
        })
      ).lastSeq;
      await tx.thread.update({
        where: { id: threadId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.archived !== undefined
            ? { archivedAt: input.archived ? (thread.archivedAt ?? new Date()) : null }
            : {}),
        },
      });
      await tx.message.update({ where: { id: thread.rootMessageId }, data: { seq } });
      const summary = await this.summary(tx, threadId, access.chat.teamId);
      const event = {
        channelId: thread.channelId,
        thread: summary,
        rootMessageId: thread.rootMessageId,
      };
      this.events.toChannel(tx, thread.channelId, CHAT_EVENTS.threadUpdated, event);
      this.events.toThread(tx, threadId, CHAT_EVENTS.threadUpdated, event);
      return summary;
    });
  }
}
