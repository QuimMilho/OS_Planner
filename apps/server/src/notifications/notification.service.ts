import { Injectable, Logger } from '@nestjs/common';
import {
  hasPermission,
  Permission,
  type MentionsDto,
  type NotificationCountDto,
  type NotificationDto,
  type NotificationKind,
  type NotificationPageDto,
  type NotificationReadEvent,
  type PushPayload,
  type ListNotificationsQuery,
  type ReadNotificationsInput,
} from '@os-planner/shared';
import {
  chatMarkdownToText,
  MENTION_KINDS_OF_NOTIFICATIONS,
  NOTIFY_EVENTS,
  NOTIFY_LIMITS,
  resolveSetting,
  shouldEmail,
  shouldNotify,
  strongest,
  type Effective,
  type NotifyType,
} from '@os-planner/shared/chat';
import { newId } from '../common/crypto.js';
import { EventBus } from '../events/event-bus.js';
import type { Channel, Message } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { PresenceService } from '../realtime/presence.service.js';
import { PermissionService } from '../spaces/permission.service.js';
import { copyFor } from './copy.js';
import { DigestService } from './digest.service.js';
import { PushService } from './push.service.js';
import { defaultsFor, NotificationSettingsService, type ScopeRef } from './settings.service.js';
import { ENV, type Env } from '../config/env.js';
import { Inject } from '@nestjs/common';

/** What the planner needs to know about a message that was just written (or edited). */
export interface MessageContext {
  message: Message;
  channel: Channel;
  /** The team the channel belongs to (null in a conversation). */
  teamId: string | null;
  /** Set in a conversation. */
  dm: { conversationId: string; peerId: string | null } | null;
  authorId: string;
  mentions: MentionsDto;
  replyToAuthorId: string | null;
}

const MENTION_KIND_SET = new Set<string>(MENTION_KINDS_OF_NOTIFICATIONS);
const SUMMARY_MAX = 200;
const ALL_CANDIDATES_MAX = 2000;

const KIND_OF: Record<Exclude<NotifyType, 'message'>, NotificationKind> = {
  direct: 'mention_user',
  role: 'mention_role',
  everyone: 'mention_everyone',
  here: 'mention_here',
};

interface Planned {
  userId: string;
  kind: NotificationKind;
  type: NotifyType;
  eff: Effective;
  /** Becomes a row in the inbox (an ordinary message in a channel only gets a push or an email). */
  inbox: boolean;
  push: boolean;
  email: boolean;
}

/**
 * Who is told about a message, and how. A pure decision (`@os-planner/shared`'s settings rules) fed with facts read here:
 * who was mentioned, who can see the channel, what each person asked for.
 *
 * The inbox rows are written in the transaction of the message, so a message and its notifications exist or not together.
 * After the commit people hear about them live; push goes to their devices and email waits for the digest sweep.
 */
@Injectable()
export class NotificationService {
  private readonly log = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionService,
    private readonly settings: NotificationSettingsService,
    private readonly presence: PresenceService,
    private readonly bus: EventBus,
    private readonly push: PushService,
    private readonly digest: DigestService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ---------------------------------------------------------------- planning

