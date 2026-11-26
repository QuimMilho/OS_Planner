import { z } from 'zod';
import { idSchema } from './common';

// Direct messages (phase 8). The conversation reuses the chat engine: its messages are ordinary messages of a channel of
// kind "dm", so everything in ./chat (messages, attachments, reactions, pins, read state) applies to it unchanged.

import { ALLOW_DMS_FROM } from './dm-consts';

export * from './dm-consts';
export const allowDmsFromSchema = z.enum(ALLOW_DMS_FROM);

export const startDmSchema = z.object({ userId: idSchema });
export type StartDmInput = z.infer<typeof startDmSchema>;

export const dmQuerySchema = z.object({
  /** Include conversations the person closed. */
  closed: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export const dmPeopleQuerySchema = z.object({ q: z.string().trim().max(80).default('') });

export interface DmPeerDto {
  id: string;
  displayName: string;
}

export interface DmLastMessageDto {
  id: string;
  authorId: string | null;
  /** The start of the text (one line); null for a deleted message. */
  snippet: string | null;
  deleted: boolean;
  hasAttachments: boolean;
  createdAt: string;
}

export interface DmDto {
  id: string;
  /** The channel that holds the messages: every chat endpoint takes this id. */
  channelId: string;
  /** The other person; null once their account is gone ("Deleted user"). */
  peer: DmPeerDto | null;
  lastMessage: DmLastMessageDto | null;
  lastMessageAt: string;
  /** Messages by the other person after the last one read (capped at UNREAD_CAP + 1). */
  unread: number;
  lastReadMessageId: string | null;
  /** The person closed it: it is hidden from their list until something new arrives. */
  closed: boolean;
  /** The person blocked the other one. (Being blocked is never shown.) */
  blocked: boolean;
  /** The teams the two have in common. */
  sharedTeams: { id: string; name: string }[];
  createdAt: string;
}

/** A person the "new message" picker offers: somebody who shares a team that allows direct messages. */
export interface DmPersonDto {
  userId: string;
  displayName: string;
  /** Names of the teams you have in common. */
  teams: string[];
}

export interface BlockDto {
  userId: string;
  /** Null when the account is gone. */
  displayName: string | null;
  createdAt: string;
}

/** Event `dm.updated` (room `user:<id>`): a conversation was created, reopened, closed or got a message; ask for the list again. */
export interface DmUpdatedEvent {
  conversationId: string;
  channelId: string;
}
