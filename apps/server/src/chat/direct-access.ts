import { Injectable, NotFoundException } from '@nestjs/common';
import type { Channel } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DM_PERMISSIONS, type ChatAccess } from './channel-access.js';

/**
 * Who may be in a direct-message conversation: its two people, and nobody else. Roles, moderation rights and instance
 * administration do not count here. Anyone else gets the same 404 as for a conversation that does not exist.
 */
@Injectable()
export class DirectAccess {
  constructor(private readonly prisma: PrismaService) {}

  /** The channel of a conversation as the person sees it, or 404 when they are not one of its two people. */
  async resolve(userId: string, channel: Channel): Promise<ChatAccess> {
    const conversation = await this.prisma.directConversation.findUnique({
      where: { channelId: channel.id },
    });
    if (!conversation || (conversation.userA !== userId && conversation.userB !== userId))
      throw new NotFoundException();
    return {
      channel,
      perms: DM_PERMISSIONS,
      teamId: null,
      chat: null,
      dm: {
        conversation,
        peerId: conversation.userA === userId ? conversation.userB : conversation.userA,
      },
    };
  }

  /** Whether the person is one of the two people of the conversation that owns this channel. */
  async participates(userId: string, channelId: string): Promise<boolean> {
    const conversation = await this.prisma.directConversation.findUnique({
      where: { channelId },
      select: { userA: true, userB: true },
    });
    return (
      conversation !== null && (conversation.userA === userId || conversation.userB === userId)
    );
  }
}
