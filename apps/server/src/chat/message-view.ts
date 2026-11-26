import { Injectable } from '@nestjs/common';
import {
  type AttachmentDto,
  type MentionsDto,
  type MessageDto,
  type ReactionDto,
  type ReplyPreviewDto,
  type ThreadSummaryDto,
} from '@os-planner/shared';
import { CHAT_LIMITS, chatMarkdownToText, NO_MENTIONS } from '@os-planner/shared/chat';
import type { Message } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';

type Db = PrismaService | Tx;

const SNIPPET = 140;
const MAX_REACTORS_LISTED = 200;

/**
 * Turns message rows into what clients receive. The same shape goes out in lists and in events, so it never depends on
 * who is looking: reactions carry the people who made them and the client works out which are its own.
 */
@Injectable()
export class MessageView {
  constructor(private readonly prisma: PrismaService) {}

  async dtos(
    messages: readonly Message[],
    teamId: string | null,
    db: Db = this.prisma,
  ): Promise<MessageDto[]> {
    if (!messages.length) return [];
    const ids = messages.map((m) => m.id);
    const live = messages.filter((m) => !m.deletedAt).map((m) => m.id);

    const replyIds = [
      ...new Set(messages.map((m) => m.replyToId).filter((v): v is string => v !== null)),
    ];
    const replies = replyIds.length
      ? await db.message.findMany({ where: { id: { in: replyIds } } })
      : [];
    const authorIds = [
      ...new Set(
        [...messages, ...replies].map((m) => m.authorId).filter((v): v is string => v !== null),
      ),
    ];

    const [users, members, attachments, reactions, threads] = await Promise.all([
      authorIds.length
        ? db.user.findMany({
            where: { id: { in: authorIds } },
            select: { id: true, displayName: true },
          })
        : [],
      authorIds.length && teamId
        ? db.teamMember.findMany({
            where: { teamId, userId: { in: authorIds } },
            select: { userId: true, nickname: true },
          })
        : [],
      live.length
        ? db.attachment.findMany({
            where: { messageId: { in: live } },
            include: { media: true },
            orderBy: { createdAt: 'asc' },
          })
        : [],
      live.length
        ? db.reaction.findMany({
            where: { messageId: { in: live } },
            orderBy: { createdAt: 'asc' },
          })
        : [],
      db.thread.findMany({ where: { rootMessageId: { in: ids } } }),
    ]);
    const threadCounts = threads.length
      ? await db.message.groupBy({
          by: ['threadId'],
          where: { threadId: { in: threads.map((t) => t.id) }, deletedAt: null },
          _count: { _all: true },
        })
      : [];

    const name = new Map(users.map((u) => [u.id, u.displayName]));
    for (const m of members) if (m.nickname) name.set(m.userId, m.nickname);
    const authorName = (id: string | null): string | null => (id ? (name.get(id) ?? null) : null);

    const attachmentsBy = new Map<string, AttachmentDto[]>();
    for (const a of attachments) {
      const dto: AttachmentDto = {
        id: a.id,
        mediaId: a.mediaId,
        name: a.name,
        mime: a.media.mime,
        size: a.media.size,
        width: a.media.width,
        height: a.media.height,
        kind: a.media.kind === 'video' ? 'video' : 'image',
      };
      (
        attachmentsBy.get(a.messageId!) ?? attachmentsBy.set(a.messageId!, []).get(a.messageId!)!
      ).push(dto);
    }

    const reactionsBy = new Map<string, Map<string, string[]>>();
    for (const r of reactions) {
      const perEmoji =
        reactionsBy.get(r.messageId) ?? reactionsBy.set(r.messageId, new Map()).get(r.messageId)!;
      (perEmoji.get(r.emoji) ?? perEmoji.set(r.emoji, []).get(r.emoji)!).push(r.userId);
    }
    const reactionDtos = (messageId: string): ReactionDto[] =>
      [...(reactionsBy.get(messageId) ?? new Map<string, string[]>()).entries()].map(
        ([emoji, userIds]) => ({
          emoji,
          userIds: userIds.slice(0, MAX_REACTORS_LISTED),
          count: userIds.length,
        }),
      );

    const replyBy = new Map<string, ReplyPreviewDto>(
      replies.map((r) => [
        r.id,
        {
          id: r.id,
          authorName: authorName(r.authorId),
          snippet: r.deletedAt ? null : snippet(r.content),
          deleted: r.deletedAt !== null,
        },
      ]),
    );

    const counts = new Map(threadCounts.map((c) => [c.threadId!, c._count._all]));
    const threadBy = new Map<string, ThreadSummaryDto>(
      threads.map((t) => [
        t.rootMessageId,
        {
          id: t.id,
          name: t.name,
          archived: t.archivedAt !== null,
          replyCount: counts.get(t.id) ?? 0,
          lastMessageAt: t.lastMessageAt.toISOString(),
        },
      ]),
    );

    return messages.map((m) => ({
      id: m.id,
      channelId: m.channelId,
      threadId: m.threadId,
      authorId: m.authorId,
      authorName: authorName(m.authorId),
      content: m.deletedAt ? '' : m.content,
      mentions: m.deletedAt ? { ...NO_MENTIONS, users: [], roles: [] } : ((m.mentions as MentionsDto | null) ?? { ...NO_MENTIONS, users: [], roles: [] }),
      replyToId: m.replyToId,
      replyTo: m.replyToId
        ? (replyBy.get(m.replyToId) ?? {
            id: m.replyToId,
            authorName: null,
            snippet: null,
            deleted: true,
          })
        : null,
      attachments: attachmentsBy.get(m.id) ?? [],
      reactions: reactionDtos(m.id).slice(0, CHAT_LIMITS.reactionsPerMessage),
      thread: threadBy.get(m.id) ?? null,
      editedAt: m.editedAt?.toISOString() ?? null,
      deletedAt: m.deletedAt?.toISOString() ?? null,
      pinnedAt: m.pinnedAt?.toISOString() ?? null,
      createdAt: m.createdAt.toISOString(),
      seq: m.seq.toString(10),
    }));
  }

  async dto(message: Message, teamId: string | null, db: Db = this.prisma): Promise<MessageDto> {
    return (await this.dtos([message], teamId, db))[0]!;
  }
}

/** The start of a message for a reply preview: one line, no longer than SNIPPET characters. */
export function snippet(content: string): string {
  const line = chatMarkdownToText(content);
  return line.length > SNIPPET ? `${line.slice(0, SNIPPET)}…` : line;
}
