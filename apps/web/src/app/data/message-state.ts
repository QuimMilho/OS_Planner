import type {
  MessageDeletedEvent,
  MessageDto,
  ReactionEvent,
  ThreadSummaryDto,
} from '@os-planner/shared';
import type { MessageView } from '../features/chat/chat-message';
import type { ChatOutboxRow } from './db';

/** Messages are ordered by id (UUIDv7, so by time); a change of a message carries a higher `seq` than the one before it. */
const newer = (incoming: MessageDto, existing: MessageDto): boolean =>
  BigInt(incoming.seq) >= BigInt(existing.seq);

/** Adds the message or replaces its older copy; keeps the list in order. Returns the same array when nothing changed. */
export function upsert(list: readonly MessageDto[], incoming: MessageDto): MessageDto[] {
  const at = list.findIndex((m) => m.id === incoming.id);
  if (at >= 0) {
    if (!newer(incoming, list[at]!)) return list as MessageDto[];
    const next = [...list];
    next[at] = incoming;
    return next;
  }
  const next = [...list, incoming];
  next.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return next;
}

export function upsertMany(
  list: readonly MessageDto[],
  items: readonly MessageDto[],
): MessageDto[] {
  return items.reduce<MessageDto[]>((acc, m) => upsert(acc, m), list as MessageDto[]);
}

/** What a deleted message looks like: its place stays, its content and everything on it go. */
export function tombstone(list: readonly MessageDto[], e: MessageDeletedEvent): MessageDto[] {
  return list.map((m) =>
    m.id === e.messageId
      ? {
          ...m,
          content: '',
          attachments: [],
          reactions: [],
          pinnedAt: null,
          thread: m.thread,
          deletedAt: m.deletedAt ?? new Date().toISOString(),
          seq: e.seq,
        }
      : m,
  );
}

export function applyReaction(
  list: readonly MessageDto[],
  e: ReactionEvent,
  added: boolean,
): MessageDto[] {
  return list.map((m) => {
    if (m.id !== e.messageId) return m;
    const reactions = m.reactions.map((r) => ({ ...r, userIds: [...r.userIds] }));
    const mine = reactions.find((r) => r.emoji === e.emoji);
    if (added) {
      if (mine) {
        if (mine.userIds.includes(e.userId)) return m;
        mine.userIds.push(e.userId);
        mine.count++;
      } else reactions.push({ emoji: e.emoji, userIds: [e.userId], count: 1 });
    } else if (mine) {
      if (!mine.userIds.includes(e.userId)) return m;
      mine.userIds = mine.userIds.filter((u) => u !== e.userId);
      mine.count = Math.max(0, mine.count - 1);
    }
    return {
      ...m,
      reactions: reactions.filter((r) => r.count > 0),
      seq: BigInt(e.seq) > BigInt(m.seq) ? e.seq : m.seq,
    };
  });
}

export function withThread(
  list: readonly MessageDto[],
  rootId: string,
  thread: ThreadSummaryDto,
): MessageDto[] {
  return list.map((m) => (m.id === rootId ? { ...m, thread } : m));
}

/** A message that is still in the outbox, shaped like one from the server so the list can show it. */
export function pendingMessage(
  row: ChatOutboxRow,
  author: { id: string; name: string },
): MessageDto {
  return {
    id: row.id,
    channelId: row.channelId,
    threadId: row.threadId,
    authorId: author.id,
    authorName: author.name,
    content: row.content,
    mentions: { users: [], roles: [], everyone: false, here: false },
    replyToId: row.replyToId,
    replyTo: null,
    attachments: [],
    reactions: [],
    thread: null,
    editedAt: null,
    deletedAt: null,
    pinnedAt: null,
    createdAt: new Date(row.createdAt).toISOString(),
    seq: '0',
  };
}

const FIVE_MINUTES = 5 * 60_000;

/** The messages as the list draws them: a message right after one by the same person (within minutes) has no header of its own. */
export function toViews(
  messages: readonly MessageDto[],
  pending: ReadonlyMap<string, ChatOutboxRow>,
): MessageView[] {
  const out: MessageView[] = [];
  let previous: MessageDto | null = null;
  for (const message of messages) {
    const row = pending.get(message.id);
    const compact =
      previous !== null &&
      !message.replyToId &&
      previous.authorId !== null &&
      previous.authorId === message.authorId &&
      !previous.deletedAt &&
      new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() <
        FIVE_MINUTES &&
      sameDay(previous.createdAt, message.createdAt);
    out.push({
      message,
      pending: row ? (row.state === 'failed' ? 'failed' : 'sending') : null,
      error: row?.error,
      compact,
    });
    previous = message;
  }
  return out;
}

export function sameDay(a: string, b: string): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}
