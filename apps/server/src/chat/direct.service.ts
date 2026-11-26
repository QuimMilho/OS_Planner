import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  SERVER_EVENTS,
  type BlockDto,
  type DmDto,
  type DmPersonDto,
  type DmUpdatedEvent,
} from '@os-planner/shared';
import { DM_LIMITS, DM_NOT_ALLOWED } from '@os-planner/shared/chat';
import { newId } from '../common/crypto.js';
import type { DirectConversation } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import type { DmContext } from './channel-access.js';
import { ChannelsService } from './channels.service.js';
import { ChatEvents } from './chat-events.js';
import { snippet } from './message-view.js';

const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';

/** The two ids of a pair in the order they are stored (the smaller first), so a pair has one row whoever starts it. */
export const orderedPair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

/**
 * Direct messages: who may write to whom, the person's list of conversations, closing and blocking.
 *
 * A conversation exists for two people who share a team. It stays readable for both of them for ever; whether either may
 * *write* is decided again on every send (see `assertAllowed`), and every refusal looks the same (`403 dm_not_allowed`), so
 * nobody can find out whether another person blocked them or switched direct messages off.
 */
@Injectable()
export class DirectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelsService,
    private readonly events: ChatEvents,
  ) {}

  // ---------------------------------------------------------------- the rules

  /**
   * May `senderId` write to `recipientId` right now? Both accounts exist, neither blocked the other, the recipient accepts
   * direct messages from people who share a team with them, and at least one team they share allows it.
   */
  async allowed(senderId: string, recipientId: string | null): Promise<boolean> {
    if (!recipientId || senderId === recipientId) return false;
    const [recipient, sender, blocked] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: recipientId }, select: { allowDMsFrom: true } }),
      this.prisma.user.findUnique({ where: { id: senderId }, select: { id: true } }),
      this.prisma.userBlock.findFirst({
        where: {
          OR: [
            { blockerId: senderId, blockedId: recipientId },
            { blockerId: recipientId, blockedId: senderId },
          ],
        },
        select: { blockerId: true },
      }),
    ]);
    if (!recipient || !sender || blocked || recipient.allowDMsFrom === 'nobody') return false;
    const shared = await this.prisma.teamMember.findFirst({
      where: {
        userId: senderId,
        team: {
          deletedAt: null,
          allowMemberDMs: true,
          members: { some: { userId: recipientId } },
        },
      },
      select: { teamId: true },
    });
    return shared !== null;
  }

  /** Throws the one neutral refusal when the person may not write to the other one. */
  async assertAllowed(senderId: string, recipientId: string | null): Promise<void> {
    if (!(await this.allowed(senderId, recipientId))) throw new ForbiddenException(DM_NOT_ALLOWED);
  }

  // ---------------------------------------------------------------- the list

  private async dtos(
    userId: string,
    rows: (DirectConversation & { states: { closedAt: Date | null }[] })[],
  ): Promise<DmDto[]> {
    if (!rows.length) return [];
    const peerOf = (c: DirectConversation): string | null =>
      c.userA === userId ? c.userB : c.userA;
    const peerIds = [...new Set(rows.map(peerOf).filter((v): v is string => v !== null))];
    const channelIds = rows.map((c) => c.channelId);

    const [users, blocks, unread, lastIds, shared] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: peerIds } },
        select: { id: true, displayName: true },
      }),
      this.prisma.userBlock.findMany({
        where: { blockerId: userId, blockedId: { in: peerIds } },
        select: { blockedId: true },
      }),
      this.channels.unreadCounts(userId, channelIds, new Date(0)),
      this.prisma.message.groupBy({
        by: ['channelId'],
        where: { channelId: { in: channelIds }, threadId: null },
        _max: { id: true },
      }),
      this.prisma.teamMember.findMany({
        where: {
          userId: { in: peerIds },
          team: { deletedAt: null, members: { some: { userId } } },
        },
        select: { userId: true, team: { select: { id: true, name: true } } },
      }),
    ]);
    const sharedBy = new Map<string, { id: string; name: string }[]>();
    for (const s of shared)
      (sharedBy.get(s.userId) ?? sharedBy.set(s.userId, []).get(s.userId)!).push(s.team);
    const last = lastIds.length
      ? await this.prisma.message.findMany({
          where: { id: { in: lastIds.map((l) => l._max.id!).filter(Boolean) } },
          include: { _count: { select: { attachments: true } } },
        })
      : [];
    const name = new Map(users.map((u) => [u.id, u.displayName]));
    const blocked = new Set(blocks.map((b) => b.blockedId));
    const unreadBy = new Map(unread.map((u) => [u.channelId, u]));
    const lastBy = new Map(last.map((m) => [m.channelId, m]));

    return rows.map((c) => {
      const peerId = peerOf(c);
      const m = lastBy.get(c.channelId);
      const u = unreadBy.get(c.channelId);
      return {
        id: c.id,
        channelId: c.channelId,
        peer: peerId && name.has(peerId) ? { id: peerId, displayName: name.get(peerId)! } : null,
        lastMessage: m
          ? {
              id: m.id,
              authorId: m.authorId,
              snippet: m.deletedAt ? null : snippet(m.content),
              deleted: m.deletedAt !== null,
              hasAttachments: m._count.attachments > 0,
              createdAt: m.createdAt.toISOString(),
            }
          : null,
        lastMessageAt: c.lastMessageAt.toISOString(),
        unread: u?.unread ?? 0,
        lastReadMessageId: u?.lastReadMessageId ?? null,
        closed: c.states[0]?.closedAt != null,
        blocked: peerId !== null && blocked.has(peerId),
        sharedTeams: peerId ? (sharedBy.get(peerId) ?? []) : [],
        createdAt: c.createdAt.toISOString(),
      };
    });
  }

  private mine(userId: string) {
    return { OR: [{ userA: userId }, { userB: userId }] };
  }

  /** The person's conversations, most recent first. Closed ones are left out unless asked for. */
  async list(userId: string, withClosed = false): Promise<DmDto[]> {
    const rows = await this.prisma.directConversation.findMany({
      where: {
        ...this.mine(userId),
        ...(withClosed ? {} : { NOT: { states: { some: { userId, closedAt: { not: null } } } } }),
      },
      include: { states: { where: { userId }, select: { closedAt: true } } },
      orderBy: { lastMessageAt: 'desc' },
      take: DM_LIMITS.listMax,
    });
    return this.dtos(userId, rows);
  }

  /** One conversation, if the person is one of its two people (else 404). */
  async get(userId: string, conversationId: string): Promise<DmDto> {
    const row = await this.prisma.directConversation.findFirst({
      where: { id: conversationId, ...this.mine(userId) },
      include: { states: { where: { userId }, select: { closedAt: true } } },
    });
    if (!row) throw new NotFoundException();
    return (await this.dtos(userId, [row]))[0]!;
  }

  // ---------------------------------------------------------------- starting, closing

  /** The conversation with that person, made if it does not exist yet (and shown again if the person had closed it). */
  async start(userId: string, otherId: string): Promise<DmDto> {
    await this.assertAllowed(userId, otherId);
    const [userA, userB] = orderedPair(userId, otherId);

    const find = () =>
      this.prisma.directConversation.findUnique({ where: { userA_userB: { userA, userB } } });
    let conversation = await find();
    if (!conversation) {
      try {
        conversation = await this.prisma.$transaction(async (tx) => {
          const channelId = newId();
          await tx.channel.create({
            data: {
              id: channelId,
              spaceId: null,
              kind: 'dm',
              name: '',
              position: 'a0',
              createdBy: userId,
            },
          });
          const created = await tx.directConversation.create({
            data: { id: newId(), userA, userB, channelId },
          });
          this.announce(tx, created, [userId]);
          return created;
        });
      } catch (e) {
        // Both people starting at the same moment: the unique pair lets one of them win.
        if (!isUniqueViolation(e)) throw e;
        conversation = await find();
        if (!conversation) throw e;
      }
    }
    await this.setClosed(userId, conversation, false);
    return this.get(userId, conversation.id);
  }

  private async conversationOf(
    userId: string,
    conversationId: string,
  ): Promise<DirectConversation> {
    const row = await this.prisma.directConversation.findFirst({
      where: { id: conversationId, ...this.mine(userId) },
    });
    if (!row) throw new NotFoundException();
    return row;
  }

  /** Hides (or shows) the conversation in the person's list. Nothing is deleted: a new message brings it back. */
  async setClosed(
    userId: string,
    conversation: DirectConversation,
    closed: boolean,
  ): Promise<void> {
    const state = await this.prisma.directState.findUnique({
      where: { conversationId_userId: { conversationId: conversation.id, userId } },
    });
    if (closed === (state?.closedAt != null)) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.directState.upsert({
        where: { conversationId_userId: { conversationId: conversation.id, userId } },
        create: { conversationId: conversation.id, userId, closedAt: closed ? new Date() : null },
        update: { closedAt: closed ? new Date() : null },
      });
      this.announce(tx, conversation, [userId]);
    });
  }

  async close(userId: string, conversationId: string, closed: boolean): Promise<DmDto> {
    await this.setClosed(userId, await this.conversationOf(userId, conversationId), closed);
    return this.get(userId, conversationId);
  }

  /** Tells these people (all their devices) that the conversation changed: they ask for the list again. */
  private announce(tx: Tx, conversation: DirectConversation, userIds: (string | null)[]): void {
    const event: DmUpdatedEvent = {
      conversationId: conversation.id,
      channelId: conversation.channelId,
    };
    for (const id of new Set(userIds))
      if (id) this.events.toUser(tx, id, SERVER_EVENTS.dmUpdated, event);
  }

  /**
   * A message was sent in the conversation (inside the sender's transaction): it moves up the list, comes back for
   * anyone who had closed it, and both people are told.
   */
  async onMessage(tx: Tx, dm: DmContext, at: Date): Promise<void> {
    await tx.directConversation.update({
      where: { id: dm.conversation.id },
      data: { lastMessageAt: at },
    });
    await tx.directState.updateMany({
      where: { conversationId: dm.conversation.id, closedAt: { not: null } },
      data: { closedAt: null },
    });
    this.announce(tx, dm.conversation, [dm.conversation.userA, dm.conversation.userB]);
  }

  // ---------------------------------------------------------------- the picker

  /** People the person may start a conversation with: members of their teams that allow it. Searchable by name. */
  async people(userId: string, q: string): Promise<DmPersonDto[]> {
    const mine = { deletedAt: null, allowMemberDMs: true, members: { some: { userId } } };
    const users = await this.prisma.user.findMany({
      where: {
        id: { not: userId },
        ...(q ? { displayName: { contains: q } } : {}),
        blockedBy: { none: { blockerId: userId } },
        teamMemberships: { some: { team: mine } },
      },
      select: { id: true, displayName: true },
      orderBy: { displayName: 'asc' },
      take: DM_LIMITS.peopleMax,
    });
    if (!users.length) return [];
    const memberships = await this.prisma.teamMember.findMany({
      where: { userId: { in: users.map((u) => u.id) }, team: mine },
      select: { userId: true, team: { select: { name: true } } },
    });
    const teams = new Map<string, string[]>();
    for (const m of memberships)
      (teams.get(m.userId) ?? teams.set(m.userId, []).get(m.userId)!).push(m.team.name);
    return users.map((u) => ({
      userId: u.id,
      displayName: u.displayName,
      teams: teams.get(u.id) ?? [],
    }));
  }

  // ---------------------------------------------------------------- blocks

  async blocks(userId: string): Promise<BlockDto[]> {
    const rows = await this.prisma.userBlock.findMany({
      where: { blockerId: userId },
      include: { blocked: { select: { displayName: true } } },
      orderBy: { createdAt: 'desc' },
      take: DM_LIMITS.blocksMax,
    });
    return rows.map((b) => ({
      userId: b.blockedId,
      displayName: b.blocked.displayName,
      createdAt: b.createdAt.toISOString(),
    }));
  }

  /** Blocks the person: neither can write to the other any more (history stays). Blocking twice changes nothing. */
  async block(userId: string, targetId: string, on: boolean): Promise<void> {
    if (userId === targetId) throw new UnprocessableEntityException('cannot_block_self');
    if (on) {
      if (!(await this.prisma.user.findUnique({ where: { id: targetId }, select: { id: true } })))
        throw new NotFoundException();
      if (
        (await this.prisma.userBlock.count({ where: { blockerId: userId } })) >= DM_LIMITS.blocksMax
      )
        throw new UnprocessableEntityException('block_limit_reached');
      await this.prisma.userBlock.createMany({
        data: [{ blockerId: userId, blockedId: targetId }],
        skipDuplicates: true,
      });
    } else {
      await this.prisma.userBlock.deleteMany({ where: { blockerId: userId, blockedId: targetId } });
    }
    const [userA, userB] = orderedPair(userId, targetId);
    const conversation = await this.prisma.directConversation.findUnique({
      where: { userA_userB: { userA, userB } },
    });
    // Only the person who blocked is told: the other one is never shown that they were blocked.
    if (conversation)
      await this.prisma.$transaction(async (tx) => this.announce(tx, conversation, [userId]));
  }
}
