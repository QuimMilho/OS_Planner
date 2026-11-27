import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  hasPermission,
  Permission,
  permissionsFromString,
  permissionsToString,
  type OverwriteDto,
  type OverwriteTarget,
  type SetOverwriteInput,
} from '@os-planner/shared';
import { newId } from '../common/crypto.js';
import type { Overwrite } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PermissionService, type TeamAccess } from '../spaces/permission.service.js';
import { AuditService } from './audit.service.js';

/** Overwrites on one target: more than this is surely a mistake. */
export const MAX_OVERWRITES_PER_TARGET = 200;

const toDto = (o: Overwrite): OverwriteDto => ({
  id: o.id,
  targetKind: o.targetKind as OverwriteTarget,
  targetId: o.targetId,
  subjectKind: o.subjectKind as 'role' | 'member',
  subjectId: o.subjectId,
  allow: permissionsToString(o.allow),
  deny: permissionsToString(o.deny),
});

/** What the rules below need to know about the thing an overwrite is set on. */
interface Target {
  team: TeamAccess;
  /** What the person may do there (in the project, or in the channel). */
  perms: bigint;
  /** The permission that allows changing overwrites on this kind of target. */
  manage: bigint;
  /** The projects from the root down to (and including) this one, or to the one the channel is in. */
  chain: string[];
}

/**
 * Allow/deny overwrites on a project, a channel (or category), a notebook or a board, for a role or a member.
 *
 * Rules: seeing the target comes first (404); changing its overwrites needs MANAGE_PROJECTS in the project,
 * MANAGE_CHANNELS in the channel, MANAGE_NOTEBOOKS in the notebook or MANAGE_BOARDS on the board (403); and a person can only allow or deny permissions they hold there themselves.
 */
