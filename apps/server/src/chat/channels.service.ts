import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  hasPermission,
  Permission,
  permissionsToString,
  positionBetween,
  type ChannelDto,
  type ChannelOrderInput,
  type CreateChannelInput,
  type UnreadDto,
  type UpdateChannelInput,
} from '@os-planner/shared';
import { CHAT_EVENTS, CHAT_LIMITS, UNREAD_CAP } from '@os-planner/shared/chat';
import { Prisma } from '../generated/prisma/client.js';
import { newId } from '../common/crypto.js';
import type { Channel } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { QuotaService } from '../quota/quota.service.js';
import { StorageService } from '../media/storage.service.js';
import {
  PermissionService,
  type ChannelAccess,
  type ChatSpace,
} from '../spaces/permission.service.js';
import { ChatEvents } from './chat-events.js';
import type { ChatAccess } from './channel-access.js';
import { DirectAccess } from './direct-access.js';
import { NotificationService } from '../notifications/notification.service.js';

const byPosition = (
  a: Pick<Channel, 'position' | 'id'>,
  b: Pick<Channel, 'position' | 'id'>,
): number => (a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : 1);

/** The space of a channel of a team or project. A direct-message channel has none: nothing that calls this is meant for it. */
export const spaceIdOf = (c: Pick<Channel, 'spaceId'>): string => {
  if (!c.spaceId) throw new NotFoundException();
  return c.spaceId;
};

export const toChannelDto = (c: Channel, perms: bigint): ChannelDto => ({
  id: c.id,
  spaceId: spaceIdOf(c),
  parentId: c.parentId,
  kind: c.kind as ChannelDto['kind'],
  name: c.name,
  topic: c.topic,
  position: c.position,
  nsfw: c.nsfw,
  redactPreviews: c.redactPreviews,
  slowmodeSeconds: c.slowmodeSeconds,
  archived: c.archivedAt !== null,
  permissions: permissionsToString(perms),
  createdAt: c.createdAt.toISOString(),
});

/**
 * Channels and categories of a team or project. Who sees what comes from the permission engine (see
 * PermissionService.channelAccess): a channel the person cannot see is never listed and answers 404 everywhere.
 */
