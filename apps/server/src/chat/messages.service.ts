import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  hasPermission,
  Permission,
  type EditMessageInput,
  type ListMessagesQuery,
  type MessageDeletedEvent,
  type MentionsDto,
  type MessageDto,
  type MessagePageDto,
  type ReactionEvent,
  type SendMessageInput,
  type ThreadEvent,
} from '@os-planner/shared';
import { CHAT_EVENTS, CHAT_LIMITS } from '@os-planner/shared/chat';
import { ENV, type Env } from '../config/env.js';
import { Prisma } from '../generated/prisma/client.js';
import type { Message, Thread } from '../generated/prisma/client.js';
import { StorageService } from '../media/storage.service.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { QuotaService } from '../quota/quota.service.js';
import { parseSearchQuery } from '../search/query.js';
import { PermissionService } from '../spaces/permission.service.js';
import type { ChatAccess } from './channel-access.js';
import { ChannelsService } from './channels.service.js';
import { DirectService } from './direct.service.js';
import { MentionsService } from '../notifications/mentions.service.js';
import { NotificationService, type MessageContext } from '../notifications/notification.service.js';
import { ChatEvents } from './chat-events.js';
import { MessageView } from './message-view.js';

export const MAX_PINS = 50;
const hasMentions = (m: MentionsDto): boolean => m.users.length > 0 || m.roles.length > 0 || m.everyone || m.here;
/** At most this many messages per person in this many milliseconds. */
const RATE_MAX = 30;
const RATE_WINDOW_MS = 10_000;
const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8');

/** What a send returns: the message, and whether this request created it (a resend of the same id does not). */
export interface Sent {
  message: MessageDto;
  created: boolean;
}

/**
 * Messages of a channel: send, edit, delete, pin, react, list, catch up, search.
 *
 * Every change of a message takes the next number of the channel's change sequence (the channel row is locked for the
 * transaction, so numbers are handed out one after another and become visible in order). A client that was away asks
 * for "everything after N" and gets edits, deletions and reactions too, not just new messages.
 */
