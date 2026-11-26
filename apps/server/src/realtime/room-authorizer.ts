import { Injectable } from '@nestjs/common';
import { JOINABLE_ROOM_KINDS, type JoinableRoomKind } from '@os-planner/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { PermissionService } from '../spaces/permission.service.js';

/** Answers "may this person be in this room?" for one kind of room. */
export type RoomChecker = (userId: string, id: string) => Promise<boolean>;

export interface ParsedRoom {
  kind: string;
  id: string;
}

/** `space:1234` -> { kind: 'space', id: '1234' }; null for names that are not `kind:id`. */
export function parseRoom(room: string): ParsedRoom | null {
  const i = room.indexOf(':');
  return i > 0 ? { kind: room.slice(0, i), id: room.slice(i + 1) } : null;
}

/**
 * The one place that decides who may be in a room. It asks the same PermissionService as the REST controllers, and
 * nothing a client says about a room is trusted: `room:join` and every re-check after a permission change come here.
 *
 * Features register the rooms they own (`channel`, `thread`, ...) in `onModuleInit`; a kind nobody registered is
 * refused, which is also what an unknown id answers.
 */
@Injectable()
export class RoomAuthorizer {
  private readonly checkers = new Map<string, RoomChecker>();

  constructor(
    private readonly perms: PermissionService,
    private readonly prisma: PrismaService,
  ) {
    // The metadata room of a space: whoever can see the space (their own, their team's, a project they may see), and
    // whoever a notebook of it is shared with (they hear that it changed, nothing more).
    this.register(
      'space',
      async (userId, id) =>
        (await this.perms.spaceAccess(userId, id)) !== null ||
        (await this.prisma.notebookShare.count({ where: { userId, notebook: { spaceId: id, deletedAt: null } } })) > 0,
    );
  }

  register(kind: JoinableRoomKind, check: RoomChecker): void {
    this.checkers.set(kind, check);
  }

  /** True only for a kind a client may join and an id the person may see. Never throws. */
  async canJoin(userId: string, kind: string, id: string): Promise<boolean> {
    if (!(JOINABLE_ROOM_KINDS as readonly string[]).includes(kind)) return false;
    const check = this.checkers.get(kind);
    if (!check) return false;
    try {
      return await check(userId, id);
    } catch {
      return false;
    }
  }

  /** The teams the person belongs to: the server puts them in each team's room (presence, member changes). */
  async teamIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.teamMember.findMany({
      where: { userId, team: { deletedAt: null } },
      select: { teamId: true },
    });
    return rows.map((r) => r.teamId);
  }
}