  /**
   * A message was sent (`created`) or its text changed (`edited`). On an edit only what is new is told (a mention added), and
   * a mention that was taken out of the text takes its notification with it.
   */
  async onMessage(
    tx: Tx,
    ctx: MessageContext,
    mode: 'created' | 'edited' = 'created',
  ): Promise<void> {
    const { planned, mentioned } = ctx.dm
      ? await this.planConversation(tx, ctx)
      : await this.planChannel(tx, ctx);
    const existing =
      mode === 'edited'
        ? await tx.notification.findMany({
            where: { messageId: ctx.message.id },
            select: { id: true, userId: true },
          })
        : [];
    const had = new Set(existing.map((e) => e.userId));
    // A notification goes when its person is no longer mentioned (not when they have since muted the chat: it was theirs).
    const gone = existing.filter((e) => !mentioned.has(e.userId));
    if (gone.length) {
      await tx.notification.deleteMany({ where: { id: { in: gone.map((g) => g.id) } } });
      for (const g of gone) this.tellRead(tx, g.userId, { ids: [g.id], all: false });
    }
    const fresh = planned.filter((p) => !had.has(p.userId));
    if (!fresh.length) return;

    const text = await this.summaryOf(tx, ctx);
    const redacted = ctx.channel.redactPreviews || ctx.channel.nsfw;
    const author = await tx.user.findUnique({
      where: { id: ctx.authorId },
      select: { displayName: true },
    });
    const actorName = author?.displayName ?? null;
    // A message that was already read (an old one that gained a mention when it was edited) is added as read.
    const reads =
      mode === 'edited'
        ? new Map(
            (
              await tx.channelRead.findMany({
                where: { channelId: ctx.channel.id, userId: { in: fresh.map((p) => p.userId) } },
                select: { userId: true, lastReadMessageId: true },
              })
            ).map((r) => [r.userId, r.lastReadMessageId]),
          )
        : new Map<string, string | null>();
    const place = ctx.dm
      ? { targetKind: 'dm', targetId: ctx.dm.conversationId }
      : { targetKind: 'team', targetId: ctx.teamId };

    for (const p of fresh) {
      if (p.inbox) {
        const lastRead = reads.get(p.userId);
        const alreadyRead = Boolean(lastRead && lastRead >= ctx.message.id);
        const row = await tx.notification.create({
          data: {
            id: newId(),
            userId: p.userId,
            kind: p.kind,
            actorId: ctx.authorId,
            spaceId: ctx.channel.spaceId,
            channelId: ctx.channel.id,
            messageId: ctx.message.id,
            ...place,
            summary: redacted ? '' : text,
            redacted,
            readAt: alreadyRead ? new Date() : null,
          },
        });
        const dto: NotificationDto = {
          id: row.id,
          kind: p.kind,
          actorId: ctx.authorId,
          actorName,
          teamId: ctx.teamId,
          channelId: ctx.channel.id,
          channelName: ctx.dm ? null : ctx.channel.name,
          messageId: ctx.message.id,
          targetKind: row.targetKind,
          targetId: row.targetId,
          summary: row.summary,
          redacted,
          read: alreadyRead,
          createdAt: row.createdAt.toISOString(),
        };
        if (!alreadyRead)
          this.bus.publishAfterCommit(tx, 'room.event', {
            rooms: [`user:${p.userId}`],
            name: NOTIFY_EVENTS.created,
            payload: dto,
          });
      }
      if (p.email)
        await this.digest.queue(
          tx,
          p.userId,
          ctx.dm ? 'dm' : 'channel',
          ctx.dm ? ctx.dm.conversationId : ctx.channel.id,
          ctx.message.id,
        );
      if (p.push && p.eff.push)
        this.prisma.afterCommit(tx, () => {
          void this.pushTo(p.userId, ctx, p.kind, redacted ? null : text, actorName);
        });
    }
  }