@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionService,
    private readonly channels: ChannelsService,
    private readonly view: MessageView,
    private readonly events: ChatEvents,
    private readonly quota: QuotaService,
    private readonly storage: StorageService,
    private readonly direct: DirectService,
    private readonly mentionsOf: MentionsService,
    private readonly notifications: NotificationService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** When each person sent their latest messages (this instance only): a flood is refused whatever the channel's slowmode says. */
  private readonly sent = new Map<string, number[]>();

  private enforceRate(userId: string): void {
    if (this.env.THROTTLE_DISABLED) return;
    const now = Date.now();
    const recent = (this.sent.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_MAX)
      throw new HttpException(
        { statusCode: 429, message: 'rate_limited' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    recent.push(now);
    this.sent.set(userId, recent);
    if (this.sent.size > 5000)
      for (const [id, times] of this.sent)
        if (now - (times.at(-1) ?? 0) > RATE_WINDOW_MS) this.sent.delete(id);
  }

  // ---------------------------------------------------------------- shared steps

  /**
   * Takes the channel row's lock without changing anything. Every transaction that writes in a channel starts here, so
   * writers queue up on one row instead of each holding a lock on the message (through a foreign key) and then asking for
   * a stronger one, which deadlocks.
   */
  private async lockChannel(tx: Tx, channelId: string): Promise<void> {
    await tx.$queryRaw`SELECT \`id\` FROM \`Channel\` WHERE \`id\` = ${channelId} FOR UPDATE`;
  }

  /** The next change number of the channel. Locks the channel row until the transaction ends. */
  private async nextSeq(tx: Tx, channelId: string): Promise<bigint> {
    const row = await tx.channel.update({
      where: { id: channelId },
      data: { lastSeq: { increment: 1 } },
      select: { lastSeq: true },
    });
    return row.lastSeq;
  }

  /** The message and the channel it is in, if the person can see that channel. Otherwise 404 (also for a tombstone's reactions etc. where `allowDeleted` is false). */
  private async messageAccess(
    userId: string,
    messageId: string,
    allowDeleted = false,
  ): Promise<{ message: Message; access: ChatAccess }> {
    const message = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!message) throw new NotFoundException();
    const access = await this.channels.textChannel(userId, message.channelId);
    if (!allowDeleted && message.deletedAt) throw new NotFoundException();
    // Without READ_MESSAGE_HISTORY only what was said after the person first opened the channel exists for them.
    if (await this.beforeTheirTime(userId, access, message)) throw new NotFoundException();
    return { message, access };
  }

  /** Whoever may not read history cannot see (or touch) messages from before they opened the channel. */
  private async beforeTheirTime(
    userId: string,
    access: ChatAccess,
    message: Message,
  ): Promise<boolean> {
    if (hasPermission(access.perms, Permission.READ_MESSAGE_HISTORY)) return false;
    return message.createdAt < (await this.channels.touch(userId, access.channel.id));
  }

  // ---------------------------------------------------------------- sending

  async send(userId: string, channelId: string, input: SendMessageInput): Promise<Sent> {
    const access = await this.channels.textChannel(userId, channelId);
    const { channel } = access;
    const inThread = input.threadId !== undefined && input.threadId !== null;
    const needed = inThread ? Permission.SEND_IN_THREADS : Permission.SEND_MESSAGES;
    if (!hasPermission(access.perms, needed)) throw new ForbiddenException('forbidden');
    if (channel.archivedAt) throw new ConflictException('channel_archived');
    const attachmentIds = [...new Set(input.attachmentIds ?? [])];
    if (attachmentIds.length && !hasPermission(access.perms, Permission.ATTACH_FILES))
      throw new ForbiddenException('forbidden');
    if (!input.content.trim() && !attachmentIds.length)
      throw new UnprocessableEntityException('empty_message');

    // The same id again is the same message (a retry after a lost answer), not a second one.
    const resent = await this.existing(userId, channelId, input.id, access.teamId);
    if (resent) return resent;
    // A direct message is allowed again on every send: a block, a closed door or the end of the last common team stops it.
    if (access.dm) await this.direct.assertAllowed(userId, access.dm.peerId);

    let thread: Thread | null = null;
    if (inThread) {
      thread = await this.prisma.thread.findUnique({ where: { id: input.threadId! } });
      if (!thread || thread.channelId !== channelId) throw new NotFoundException();
      if (thread.archivedAt) throw new ConflictException('thread_archived');
    }
    await this.enforceSlowmode(userId, access);
    this.enforceRate(userId);
    // Which of the mentions in the text are real is decided here, not by the client.
    const mentions = await this.mentionsOf.accept(access, userId, input.content);

    try {
      const message = await this.prisma.$transaction(async (tx) => {
        let replyToAuthorId: string | null = null;
        if (input.replyToId) {
          const target = await tx.message.findUnique({
            where: { id: input.replyToId },
            select: { channelId: true, authorId: true },
          });
          if (!target || target.channelId !== channelId)
            throw new UnprocessableEntityException('invalid_reply');
          replyToAuthorId = target.authorId;
        }
        if (attachmentIds.length) {
          const mine = await tx.attachment.count({
            where: { id: { in: attachmentIds }, channelId, uploadedBy: userId, messageId: null },
          });
          if (mine !== attachmentIds.length)
            throw new UnprocessableEntityException('invalid_attachment');
        }
        const seq = await this.nextSeq(tx, channelId);
        const size = bytesOf(input.content);
        const billTo = await this.channels.billingSpace(access, userId, tx);
        if (billTo) await this.quota.chargeSpace(tx, billTo, size);
        const created = await tx.message.create({
          data: {
            id: input.id,
            channelId,
            threadId: thread?.id ?? null,
            authorId: userId,
            content: input.content,
            mentions: hasMentions(mentions) ? (mentions as unknown as Prisma.InputJsonValue) : undefined,
            sizeBytes: size,
            replyToId: input.replyToId ?? null,
            seq,
          },
        });
        if (attachmentIds.length)
          await tx.attachment.updateMany({
            where: { id: { in: attachmentIds } },
            data: { messageId: created.id },
          });

        const dto = await this.view.dto(created, access.teamId, tx);
        if (access.dm) await this.direct.onMessage(tx, access.dm, created.createdAt);
        await this.notifications.onMessage(tx, this.contextOf(access, created, userId, mentions, replyToAuthorId), 'created');
        if (thread) {
          // A reply in a thread: the thread's room gets the message; the channel only hears that the thread moved on.
          await tx.thread.update({
            where: { id: thread.id },
            data: { lastMessageAt: created.createdAt },
          });
          await tx.message.update({ where: { id: thread.rootMessageId }, data: { seq } }); // so a catch-up shows the new reply count
          const summary = await this.threadEvent(tx, thread.id, access.teamId);
          this.events.toThread(tx, thread.id, CHAT_EVENTS.messageCreated, dto);
          this.events.toChannel(tx, channelId, CHAT_EVENTS.threadUpdated, summary);
        } else {
          this.events.toChannel(tx, channelId, CHAT_EVENTS.messageCreated, dto);
        }
        return dto;
      });
      return { message, created: true };
    } catch (e) {
      // Two sends of one id at the same moment: the loser finds the winner's message.
      if (isUniqueViolation(e)) {
        const winner = await this.existing(userId, channelId, input.id, access.teamId);
        if (winner) return winner;
      }
      throw e;
    }
  }

  private contextOf(
    access: ChatAccess,
    message: Message,
    authorId: string,
    mentions: MentionsDto,
    replyToAuthorId: string | null,
  ): MessageContext {
    return {
      message,
      channel: access.channel,
      teamId: access.teamId,
      dm: access.dm ? { conversationId: access.dm.conversation.id, peerId: access.dm.peerId } : null,
      authorId,
      mentions,
      replyToAuthorId,
    };
  }

  private async existing(
    userId: string,
    channelId: string,
    id: string,
    teamId: string | null,
  ): Promise<Sent | null> {
    const row = await this.prisma.message.findUnique({ where: { id } });
    if (!row) return null;
    if (row.channelId !== channelId || row.authorId !== userId)
      throw new ConflictException('id_taken');
    return { message: await this.view.dto(row, teamId), created: false };
  }

  /** Slowmode: one message per person per N seconds, unless they moderate. */
  private async enforceSlowmode(userId: string, access: ChatAccess): Promise<void> {
    const seconds = access.channel.slowmodeSeconds;
    if (
      !seconds ||
      hasPermission(access.perms, Permission.MANAGE_MESSAGES) ||
      hasPermission(access.perms, Permission.MANAGE_CHANNELS)
    )
      return;
    const last = await this.prisma.message.findFirst({
      where: { channelId: access.channel.id, authorId: userId },
      orderBy: { id: 'desc' },
      select: { createdAt: true },
    });
    if (!last) return;
    const wait = Math.ceil((last.createdAt.getTime() + seconds * 1000 - Date.now()) / 1000);
    if (wait > 0)
      throw new HttpException(
        { statusCode: 429, message: 'slowmode', retryAfter: wait },
        HttpStatus.TOO_MANY_REQUESTS,
      );
  }

  private async threadEvent(tx: Tx, threadId: string, teamId: string | null): Promise<ThreadEvent> {
    const thread = await tx.thread.findUniqueOrThrow({ where: { id: threadId } });
    const root = await tx.message.findUniqueOrThrow({ where: { id: thread.rootMessageId } });
    const summary = (await this.view.dto(root, teamId, tx)).thread!;
    return { channelId: thread.channelId, thread: summary, rootMessageId: thread.rootMessageId };
  }

  // ---------------------------------------------------------------- reading

  async list(userId: string, channelId: string, q: ListMessagesQuery): Promise<MessagePageDto> {
    const access = await this.channels.textChannel(userId, channelId);
    const cutoff = hasPermission(access.perms, Permission.READ_MESSAGE_HISTORY)
      ? null
      : await this.channels.touch(userId, channelId);
    const base: Prisma.MessageWhereInput = {
      channelId,
      threadId: null,
      ...(cutoff ? { createdAt: { gte: cutoff } } : {}),
    };
    const limit = q.since !== undefined ? CHAT_LIMITS.catchUpMax : q.limit;

    let rows: Message[];
    let hasMore: boolean;
    if (q.since !== undefined) {
      rows = await this.prisma.message.findMany({
        where: { ...base, seq: { gt: BigInt(q.since) } },
        orderBy: { seq: 'asc' },
        take: limit + 1,
      });
      hasMore = rows.length > limit;
      rows = rows.slice(0, limit);
    } else if (q.after) {
      rows = await this.prisma.message.findMany({
        where: { ...base, id: { gt: q.after } },
        orderBy: { id: 'asc' },
        take: limit + 1,
      });
      hasMore = rows.length > limit;
      rows = rows.slice(0, limit);
    } else {
      rows = await this.prisma.message.findMany({
        where: { ...base, ...(q.before ? { id: { lt: q.before } } : {}) },
        orderBy: { id: 'desc' },
        take: limit + 1,
      });
      hasMore = rows.length > limit;
      rows = rows.slice(0, limit).reverse();
    }
    const lastSeq = (
      await this.prisma.channel.findUniqueOrThrow({
        where: { id: channelId },
        select: { lastSeq: true },
      })
    ).lastSeq;
    return {
      items: await this.view.dtos(rows, access.teamId),
      hasMore,
      lastSeq: lastSeq.toString(10),
    };
  }

  async pins(userId: string, channelId: string): Promise<MessageDto[]> {
    const access = await this.channels.textChannel(userId, channelId);
    const cutoff = hasPermission(access.perms, Permission.READ_MESSAGE_HISTORY)
      ? null
      : await this.channels.touch(userId, channelId);
    const rows = await this.prisma.message.findMany({
      where: {
        channelId,
        pinnedAt: { not: null },
        deletedAt: null,
        ...(cutoff ? { createdAt: { gte: cutoff } } : {}),
      },
      orderBy: { pinnedAt: 'desc' },
      take: MAX_PINS,
    });
    return this.view.dtos(rows, access.teamId);
  }

  /** Messages of the channel that contain the words (accents and case do not matter), newest first. */
  async search(userId: string, channelId: string, text: string): Promise<MessageDto[]> {
    const access = await this.channels.textChannel(userId, channelId);
    const parsed = parseSearchQuery(text);
    if (!parsed.boolean) return [];
    const cutoff = hasPermission(access.perms, Permission.READ_MESSAGE_HISTORY)
      ? null
      : await this.channels.touch(userId, channelId);
    const ids = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM Message
      WHERE channelId = ${channelId} AND deletedAt IS NULL
        AND MATCH(content) AGAINST (${parsed.boolean} IN BOOLEAN MODE)
        ${cutoff ? Prisma.sql`AND createdAt >= ${cutoff}` : Prisma.empty}
      ORDER BY id DESC LIMIT ${CHAT_LIMITS.searchMax}`);
    if (!ids.length) return [];
    const rows = await this.prisma.message.findMany({
      where: { id: { in: ids.map((r) => r.id) } },
      orderBy: { id: 'desc' },
    });
    return this.view.dtos(rows, access.teamId);
  }

  // ---------------------------------------------------------------- editing and deleting

  /** Only the author edits, and only the text. */
  async edit(userId: string, messageId: string, input: EditMessageInput): Promise<MessageDto> {
    const { message, access } = await this.messageAccess(userId, messageId);
    if (message.authorId !== userId) throw new ForbiddenException('forbidden');
    if (access.channel.archivedAt) throw new ConflictException('channel_archived');
    const attachments = await this.prisma.attachment.count({ where: { messageId } });
    if (!input.content.trim() && !attachments)
      throw new UnprocessableEntityException('empty_message');
    if (input.content === message.content) return this.view.dto(message, access.teamId);
    const mentions = await this.mentionsOf.accept(access, userId, input.content);

    return this.prisma.$transaction(async (tx) => {
      const seq = await this.nextSeq(tx, message.channelId);
      const size = bytesOf(input.content);
      const billTo = await this.channels.billingSpace(access, message.authorId, tx);
      if (billTo) await this.quota.chargeSpace(tx, billTo, size - message.sizeBytes);
      const updated = await tx.message.update({
        where: { id: messageId },
        data: {
          content: input.content,
          mentions: hasMentions(mentions) ? (mentions as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          sizeBytes: size,
          editedAt: new Date(),
          seq,
        },
      });
      const replyTo = updated.replyToId
        ? await tx.message.findUnique({ where: { id: updated.replyToId }, select: { authorId: true } })
        : null;
      await this.notifications.onMessage(
        tx,
        this.contextOf(access, updated, userId, mentions, replyTo?.authorId ?? null),
        'edited',
      );
      const dto = await this.view.dto(updated, access.teamId, tx);
      this.emitMessage(tx, updated, CHAT_EVENTS.messageUpdated, dto);
      return dto;
    });
  }

  /** The author or a moderator. What is left is a tombstone: replies can still say "message deleted". */
  async remove(userId: string, messageId: string): Promise<void> {
    const { message, access } = await this.messageAccess(userId, messageId, true);
    if (message.deletedAt) return;
    if (message.authorId !== userId && !hasPermission(access.perms, Permission.MANAGE_MESSAGES))
      throw new ForbiddenException('forbidden');

    const files = await this.prisma.$transaction(async (tx) => {
      const media = await tx.media.findMany({
        where: { attachment: { messageId } },
        select: { id: true, userId: true, size: true },
      });
      const seq = await this.nextSeq(tx, message.channelId);
      await tx.media.deleteMany({ where: { id: { in: media.map((m) => m.id) } } }); // the attachments go with them
      await tx.reaction.deleteMany({ where: { messageId } });
      await this.notifications.onDeleted(tx, messageId);
      await tx.message.update({
        where: { id: messageId },
        data: {
          content: '',
          sizeBytes: 0,
          deletedAt: new Date(),
          pinnedAt: null,
          pinnedBy: null,
          seq,
        },
      });
      const billTo = await this.channels.billingSpace(access, message.authorId, tx);
      if (billTo)
        await this.quota.chargeSpace(
          tx,
          billTo,
          -(message.sizeBytes + media.reduce((n, m) => n + m.size, 0)),
        );
      const event: MessageDeletedEvent = {
        channelId: message.channelId,
        messageId,
        seq: seq.toString(10),
      };
      const thread = message.threadId
        ? await tx.thread.findUnique({ where: { id: message.threadId } })
        : null;
      if (thread) {
        // A reply in a thread: the thread's room hears of it, and the channel that the thread has one reply fewer.
        this.events.toThread(tx, thread.id, CHAT_EVENTS.messageDeleted, event);
        await tx.message.update({ where: { id: thread.rootMessageId }, data: { seq } });
        this.events.toChannel(
          tx,
          message.channelId,
          CHAT_EVENTS.threadUpdated,
          await this.threadEvent(tx, thread.id, access.teamId),
        );
      } else this.events.toChannel(tx, message.channelId, CHAT_EVENTS.messageDeleted, event);
      return media;
    });
    await Promise.all(files.map((m) => this.storage.remove(m.userId, m.id).catch(() => undefined)));
  }

  private emitMessage(tx: Tx, message: Message, name: string, payload: unknown): void {
    if (message.threadId) this.events.toThread(tx, message.threadId, name, payload);
    else this.events.toChannel(tx, message.channelId, name, payload);
  }

  // ---------------------------------------------------------------- pins

  async pin(userId: string, messageId: string, pinned: boolean): Promise<MessageDto> {
    const { message, access } = await this.messageAccess(userId, messageId);
    // In a conversation either of the two people pins; in a channel it takes a moderator.
    if (!access.dm && !hasPermission(access.perms, Permission.MANAGE_MESSAGES))
      throw new ForbiddenException('forbidden');
    if ((message.pinnedAt !== null) === pinned) return this.view.dto(message, access.teamId);
    if (access.dm && pinned) await this.direct.assertAllowed(userId, access.dm.peerId);
    return this.prisma.$transaction(async (tx) => {
      if (
        pinned &&
        (await tx.message.count({
          where: { channelId: message.channelId, pinnedAt: { not: null } },
        })) >= MAX_PINS
      )
        throw new ConflictException('pin_limit_reached');
      const seq = await this.nextSeq(tx, message.channelId);
      const updated = await tx.message.update({
        where: { id: messageId },
        data: pinned
          ? { pinnedAt: new Date(), pinnedBy: userId, seq }
          : { pinnedAt: null, pinnedBy: null, seq },
      });
      const dto = await this.view.dto(updated, access.teamId, tx);
      this.emitMessage(
        tx,
        updated,
        pinned ? CHAT_EVENTS.messagePinned : CHAT_EVENTS.messageUnpinned,
        dto,
      );
      return dto;
    });
  }

  // ---------------------------------------------------------------- reactions

  /** One person reacts with one emoji once; doing it again changes nothing (and announces nothing). */
  async react(userId: string, messageId: string, emoji: string, on: boolean): Promise<void> {
    const { message, access } = await this.messageAccess(userId, messageId);
    if (on && !hasPermission(access.perms, Permission.ADD_REACTIONS))
      throw new ForbiddenException('forbidden');
    if (access.channel.archivedAt) throw new ConflictException('channel_archived');
    if (on && access.dm) await this.direct.assertAllowed(userId, access.dm.peerId);

    await this.prisma.$transaction(async (tx) => {
      await this.lockChannel(tx, message.channelId);
      if (on) {
        const kinds = await tx.reaction.findMany({
          where: { messageId },
          select: { emoji: true },
          distinct: ['emoji'],
        });
        if (
          kinds.length >= CHAT_LIMITS.reactionsPerMessage &&
          !kinds.some((k) => k.emoji === emoji)
        )
          throw new ConflictException('reaction_limit_reached');
        const made = await tx.reaction.createMany({
          data: [{ messageId, userId, emoji }],
          skipDuplicates: true,
        });
        if (made.count === 0) return;
      } else {
        const gone = await tx.reaction.deleteMany({ where: { messageId, userId, emoji } });
        if (gone.count === 0) return;
      }
      const seq = await this.nextSeq(tx, message.channelId);
      await tx.message.update({ where: { id: messageId }, data: { seq } });
      const event: ReactionEvent = {
        channelId: message.channelId,
        messageId,
        emoji,
        userId,
        seq: seq.toString(10),
      };
      this.emitMessage(
        tx,
        message,
        on ? CHAT_EVENTS.reactionAdded : CHAT_EVENTS.reactionRemoved,
        event,
      );
    });
  }
}
