import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { hasPermission, Permission, type BanDto, type Locale } from '@os-planner/shared';
import argon2 from 'argon2';
import { MailService } from '../mail/mail.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../roles/audit.service.js';
import { RoleHierarchy } from '../roles/role-hierarchy.service.js';
import { PermissionService } from '../spaces/permission.service.js';
import { TeamsService } from '../teams/teams.service.js';

/** Bans, and handing a team to somebody else. (Leaving and removing people is `TeamsService.removeMember`.) */
@Injectable()
export class MembershipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionService,
    private readonly audit: AuditService,
    private readonly teams: TeamsService,
    private readonly hierarchy: RoleHierarchy,
    private readonly mail: MailService,
  ) {}

  private async requireManager(userId: string, teamId: string) {
    const access = await this.perms.teamAccess(userId, teamId);
    if (!access) throw new NotFoundException();
    if (!hasPermission(access.perms, Permission.MANAGE_MEMBERS))
      throw new ForbiddenException('forbidden');
    return access;
  }

  // ---------------------------------------------------------------- bans

  async bans(userId: string, teamId: string): Promise<BanDto[]> {
    await this.requireManager(userId, teamId);
    const rows = await this.prisma.ban.findMany({
      where: { teamId },
      include: { user: { select: { displayName: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((b) => ({
      userId: b.userId,
      displayName: b.user.displayName,
      reason: b.reason,
      createdAt: b.createdAt.toISOString(),
    }));
  }

  /**
   * Puts the person on the team's ban list: they leave the team if they are in it, their pending request is closed,
   * and nothing lets them back in (invite, link, directory, request) until the ban is lifted. Same rank rule as removing.
   */
  async ban(userId: string, teamId: string, targetId: string, reason: string): Promise<void> {
    const access = await this.requireManager(userId, teamId);
    if (targetId === userId) throw new UnprocessableEntityException('cannot_ban_self');
    if (targetId === access.team.ownerId)
      throw new UnprocessableEntityException('owner_cannot_be_removed');
    if (!(await this.prisma.user.findUnique({ where: { id: targetId }, select: { id: true } })))
      throw new NotFoundException();
    await this.teams.assertOutranks(access, targetId);

    await this.prisma.$transaction(async (tx) => {
      if (await tx.ban.findUnique({ where: { teamId_userId: { teamId, userId: targetId } } }))
        return;
      const roles = await tx.memberRole.findMany({
        where: { userId: targetId, role: { teamId } },
        include: { role: true },
      });
      const wasMember = (await tx.teamMember.count({ where: { teamId, userId: targetId } })) > 0;
      if (wasMember) {
        await this.teams.dropMember(tx, teamId, targetId);
        if (
          roles.some(
            (r) =>
              r.role.projectId === null &&
              hasPermission(r.role.permissions, Permission.ADMINISTRATOR),
          )
        )
          await this.hierarchy.assertAdministratorRemains(tx, teamId);
      }
      await tx.joinRequest.updateMany({
        where: { teamId, userId: targetId, pending: 1 },
        data: { status: 'denied', pending: null, decidedBy: userId, decidedAt: new Date() },
      });
      await tx.pendingInvite.deleteMany({ where: { userId: targetId, invite: { teamId } } });
      await tx.ban.create({ data: { teamId, userId: targetId, reason, bannedBy: userId } });
      await this.audit.record(tx, {
        teamId,
        actorId: userId,
        action: 'member.ban',
        targetKind: 'member',
        targetId,
        before: wasMember
          ? { member: true, roles: roles.map((r) => r.role.name) }
          : { member: false },
        reason,
      });
    });
  }

  /** Lifting a ban that is not there changes nothing. */
  async unban(userId: string, teamId: string, targetId: string): Promise<void> {
    await this.requireManager(userId, teamId);
    await this.prisma.$transaction(async (tx) => {
      const res = await tx.ban.deleteMany({ where: { teamId, userId: targetId } });
      if (res.count === 0) return;
      await this.audit.record(tx, {
        teamId,
        actorId: userId,
        action: 'member.unban',
        targetKind: 'member',
        targetId,
      });
    });
  }

  // ---------------------------------------------------------------- ownership

  /**
   * Hands the team to another member. Only the owner can, and has to type their password again. The previous owner
   * keeps the roles they hold but is no longer above everybody: ranks decide from now on.
   */
  async transferOwnership(
    userId: string,
    teamId: string,
    newOwnerId: string,
    password: string,
  ): Promise<void> {
    const access = await this.perms.teamAccess(userId, teamId);
    if (!access) throw new NotFoundException();
    if (!access.isOwner) throw new ForbiddenException('forbidden');

    const me = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });
    if (!me || !(await argon2.verify(me.passwordHash, password).catch(() => false)))
      throw new ForbiddenException('invalid_password');
    if (newOwnerId === userId) throw new UnprocessableEntityException('already_owner');

    const heir = await this.prisma.user.findFirst({
      where: { id: newOwnerId, teamMemberships: { some: { teamId } } },
      select: { email: true, displayName: true, locale: true },
    });
    if (!heir) throw new UnprocessableEntityException('not_a_member');

    await this.prisma.$transaction(async (tx) => {
      const res = await tx.team.updateMany({
        where: { id: teamId, ownerId: userId },
        data: { ownerId: newOwnerId },
      });
      if (res.count === 0) throw new ForbiddenException('forbidden'); // somebody else got there first
      await this.audit.record(tx, {
        teamId,
        actorId: userId,
        action: 'team.owner.transfer',
        targetKind: 'team',
        targetId: teamId,
        before: { ownerId: userId },
        after: { ownerId: newOwnerId },
      });
    });
    await this.mail.sendOwnership(
      heir.email,
      heir.displayName,
      heir.locale as Locale,
      access.team.name,
      'assigned',
    );
  }
}