@Injectable()
export class OverwritesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionService,
    private readonly audit: AuditService,
  ) {}

  private async target(userId: string, kind: OverwriteTarget, id: string): Promise<Target> {
    if (kind === 'project') {
      const access = await this.perms.projectAccess(userId, id);
      if (!access) throw new NotFoundException();
      return { team: access.team, perms: access.perms, manage: Permission.MANAGE_PROJECTS, chain: access.chain };
    }
    if (kind === 'channel') {
      const access = await this.perms.channelAccess(userId, id);
      if (!access) throw new NotFoundException();
      return { team: access.chat.team, perms: access.perms, manage: Permission.MANAGE_CHANNELS, chain: access.chat.levels.map((l) => l.id) };
    }
    if (kind === 'notebook') {
      // Only a notebook of a team or project has overwrites; a personal one is shared with people instead.
      const access = await this.perms.notebookAccess(userId, id);
      if (!access) throw new NotFoundException();
      if (!access.chat) throw new UnprocessableEntityException('unsupported_target');
      return { team: access.chat.team, perms: access.perms, manage: Permission.MANAGE_NOTEBOOKS, chain: access.chat.levels.map((l) => l.id) };
    }
    if (kind === 'board') {
      // Only a board of a team or project has overwrites; a personal board is its owner's alone.
      const access = await this.perms.boardAccess(userId, id);
      if (!access) throw new NotFoundException();
      if (!access.chat) throw new UnprocessableEntityException('unsupported_target');
      return { team: access.chat.team, perms: access.perms, manage: Permission.MANAGE_BOARDS, chain: access.chat.levels.map((l) => l.id) };
    }
    throw new UnprocessableEntityException('unsupported_target');
  }

  async list(userId: string, kind: OverwriteTarget, id: string): Promise<OverwriteDto[]> {
    const target = await this.target(userId, kind, id);
    if (!hasPermission(target.perms, target.manage) && !hasPermission(target.perms, Permission.MANAGE_ROLES))
      throw new ForbiddenException('forbidden');
    const rows = await this.prisma.overwrite.findMany({
      where: { targetKind: kind, targetId: id },
    });
    return rows.map(toDto);
  }

  /** Sets what a role or member is allowed and denied on the target. Allowing and denying nothing clears it. */
  async set(userId: string, input: SetOverwriteInput): Promise<OverwriteDto | null> {
    const target = await this.target(userId, input.targetKind, input.targetId);
    if (!hasPermission(target.perms, target.manage)) throw new ForbiddenException('forbidden');
    const allow = permissionsFromString(input.allow) ?? 0n;
    const deny = permissionsFromString(input.deny) ?? 0n;
    if (((allow | deny) & ~target.perms) !== 0n) throw new ForbiddenException('permission_not_held');
    const subjectName = await this.requireSubject(target, input.subjectKind, input.subjectId);

    const where = {
      targetKind_targetId_subjectKind_subjectId: {
        targetKind: input.targetKind,
        targetId: input.targetId,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
      },
    };
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.overwrite.findUnique({ where });
      const teamId = target.team.team.id;
      const describe = (o: { allow: bigint; deny: bigint }) => ({
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        subjectName,
        allow: permissionsToString(o.allow),
        deny: permissionsToString(o.deny),
      });

      if (allow === 0n && deny === 0n) {
        if (!existing) return null;
        await tx.overwrite.delete({ where: { id: existing.id } });
        await this.audit.record(tx, {
          teamId,
          actorId: userId,
          action: 'overwrite.clear',
          targetKind: input.targetKind,
          targetId: input.targetId,
          before: describe(existing),
        });
        return null;
      }
      if (
        !existing &&
        (await tx.overwrite.count({
          where: { targetKind: input.targetKind, targetId: input.targetId },
        })) >= MAX_OVERWRITES_PER_TARGET
      )
        throw new ConflictException('overwrite_limit_reached');
      if (existing && existing.allow === allow && existing.deny === deny) return toDto(existing);

      const row = existing
        ? await tx.overwrite.update({ where: { id: existing.id }, data: { allow, deny } })
        : await tx.overwrite.create({
            data: {
              id: newId(),
              targetKind: input.targetKind,
              targetId: input.targetId,
              subjectKind: input.subjectKind,
              subjectId: input.subjectId,
              allow,
              deny,
            },
          });
      await this.audit.record(tx, {
        teamId,
        actorId: userId,
        action: 'overwrite.set',
        targetKind: input.targetKind,
        targetId: input.targetId,
        before: existing ? describe(existing) : null,
        after: describe(row),
      });
      return toDto(row);
    });
  }

  /** Removes one overwrite. Whoever may change it may remove it, and must hold what it allows or denies. */
  async clear(userId: string, overwriteId: string): Promise<void> {
    const existing = await this.prisma.overwrite.findUnique({ where: { id: overwriteId } });
    if (!existing) throw new NotFoundException();
    const target = await this.target(userId, existing.targetKind as OverwriteTarget, existing.targetId);
    if (!hasPermission(target.perms, target.manage)) throw new ForbiddenException('forbidden');
    if (((existing.allow | existing.deny) & ~target.perms) !== 0n) throw new ForbiddenException('permission_not_held');
    const subjectName = await this.subjectName(target, existing.subjectKind, existing.subjectId);

    await this.prisma.$transaction(async (tx) => {
      await tx.overwrite.delete({ where: { id: overwriteId } });
      await this.audit.record(tx, {
        teamId: target.team.team.id,
        actorId: userId,
        action: 'overwrite.clear',
        targetKind: existing.targetKind,
        targetId: existing.targetId,
        before: {
          subjectKind: existing.subjectKind,
          subjectId: existing.subjectId,
          subjectName,
          allow: permissionsToString(existing.allow),
          deny: permissionsToString(existing.deny),
        },
      });
    });
  }

  /** The subject must be something that can exist there: @everyone, a team role, a role of the project or above it, a team member. */
  private async requireSubject(target: Target, kind: 'role' | 'member', id: string): Promise<string> {
    if (kind === 'role') {
      const role = target.team.roles.find((r) => r.id === id);
      if (!role || (role.projectId !== null && !target.chain.includes(role.projectId))) throw new NotFoundException();
      return role.name;
    }
    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: target.team.team.id, userId: id } },
      include: { user: { select: { displayName: true } } },
    });
    if (!member) throw new UnprocessableEntityException('not_a_member');
    return member.nickname || member.user.displayName;
  }

  private async subjectName(target: Target, kind: string, id: string): Promise<string | null> {
    if (kind === 'role') return target.team.roles.find((r) => r.id === id)?.name ?? null;
    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: target.team.team.id, userId: id } },
      include: { user: { select: { displayName: true } } },
    });
    return member ? member.nickname || member.user.displayName : null;
  }
}
