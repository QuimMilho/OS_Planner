import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { hasPermission, Permission, type MentionsDto } from '@os-planner/shared';
import { extractMentions, NO_MENTIONS, NOTIFY_LIMITS } from '@os-planner/shared/chat';
import type { ChatAccess } from '../chat/channel-access.js';
import { chainIdsOf, PermissionService } from '../spaces/permission.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Decides which of the mentions a message claims are real. The text carries tokens, anybody can type a token, so the server
 * keeps only those that hold and stores the result with the message (`Message.mentions`):
 *
 *  - a person counts when they are in the team and can see the channel (anyone else is never told, and the author is warned
 *    by the composer that they cannot see it);
 *  - a role counts when it is a role of this team that applies here and is mentionable, or when the author may mention everyone;
 *  - `@everyone` and `@here` need MENTION_EVERYONE in this channel, and `@everyone` is refused outright in a team too big
 *    to be told at once.
 *
 * Direct messages have no mentions: the other person is told about every message anyway.
 */
@Injectable()
export class MentionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionService,
  ) {}

  async accept(access: ChatAccess, authorId: string, content: string): Promise<MentionsDto> {
    if (access.dm || !access.chat) return { ...NO_MENTIONS, users: [], roles: [] };
    const claimed = extractMentions(content);
    if (!claimed.users.length && !claimed.roles.length && !claimed.everyone && !claimed.here)
      return { users: [], roles: [], everyone: false, here: false };

    const mayEveryone = hasPermission(access.perms, Permission.MENTION_EVERYONE);
    const out: MentionsDto = { users: [], roles: [], everyone: false, here: false };

    if (mayEveryone && (claimed.everyone || claimed.here)) {
      if (claimed.everyone) {
        const members = await this.prisma.teamMember.count({
          where: { teamId: access.chat.teamId },
        });
        if (members > NOTIFY_LIMITS.everyoneMaxMembers)
          throw new UnprocessableEntityException('everyone_too_large');
      }
      out.everyone = claimed.everyone;
      out.here = claimed.here;
    }

    if (claimed.users.length) {
      const viewers = await this.perms.channelViewers(access.channel, claimed.users);
      out.users = claimed.users.filter((id) => id !== authorId && viewers.has(id));
    }

    if (claimed.roles.length) {
      const chain = access.chat.projectId
        ? new Set(
            chainIdsOf(
              (await this.prisma.project.findUnique({ where: { id: access.chat.projectId } }))
                ?.path ?? '',
            ),
          )
        : new Set<string>();
      const usable = new Set(
        access.chat.team.roles
          .filter(
            (r) =>
              !r.isEveryone &&
              (r.mentionable || mayEveryone) &&
              (r.projectId === null || chain.has(r.projectId)),
          )
          .map((r) => r.id),
      );
      out.roles = claimed.roles.filter((id) => usable.has(id)); // in the order they were written
    }
    return out;
  }
}