@Injectable()
export class ChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionService,
    private readonly events: ChatEvents,
    private readonly quota: QuotaService,
    private readonly storage: StorageService,
    private readonly direct: DirectAccess,
    private readonly notifications: NotificationService,
  ) {}

  // ---------------------------------------------------------------- reading

  private async chat(userId: string, spaceId: string): Promise<ChatSpace> {
    const chat = await this.perms.chatSpace(userId, spaceId);
    if (!chat) throw new NotFoundException();
    return chat;
  }

  /** The channels the person can see, categories that hold one (or that they can see themselves) included. */
  async list(userId: string, spaceId: string): Promise<ChannelDto[]> {
    return this.listIn(userId, await this.chat(userId, spaceId));
  }

  /**
   * Everything the person can see in a team's chat: the team's own channels and those of every project they can see,
   * in one answer (each channel says which space it is in). What the sidebar shows.
   */
  async listTeam(userId: string, teamId: string): Promise<ChannelDto[]> {
    return (await this.teamChats(userId, teamId)).flatMap(({ channels }) => channels);
  }

  private async teamChats(
    userId: string,
    teamId: string,
  ): Promise<{ chat: ChatSpace; channels: ChannelDto[] }[]> {
    const team = await this.perms.teamAccess(userId, teamId);
    if (!team) throw new NotFoundException();
    const spaces = [
      team.team.spaceId,
      ...(await this.perms.visibleProjects(userId, team)).map((v) => v.project.spaceId),
    ];
    const out: { chat: ChatSpace; channels: ChannelDto[] }[] = [];
    for (const spaceId of spaces) {
      const chat = await this.perms.chatSpace(userId, spaceId);
      if (chat) out.push({ chat, channels: await this.listIn(userId, chat) });
    }
    return out;
  }

  async unreadTeam(userId: string, teamId: string): Promise<UnreadDto[]> {
    const chats = await this.teamChats(userId, teamId);
    return (await Promise.all(chats.map(({ chat }) => this.unreadIn(userId, chat)))).flat();
  }

  private async listIn(userId: string, chat: ChatSpace): Promise<ChannelDto[]> {
    const all = await this.perms.channelsOf(userId, chat);
    const manage = hasPermission(chat.perms, Permission.MANAGE_CHANNELS);
    const seeing = new Set(
      all.filter((c) => hasPermission(c.perms, Permission.VIEW_CHANNEL)).map((c) => c.channel.id),
    );
    const parentsOfVisible = new Set(
      all
        .filter((c) => seeing.has(c.channel.id) && c.channel.parentId)
        .map((c) => c.channel.parentId!),
    );
    return all
      .filter(({ channel }) =>
        channel.kind === 'category'
          ? seeing.has(channel.id) || parentsOfVisible.has(channel.id) || manage
          : seeing.has(channel.id),
      )
      .map(({ channel, perms }) => ({ channel, perms }))
      .sort((a, b) => byPosition(a.channel, b.channel))
      .map(({ channel, perms }) => toChannelDto(channel, perms));
  }

  async get(userId: string, channelId: string): Promise<ChannelDto> {
    const access = await this.access(userId, channelId);
    return toChannelDto(access.channel, access.perms);
  }

  /** The channel if the person can see it, else 404. */
  async access(userId: string, channelId: string): Promise<ChannelAccess> {
    const access = await this.perms.channelAccess(userId, channelId);
    if (!access) throw new NotFoundException();
    return access;
  }

  /**
   * The channel the person is chatting in: a text channel they can see, or a direct-message conversation they are one of
   * the two people of. Categories and voice channels hold no messages. Everything else is 404, which is also what a hidden
   * channel answers.
   */
  async textChannel(userId: string, channelId: string): Promise<ChatAccess> {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) throw new NotFoundException();
    if (channel.kind === 'dm') return this.direct.resolve(userId, channel);
    const access = await this.access(userId, channelId);
    if (access.channel.kind !== 'text') throw new NotFoundException();
    return {
      channel: access.channel,
      perms: access.perms,
      teamId: access.chat.teamId,
      chat: access.chat,
      dm: null,
    };
  }

  /** A text channel of a team or project; a direct message is 404 (it has no threads, slowmode or overwrites). */
  async teamTextChannel(userId: string, channelId: string): Promise<ChatAccess & { chat: NonNullable<ChatAccess['chat']> }> {
    const access = await this.textChannel(userId, channelId);
    if (!access.chat) throw new NotFoundException();
    return { ...access, chat: access.chat };
  }

  /**
   * The space that stores what `personId` puts in this channel: the team's or project's for a channel, the sender's own
   * personal space for a direct message (a conversation never bills a team). Null when the person has no space any more.
   */
  async billingSpace(
    access: Pick<ChatAccess, 'channel' | 'dm'>,
    personId: string | null,
    db: PrismaService | Tx = this.prisma,
  ): Promise<string | null> {
    if (!access.dm) return access.channel.spaceId;
    if (!personId) return null;
    return (await db.space.findUnique({ where: { userId: personId }, select: { id: true } }))?.id ?? null;
  }

  /** Remembers when the person first opened the channel (people without READ_MESSAGE_HISTORY only see what comes after). */
  async touch(userId: string, channelId: string): Promise<Date> {
    await this.prisma.channelRead.createMany({
      data: [{ userId, channelId }],
      skipDuplicates: true,
    });
    const row = await this.prisma.channelRead.findUniqueOrThrow({
      where: { userId_channelId: { userId, channelId } },
    });
    return row.openedAt;
  }

  // ---------------------------------------------------------------- changing

  private async parentFor(
    db: PrismaService | Tx,
    spaceId: string,
    parentId: string | null | undefined,
    kind: string,
  ): Promise<string | null> {
    if (!parentId) return null;
    if (kind === 'category') throw new UnprocessableEntityException('category_in_category');
    const parent = await db.channel.findUnique({ where: { id: parentId } });
    if (!parent || parent.spaceId !== spaceId || parent.kind !== 'category')
      throw new UnprocessableEntityException('invalid_parent');
    return parent.id;
  }

  async create(userId: string, spaceId: string, input: CreateChannelInput): Promise<ChannelDto> {
    const chat = await this.chat(userId, spaceId);
    if (!hasPermission(chat.perms, Permission.MANAGE_CHANNELS))
      throw new ForbiddenException('forbidden');
    if (input.kind === 'voice') throw new UnprocessableEntityException('unsupported_kind');
    const id = input.id ?? newId();

    const row = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.channel.findUnique({ where: { id } });
      if (existing) {
        if (existing.spaceId !== spaceId) throw new ConflictException('id_taken');
        return existing;
      }
      if ((await tx.channel.count({ where: { spaceId } })) >= CHAT_LIMITS.channelsPerSpace)
        throw new ConflictException('channel_limit_reached');
      const parentId = await this.parentFor(tx, spaceId, input.parentId, input.kind);
      const siblings = await tx.channel.findMany({
        where: {
          spaceId,
          parentId,
          kind: input.kind === 'category' ? 'category' : { not: 'category' },
        },
        select: { id: true, position: true },
      });
      const last = siblings.sort(byPosition).at(-1)?.position ?? null;
      const created = await tx.channel.create({
        data: {
          id,
          spaceId,
          parentId,
          kind: input.kind,
          name: input.name,
          topic: input.topic ?? '',
          position: input.position ?? positionBetween(last, null),
          nsfw: input.nsfw ?? false,
          redactPreviews: input.redactPreviews ?? false,
          slowmodeSeconds: input.slowmodeSeconds ?? 0,
          createdBy: userId,
        },
      });
      this.events.channelsChanged(tx, spaceId);
      return created;
    });
    return toChannelDto(row, (await this.perms.channelAccess(userId, row.id))?.perms ?? chat.perms);
  }

  async update(userId: string, channelId: string, input: UpdateChannelInput): Promise<ChannelDto> {
    const access = await this.access(userId, channelId);
    if (!hasPermission(access.perms, Permission.MANAGE_CHANNELS))
      throw new ForbiddenException('forbidden');
    const { channel } = access;
    if (input.slowmodeSeconds !== undefined && channel.kind !== 'text')
      throw new UnprocessableEntityException('not_a_text_channel');

    const row = await this.prisma.$transaction(async (tx) => {
      const data: Prisma.ChannelUncheckedUpdateInput = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.topic !== undefined) data.topic = input.topic;
      if (input.nsfw !== undefined) data.nsfw = input.nsfw;
      if (input.redactPreviews !== undefined) data.redactPreviews = input.redactPreviews;
      if (input.slowmodeSeconds !== undefined) data.slowmodeSeconds = input.slowmodeSeconds;
      if (input.position !== undefined) data.position = input.position;
      if (input.archived !== undefined)
        data.archivedAt = input.archived ? (channel.archivedAt ?? new Date()) : null;
      if (input.parentId !== undefined)
        data.parentId = await this.parentFor(tx, spaceIdOf(channel), input.parentId, channel.kind);
      const updated = await tx.channel.update({ where: { id: channelId }, data });
      this.events.toChannel(tx, channelId, CHAT_EVENTS.channelUpdated, {
        channelId,
        spaceId: spaceIdOf(channel),
        deleted: false,
      });
      this.events.channelsChanged(tx, spaceIdOf(channel));
      return updated;
    });
    return toChannelDto(
      row,
      (await this.perms.channelAccess(userId, channelId))?.perms ?? access.perms,
    );
  }

  /** Several moves at once (drag and drop in the sidebar): each item gets its new category and position. */
  async reorder(userId: string, spaceId: string, input: ChannelOrderInput): Promise<void> {
    const chat = await this.chat(userId, spaceId);
    if (!hasPermission(chat.perms, Permission.MANAGE_CHANNELS))
      throw new ForbiddenException('forbidden');
    await this.prisma.$transaction(async (tx) => {
      const channels = new Map(
        (await tx.channel.findMany({ where: { spaceId } })).map((c) => [c.id, c]),
      );
      for (const item of input.items) {
        const channel = channels.get(item.id);
        if (!channel) throw new NotFoundException();
        const parentId = await this.parentFor(tx, spaceId, item.parentId, channel.kind);
        await tx.channel.update({
          where: { id: item.id },
          data: { parentId, position: item.position },
        });
      }
      this.events.channelsChanged(tx, spaceId);
    });
  }

  /**
   * Deletes the channel with its messages, reactions, threads and files; the space gets the bytes back. Channels inside a
   * deleted category stay, without a category.
   */
  async remove(userId: string, channelId: string): Promise<void> {
    const access = await this.access(userId, channelId);
    if (!hasPermission(access.perms, Permission.MANAGE_CHANNELS))
      throw new ForbiddenException('forbidden');
    const { channel } = access;

    const files = await this.prisma.$transaction(async (tx) => {
      const media = await tx.media.findMany({
        where: { attachment: { channelId } },
        select: { id: true, userId: true, size: true },
      });
      const text = await tx.message.aggregate({ where: { channelId }, _sum: { sizeBytes: true } });
      const freed = media.reduce((n, m) => n + m.size, 0) + (text._sum.sizeBytes ?? 0);
      await tx.media.deleteMany({ where: { id: { in: media.map((m) => m.id) } } }); // takes the attachments with it
      await tx.overwrite.deleteMany({ where: { targetKind: 'channel', targetId: channelId } });
      await tx.channel.delete({ where: { id: channelId } }); // messages, reactions, threads and read marks cascade
      await this.quota.chargeSpace(tx, spaceIdOf(channel), -freed);
      this.events.toChannel(tx, channelId, CHAT_EVENTS.channelUpdated, {
        channelId,
        spaceId: spaceIdOf(channel),
        deleted: true,
      });
      this.events.channelsChanged(tx, spaceIdOf(channel));
      return media;
    });
    await Promise.all(files.map((m) => this.storage.remove(m.userId, m.id).catch(() => undefined)));
  }

  // ---------------------------------------------------------------- reading state

  /** Messages by other people the person has not read, per channel they can see (capped: "99+"). */
  async unread(userId: string, spaceId: string): Promise<UnreadDto[]> {
    return this.unreadIn(userId, await this.chat(userId, spaceId));
  }

  private async unreadIn(userId: string, chat: ChatSpace): Promise<UnreadDto[]> {
    const visible = (await this.perms.channelsOf(userId, chat))
      .filter(
        ({ channel, perms }) =>
          channel.kind === 'text' && hasPermission(perms, Permission.VIEW_CHANNEL),
      )
      .map(({ channel }) => channel.id);
    if (!visible.length) return [];
    // A channel the person never opened only counts what was said since they joined the team: a new member does not start with "99+".
    const joined =
      (
        await this.prisma.teamMember.findUnique({
          where: { teamId_userId: { teamId: chat.teamId, userId } },
          select: { joinedAt: true },
        })
      )?.joinedAt ?? new Date(0);
    return this.unreadCounts(userId, visible, joined);
  }

  /**
   * Unread messages (by other people, not in threads, not deleted) in each of these channels, which the person is already
   * known to be allowed to see. In a channel they never opened, only messages from `since` on count.
   */
  async unreadCounts(userId: string, channelIds: string[], since: Date): Promise<UnreadDto[]> {
    if (!channelIds.length) return [];
    const reads = await this.prisma.channelRead.findMany({
      where: { userId, channelId: { in: channelIds } },
    });
    const readBy = new Map(reads.map((r) => [r.channelId, r]));
    const rows = await this.prisma.$queryRaw<{ channelId: string; n: bigint }[]>(Prisma.sql`
      SELECT m.channelId AS channelId, COUNT(*) AS n
      FROM Message m
      LEFT JOIN ChannelRead r ON r.channelId = m.channelId AND r.userId = ${userId}
      WHERE m.channelId IN (${Prisma.join(channelIds)})
        AND m.threadId IS NULL AND m.deletedAt IS NULL
        AND (m.authorId IS NULL OR m.authorId <> ${userId})
        AND (r.lastReadMessageId IS NULL OR m.id > r.lastReadMessageId)
        AND (r.userId IS NOT NULL OR m.createdAt >= ${since})
      GROUP BY m.channelId`);
    const counts = new Map(rows.map((r) => [r.channelId, Math.min(Number(r.n), UNREAD_CAP + 1)]));
    const mentions = await this.notifications.mentionCounts(userId, channelIds);
    return channelIds.map((channelId) => ({
      channelId,
      unread: counts.get(channelId) ?? 0,
      mentions: Math.min(mentions.get(channelId) ?? 0, UNREAD_CAP + 1),
      lastReadMessageId: readBy.get(channelId)?.lastReadMessageId ?? null,
    }));
  }

  /** Moves the person's read mark forward to `messageId` (never back). */
  async markRead(userId: string, channelId: string, messageId: string): Promise<void> {
    await this.textChannel(userId, channelId);
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: { channelId: true },
    });
    if (!message || message.channelId !== channelId) throw new NotFoundException();
    await this.touch(userId, channelId);
    await this.prisma.channelRead.updateMany({
      where: {
        userId,
        channelId,
        OR: [{ lastReadMessageId: null }, { lastReadMessageId: { lt: messageId } }],
      },
      data: { lastReadMessageId: messageId },
    });
    // what that read notified them about is read too
    await this.notifications.onChannelRead(userId, channelId, messageId);
  }
}
