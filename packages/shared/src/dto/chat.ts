import { z } from 'zod';
import type { MentionsDto } from '../chat/mentions';
import { positionSchema } from './common';
import { VOICE_LIMITS, VOICE_QUALITY, type VoiceQuality } from './voice-consts';

// ---------------------------------------------------------------- limits

export const CHAT_LIMITS = {
  messageMax: 4000,
  channelNameMax: 80,
  topicMax: 500,
  threadNameMax: 80,
  /** Largest page of messages a request may ask for. */
  pageMax: 100,
  pageDefault: 50,
  /** Messages a catch-up (`since`) returns at once; `hasMore` says to ask again. */
  catchUpMax: 200,
  attachmentsPerMessage: 10,
  reactionsPerMessage: 20,
  /** Slowmode can be set up to six hours. */
  slowmodeMax: 21_600,
  /** Channels (categories included) per space. */
  channelsPerSpace: 200,
  searchMax: 50,
} as const;

/** What a person sees as unread in the sidebar is capped at this: "99+". */
export const UNREAD_CAP = 99;

// ---------------------------------------------------------------- ids

/** Message ids are made on the client (UUIDv7: a time prefix orders them, and a resend is recognised by its id). */
export const messageIdSchema = z
  .string()
  .toLowerCase()
  .pipe(z.uuid({ version: 'v7' }));

// ---------------------------------------------------------------- channels

export const CHANNEL_KINDS = ['text', 'category', 'voice'] as const;
export const channelKindSchema = z.enum(CHANNEL_KINDS);
export type ChannelKind = z.infer<typeof channelKindSchema>;

/** Letters, digits and the usual separators; no control characters. */
export const channelNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(CHAT_LIMITS.channelNameMax)
  // eslint-disable-next-line no-control-regex
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), 'control characters are not allowed');
export const topicSchema = z.string().trim().max(CHAT_LIMITS.topicMax);

export interface ChannelDto {
  id: string;
  spaceId: string;
  /** The category it is in (a channel of kind `category`), or null. */
  parentId: string | null;
  kind: ChannelKind;
  name: string;
  topic: string;
  position: string;
  nsfw: boolean;
  /** Push and email about this channel show a generic text instead of the message (also for age-restricted channels). */
  redactPreviews: boolean;
  slowmodeSeconds: number;
  /** Voice channels: most people at once (null = the server's default). */
  userLimit: number | null;
  /** Voice channels: audio quality (null = normal). */
  quality: VoiceQuality | null;
  archived: boolean;
  /** What the person may do in it (decimal string of the permission bit field). */
  permissions: string;
  createdAt: string;
}

export const createChannelSchema = z.object({
  id: z.uuid().optional(),
  kind: channelKindSchema.default('text'),
  name: channelNameSchema,
  parentId: z.uuid().nullable().optional(),
  topic: topicSchema.optional(),
  position: positionSchema.optional(),
  nsfw: z.boolean().optional(),
  redactPreviews: z.boolean().optional(),
  slowmodeSeconds: z.number().int().min(0).max(CHAT_LIMITS.slowmodeMax).optional(),
  userLimit: z.number().int().min(1).max(VOICE_LIMITS.userLimitMax).nullable().optional(),
  quality: z.enum(VOICE_QUALITY).nullable().optional(),
});
export type CreateChannelInput = z.infer<typeof createChannelSchema>;

export const updateChannelSchema = z
  .object({
    name: channelNameSchema,
    topic: topicSchema,
    nsfw: z.boolean(),
    redactPreviews: z.boolean(),
    slowmodeSeconds: z.number().int().min(0).max(CHAT_LIMITS.slowmodeMax),
    userLimit: z.number().int().min(1).max(VOICE_LIMITS.userLimitMax).nullable(),
    quality: z.enum(VOICE_QUALITY).nullable(),
    archived: z.boolean(),
    parentId: z.uuid().nullable(),
    position: positionSchema,
  })
  .partial();
export type UpdateChannelInput = z.infer<typeof updateChannelSchema>;

export const channelOrderSchema = z.object({
  items: z
    .array(z.object({ id: z.uuid(), parentId: z.uuid().nullable(), position: positionSchema }))
    .min(1)
    .max(CHAT_LIMITS.channelsPerSpace),
});
export type ChannelOrderInput = z.infer<typeof channelOrderSchema>;

// ---------------------------------------------------------------- messages

export const messageContentSchema = z.string().max(CHAT_LIMITS.messageMax);

export interface AttachmentDto {
  id: string;
  mediaId: string;
  name: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  kind: 'image' | 'video';
}

export interface ReactionDto {
  emoji: string;
  /** Who reacted (at most 200 are listed; `count` is the real number). */
  userIds: string[];
  count: number;
}

export interface ThreadSummaryDto {
  id: string;
  name: string;
  archived: boolean;
  replyCount: number;
  lastMessageAt: string;
}

export interface ReplyPreviewDto {
  id: string;
  authorName: string | null;
  /** The start of the text; null when the message was deleted. */
  snippet: string | null;
  deleted: boolean;
}

