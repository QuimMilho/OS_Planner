import { Permission } from '@os-planner/shared';
import type { Channel, DirectConversation } from '../generated/prisma/client.js';
import type { ChatSpace } from '../spaces/permission.service.js';

/** The conversation a direct-message channel belongs to, seen by one of its two people. */
export interface DmContext {
  conversation: DirectConversation;
  /** The other person; null once their account is gone. */
  peerId: string | null;
}

/**
 * What the chat endpoints (messages, attachments, reactions, pins, read state) work with, whatever the channel is.
 * There are two kinds, and this is the only place where the difference lives:
 *
 *  - a text channel of a team or project (`dm` is null): `perms` come from roles and overwrites, `chat` says where it is;
 *  - a direct-message conversation (`dm` is set): only its two people have access, with the fixed `DM_PERMISSIONS`; no
 *    role, moderator or administrator ever gets in, and nothing is charged to a team.
 */
export interface ChatAccess {
  channel: Channel;
  perms: bigint;
  /** The team whose nicknames name the authors (none in a DM). */
  teamId: string | null;
  chat: ChatSpace | null;
  dm: DmContext | null;
}

/**
 * What each of the two people may do in their conversation. Not MANAGE_MESSAGES (nobody deletes what the other said)
 * and not the thread bits (a reply covers it).
 */
export const DM_PERMISSIONS =
  Permission.VIEW_CHANNEL |
  Permission.READ_MESSAGE_HISTORY |
  Permission.SEND_MESSAGES |
  Permission.ATTACH_FILES |
  Permission.ADD_REACTIONS;

export const dmChannelOf = (c: Pick<Channel, 'kind'>): boolean => c.kind === 'dm';