  private async pushTo(
    userId: string,
    ctx: MessageContext,
    kind: NotificationKind | 'message',
    text: string | null,
    actorName: string | null,
  ): Promise<void> {
    const team = ctx.teamId
      ? ((await this.prisma.team.findUnique({ where: { id: ctx.teamId }, select: { name: true } }))
          ?.name ?? '')
      : '';
    const url = `${this.env.APP_URL.replace(/\/+$/, '')}${ctx.dm ? `/app/dm/${ctx.dm.conversationId}` : `/app/c/${ctx.channel.id}`}`;
    await this.push.notify(userId, ctx.channel.id, (locale): PushPayload => {
      const c = copyFor(locale);
      const actor = actorName ?? c.deletedUser;
      return {
        notification: {
          title: ctx.dm ? actor : c.pushTitleChannel(ctx.channel.name, team),
          body:
            text === null || text === ''
              ? c.redacted(actor, kind)
              : ctx.dm
                ? text
                : `${actor}: ${text}`,
          icon: `${this.env.APP_URL.replace(/\/+$/, '')}/icons/icon-192x192.png`,
          tag: ctx.channel.id,
          data: {
            url,
            kind,
            onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url } },
          },
        },
      };
    });
  }

  /** The text of the message for the inbox and push: names instead of tokens, one short line. */
  private async summaryOf(tx: Tx, ctx: MessageContext): Promise<string> {
    const [users, roles] = await Promise.all([
      ctx.mentions.users.length
        ? tx.user.findMany({
            where: { id: { in: ctx.mentions.users } },
            select: { id: true, displayName: true },
          })
        : [],
      ctx.mentions.roles.length
        ? tx.role.findMany({
            where: { id: { in: ctx.mentions.roles } },
            select: { id: true, name: true },
          })
        : [],
    ]);
    const names = new Map<string, string>([
      ...users.map((u): [string, string] => [u.id, u.displayName]),
      ...roles.map((r): [string, string] => [r.id, r.name]),
    ]);
    const text = chatMarkdownToText(ctx.message.content, (_k, id) =>
      id ? names.get(id) : undefined,
    );
    const withFiles =
      !text && (await tx.attachment.count({ where: { messageId: ctx.message.id } })) > 0;
    const out = text || (withFiles ? '📎' : '');
    return out.length > SUMMARY_MAX ? `${out.slice(0, SUMMARY_MAX)}…` : out;
  }

  // ---------------------------------------------------------------- who, in a team's channel

  private async planChannel(
    tx: Tx,
    ctx: MessageContext,
  ): Promise<{ planned: Planned[]; mentioned: Set<string> }> {
    const { channel, authorId, mentions } = ctx;
    const types = new Map<string, Set<NotifyType>>();
    const add = (id: string, t: NotifyType): void =>
      void (types.get(id) ?? types.set(id, new Set()).get(id)!).add(t);
    for (const id of mentions.users) add(id, 'direct');
    if (ctx.replyToAuthorId) add(ctx.replyToAuthorId, 'direct');
    if (mentions.roles.length) {
      const held = await tx.memberRole.findMany({
        where: { roleId: { in: mentions.roles } },
        select: { userId: true },
      });
      for (const h of held) add(h.userId, 'role');
    }
    if (mentions.everyone && ctx.teamId) {
      for (const m of await tx.teamMember.findMany({
        where: { teamId: ctx.teamId },
        select: { userId: true },
      }))
        add(m.userId, 'everyone');
    }
    if (mentions.here && ctx.teamId) {
      for (const p of await this.presence.teamSnapshot(ctx.teamId))
        if (p.status === 'online') add(p.userId, 'here');
    }

    const chain = await this.settings.chainForChannel(channel);
    // People who asked for every message (a push or a mail per message) are candidates too.
    const wantsAll = await tx.notificationSetting.findMany({
      where: {
        userId: { not: authorId },
        OR: [{ level: 'all' }, { email: 'all' }],
        AND: [
          {
            OR: chain.map((s: ScopeRef) => ({ scopeKind: s.scopeKind, scopeId: s.scopeId ?? '' })),
          },
        ],
      },
      select: { userId: true },
      distinct: ['userId'],
      take: ALL_CANDIDATES_MAX,
    });
    const allCandidates = new Set(wantsAll.map((w) => w.userId));

    const candidates = new Set([...types.keys(), ...allCandidates]);
    candidates.delete(authorId);
    const mentioned = new Set(types.keys());
    if (!candidates.size) return { planned: [], mentioned };
    const viewers = await this.perms.channelViewers(channel, [...candidates], tx);
    // Somebody who blocked the author hears nothing from them.
    const blockers = new Set(
      (
        await tx.userBlock.findMany({
          where: { blockerId: { in: [...viewers] }, blockedId: authorId },
          select: { blockerId: true },
        })
      ).map((b) => b.blockerId),
    );
    const people = [...viewers].filter((id) => !blockers.has(id));
    const rules = await this.settings.rulesFor(people, chain);
    const now = Date.now();

    const out: Planned[] = [];
    for (const userId of people) {
      const eff = resolveSetting(rules.get(userId) ?? [], now, defaultsFor('channel'));
      const wanted = types.get(userId);
      const strong = wanted ? strongest(eff, wanted) : null;
      if (strong && strong !== 'message') {
        const replyOnly = strong === 'direct' && !mentions.users.includes(userId);
        out.push({
          userId,
          kind: replyOnly ? 'reply' : KIND_OF[strong],
          type: strong,
          eff,
          inbox: true,
          push: true,
          email: shouldEmail(eff, strong),
        });
      } else if (allCandidates.has(userId) && shouldNotify(eff, 'message')) {
        // an ordinary message for somebody who asked for all of them: a push (and maybe a mail), no inbox row
        out.push({
          userId,
          kind: 'mention_user',
          type: 'message',
          eff,
          inbox: false,
          push: true,
          email: shouldEmail(eff, 'message'),
        });
      } else if (allCandidates.has(userId) && shouldEmail(eff, 'message')) {
        out.push({
          userId,
          kind: 'mention_user',
          type: 'message',
          eff,
          inbox: false,
          push: false,
          email: true,
        });
      }
    }
    return { planned: out, mentioned };
  }

  // ---------------------------------------------------------------- who, in a conversation

  private async planConversation(
    tx: Tx,
    ctx: MessageContext,
  ): Promise<{ planned: Planned[]; mentioned: Set<string> }> {
    const peer = ctx.dm?.peerId;
    if (!peer || peer === ctx.authorId) return { planned: [], mentioned: new Set() };
    const chain: ScopeRef[] = await this.settings.chainOf('dm', ctx.dm!.conversationId);
    const rules = (await this.settings.rulesFor([peer], chain)).get(peer) ?? [];
    const eff = resolveSetting(rules, Date.now(), defaultsFor('dm'));
    const inbox = shouldNotify(eff, 'message');
    const email = shouldEmail(eff, 'message');
    return {
      planned:
        inbox || email
          ? [{ userId: peer, kind: 'dm', type: 'message', eff, inbox, push: inbox, email }]
          : [],
      mentioned: new Set([peer]),
    };
  }

  // ---------------------------------------------------------------- when the message goes away or is read

  /** The message was deleted: nobody should still be told about it. */
  async onDeleted(tx: Tx, messageId: string): Promise<void> {
    const rows = await tx.notification.findMany({
      where: { messageId },
      select: { id: true, userId: true },
    });
    if (rows.length) await tx.notification.deleteMany({ where: { messageId } });
    const by = new Map<string, string[]>();
    for (const r of rows) (by.get(r.userId) ?? by.set(r.userId, []).get(r.userId)!).push(r.id);
    for (const [userId, ids] of by) this.tellRead(tx, userId, { ids, all: false });
    await this.digest.forget(tx, messageId);
  }

  /** The person read a channel up to a message: what it notified them about is read too. */
  async onChannelRead(userId: string, channelId: string, upToMessageId: string): Promise<void> {
    const rows = await this.prisma.notification.findMany({
      where: { userId, channelId, readAt: null, messageId: { lte: upToMessageId } },
      select: { id: true },
    });
    if (!rows.length) return;
    await this.prisma.notification.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { readAt: new Date() },
    });
    await this.bus.publish('room.event', {
      rooms: [`user:${userId}`],
      name: NOTIFY_EVENTS.read,
      payload: { ids: rows.map((r) => r.id), all: false } satisfies NotificationReadEvent,
    });
  }

  private tellRead(tx: Tx, userId: string, event: NotificationReadEvent): void {
    this.bus.publishAfterCommit(tx, 'room.event', {
      rooms: [`user:${userId}`],
      name: NOTIFY_EVENTS.read,
      payload: event,
    });
  }

  // ---------------------------------------------------------------- unread mention counts

  /** Mentions (and replies) the person has not read, per channel. */
  async mentionCounts(userId: string, channelIds: readonly string[]): Promise<Map<string, number>> {
    if (!channelIds.length) return new Map();
    const rows = await this.prisma.notification.groupBy({
      by: ['channelId'],
      where: {
        userId,
        readAt: null,
        channelId: { in: [...channelIds] },
        kind: { in: [...MENTION_KIND_SET] },
      },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.channelId!, r._count._all]));
  }

  // ---------------------------------------------------------------- the inbox

  /** Which of these channels the person can still see (a conversation: is one of its two people). */
  private async visibleChannels(
    userId: string,
    ids: readonly string[],
  ): Promise<Map<string, { name: string; dm: boolean }>> {
    const out = new Map<string, { name: string; dm: boolean }>();
    if (!ids.length) return out;
    const channels = await this.prisma.channel.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, name: true, kind: true },
    });
    const dmIds = channels.filter((c) => c.kind === 'dm').map((c) => c.id);
    const mine = dmIds.length
      ? new Set(
          (
            await this.prisma.directConversation.findMany({
              where: { channelId: { in: dmIds }, OR: [{ userA: userId }, { userB: userId }] },
              select: { channelId: true },
            })
          ).map((d) => d.channelId),
        )
      : new Set<string>();
    await Promise.all(
      channels.map(async (c) => {
        if (c.kind === 'dm') {
          if (mine.has(c.id)) out.set(c.id, { name: '', dm: true });
        } else if (await this.perms.channelAccess(userId, c.id))
          out.set(c.id, { name: c.name, dm: false });
      }),
    );
    return out;
  }

  async list(userId: string, q: ListNotificationsQuery): Promise<NotificationPageDto> {
    let cursor: { at: Date; id: string } | null = null;
    if (q.cursor) {
      const [iso, id] = Buffer.from(q.cursor, 'base64url').toString('utf8').split('|');
      const at = new Date(iso ?? '');
      if (id && !Number.isNaN(at.getTime())) cursor = { at, id };
    }
    const rows = await this.prisma.notification.findMany({
      where: {
        userId,
        ...(q.unread ? { readAt: null } : {}),
        ...(q.mentions ? { kind: { in: [...MENTION_KIND_SET] } } : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.at } },
                { createdAt: cursor.at, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    const page = rows.slice(0, q.limit);
    const visible = await this.visibleChannels(userId, [
      ...new Set(page.map((r) => r.channelId).filter((v): v is string => v !== null)),
    ]);
    const actors = new Map(
      (
        await this.prisma.user.findMany({
          where: {
            id: {
              in: [...new Set(page.map((r) => r.actorId).filter((v): v is string => v !== null))],
            },
          },
          select: { id: true, displayName: true },
        })
      ).map((u) => [u.id, u.displayName]),
    );
    const items: NotificationDto[] = [];
    for (const r of page) {
      // a channel the person can no longer see shows nothing of what was said in it
      if (r.channelId && !visible.has(r.channelId)) continue;
      items.push({
        id: r.id,
        kind: r.kind as NotificationKind,
        actorId: r.actorId,
        actorName: r.actorId ? (actors.get(r.actorId) ?? null) : null,
        teamId: r.targetKind === 'team' ? r.targetId : null,
        channelId: r.channelId,
        channelName: r.channelId ? visible.get(r.channelId)?.name || null : null,
        messageId: r.messageId,
        targetKind: r.targetKind,
        targetId: r.targetId,
        summary: r.summary,
        redacted: r.redacted,
        read: r.readAt !== null,
        createdAt: r.createdAt.toISOString(),
      });
    }
    const last = page.at(-1);
    return {
      items,
      nextCursor:
        rows.length > q.limit && last
          ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString('base64url')
          : null,
    };
  }

  async count(userId: string): Promise<NotificationCountDto> {
    const rows = await this.prisma.notification.groupBy({
      by: ['kind', 'targetKind', 'targetId'],
      where: { userId, readAt: null },
      _count: { _all: true },
    });
    const out: NotificationCountDto = { unread: 0, mentions: 0, byTeam: {}, dms: 0 };
    for (const r of rows) {
      const n = r._count._all;
      out.unread += n;
      if (r.kind === 'dm') out.dms += n;
      if (MENTION_KIND_SET.has(r.kind)) {
        out.mentions += n;
        if (r.targetKind === 'team' && r.targetId)
          out.byTeam[r.targetId] = (out.byTeam[r.targetId] ?? 0) + n;
      }
    }
    return out;
  }

  async markRead(userId: string, input: ReadNotificationsInput): Promise<void> {
    if (input.ids) {
      const rows = await this.prisma.notification.findMany({
        where: { userId, id: { in: input.ids }, readAt: null },
        select: { id: true },
      });
      if (!rows.length) return;
      await this.prisma.notification.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { readAt: new Date() },
      });
      await this.bus.publish('room.event', {
        rooms: [`user:${userId}`],
        name: NOTIFY_EVENTS.read,
        payload: { ids: rows.map((r) => r.id), all: false } satisfies NotificationReadEvent,
      });
      return;
    }
    await this.prisma.notification.updateMany({
      where: {
        userId,
        readAt: null,
        ...(input.before ? { createdAt: { lt: new Date(input.before) } } : {}),
      },
      data: { readAt: new Date() },
    });
    await this.bus.publish('room.event', {
      rooms: [`user:${userId}`],
      name: NOTIFY_EVENTS.read,
      payload: { ids: [], all: true } satisfies NotificationReadEvent,
    });
  }

  // ---------------------------------------------------------------- housekeeping

  /** Removes what is older than the retention period. */
  async prune(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - NOTIFY_LIMITS.retentionDays * 86_400_000);
    const res = await this.prisma.notification.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return res.count;
  }

  /** Whether the person may use `@everyone` here (the composer asks before offering it). */
  mayMentionEveryone(perms: bigint): boolean {
    return hasPermission(perms, Permission.MENTION_EVERYONE);
  }
}