export interface MessageDto {
  id: string;
  channelId: string;
  threadId: string | null;
  authorId: string | null;
  /** The person's name in this team; null for an author whose account is gone. */
  authorName: string | null;
  /** Markdown. Empty for a deleted message. */
  content: string;
  /** The mentions in `content` that the server accepted (the rest of the tokens are drawn as plain text). */
  mentions: MentionsDto;
  replyToId: string | null;
  replyTo: ReplyPreviewDto | null;
  attachments: AttachmentDto[];
  reactions: ReactionDto[];
  /** The thread that starts at this message, if any. */
  thread: ThreadSummaryDto | null;
  editedAt: string | null;
  deletedAt: string | null;
  pinnedAt: string | null;
  createdAt: string;
  /** Position in the channel's change sequence: the last time this message changed (see `since`). */
  seq: string;
}

export interface MessagePageDto {
  /** Oldest first. */
  items: MessageDto[];
  /** More messages exist beyond this page, in the direction that was asked for. */
  hasMore: boolean;
  /** The channel's change sequence now: the cursor for the next catch-up. */
  lastSeq: string;
}

export const sendMessageSchema = z.object({
  id: messageIdSchema,
  content: messageContentSchema,
  replyToId: messageIdSchema.nullable().optional(),
  threadId: z.uuid().nullable().optional(),
  attachmentIds: z.array(z.uuid()).max(CHAT_LIMITS.attachmentsPerMessage).optional(),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const editMessageSchema = z.object({ content: messageContentSchema });
export type EditMessageInput = z.infer<typeof editMessageSchema>;

const cursorInt = z.string().regex(/^\d{1,18}$/);
export const listMessagesSchema = z
  .object({
    before: messageIdSchema.optional(),
    after: messageIdSchema.optional(),
    /** Everything that changed after this sequence number (edits, deletions, reactions included). */
    since: cursorInt.optional(),
    limit: z.coerce.number().int().min(1).max(CHAT_LIMITS.pageMax).default(CHAT_LIMITS.pageDefault),
  })
  .refine(
    (q) => [q.before, q.after, q.since].filter((v) => v !== undefined).length <= 1,
    'use one of before, after, since',
  );
export type ListMessagesQuery = z.infer<typeof listMessagesSchema>;

export const searchMessagesSchema = z.object({ q: z.string().trim().min(1).max(200) });

// ---------------------------------------------------------------- reactions

/** One emoji (with its joiners and variation selectors); no letters, digits or markup. */
export const emojiSchema = z
  .string()
  .min(1)
  .max(32)
  .refine(
    (v) =>
      /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣|[#*0-9](?=️?⃣))+$/u.test(
        v,
      ),
    'not an emoji',
  );

// ---------------------------------------------------------------- threads

export const createThreadSchema = z.object({
  name: z.string().trim().min(1).max(CHAT_LIMITS.threadNameMax),
});
export type CreateThreadInput = z.infer<typeof createThreadSchema>;
export const updateThreadSchema = z.object({
  archived: z.boolean().optional(),
  name: z.string().trim().min(1).max(CHAT_LIMITS.threadNameMax).optional(),
});
export type UpdateThreadInput = z.infer<typeof updateThreadSchema>;
export const listThreadMessagesSchema = z.object({
  before: messageIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(CHAT_LIMITS.pageMax).default(CHAT_LIMITS.pageDefault),
});

// ---------------------------------------------------------------- read state

export const markReadSchema = z.object({ messageId: messageIdSchema });
export interface UnreadDto {
  channelId: string;
  /** Messages by other people after the last one read (capped at UNREAD_CAP + 1: show "99+"). */
  unread: number;
  /** Of those, how many mention the person (or answer them). */
  mentions: number;
  /** The last message the person has read, if they ever opened the channel. */
  lastReadMessageId: string | null;
}

// ---------------------------------------------------------------- attachments

export const attachmentFieldsSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(200).optional(),
  width: z.coerce.number().int().positive().max(20000).optional(),
  height: z.coerce.number().int().positive().max(20000).optional(),
  durationSec: z.coerce.number().positive().max(86400).optional(),
});
export type AttachmentFields = z.infer<typeof attachmentFieldsSchema>;

// ---------------------------------------------------------------- events (server -> client, room channel:<id> / thread:<id>)

/** Names of the chat events. The payloads are `MessageDto` unless noted. */
export const CHAT_EVENTS = {
  messageCreated: 'message.created',
  messageUpdated: 'message.updated',
  messageDeleted: 'message.deleted',
  reactionAdded: 'reaction.added',
  reactionRemoved: 'reaction.removed',
  messagePinned: 'message.pinned',
  messageUnpinned: 'message.unpinned',
  threadCreated: 'thread.created',
  threadUpdated: 'thread.updated',
  channelUpdated: 'channel.updated',
  /** To the space room: the list of channels changed (created, renamed, moved, deleted); ask for the list again. */
  channelsChanged: 'channels.changed',
} as const;

export interface ReactionEvent {
  channelId: string;
  messageId: string;
  emoji: string;
  userId: string;
  /** The message's new sequence number. */
  seq: string;
}
export interface MessageDeletedEvent {
  channelId: string;
  messageId: string;
  seq: string;
}
export interface ThreadEvent {
  channelId: string;
  thread: ThreadSummaryDto;
  rootMessageId: string;
}
export interface ChannelsChangedEvent {
  spaceId: string;
}

/** `GET /api/threads/:id/messages`: the thread, the message it started from, and its replies (oldest first). */
export interface ThreadPageDto extends MessagePageDto {
  thread: ThreadSummaryDto;
  root: MessageDto;
}

/** Event `channel.updated` (room `channel:<id>`): the channel changed or was deleted; ask for it again. */
export interface ChannelUpdatedEvent {
  channelId: string;
  spaceId: string;
  deleted: boolean;
}
