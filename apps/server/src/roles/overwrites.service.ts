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
import { PermissionService, type ProjectAccess } from '../spaces/permission.service.js';
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

/**
 * Allow/deny overwrites on a project, for a role or a member. Only projects exist as targets today; the channel,
 * notebook and board kinds are accepted by the schema so the data model does not change when those arrive, and are
 * refused here until then.
 *
 * Rules: seeing the project comes first (404); changing its overwrites needs MANAGE_PROJECTS there (403); and a
 * person can only allow or deny permissions they hold in that project themselves.
 */
@Injectable()
export class OverwritesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionService,
    private readonly audit: AuditService,
  ) {}

  private async projectTarget(
    userId: string,
    kind: OverwriteTarget,
    id: string,
  ): Promise<ProjectAccess> {
    if (kind !== 'project') throw new UnprocessableEntityException('unsupported_target');
    const access = await this.perms.projectAccess(userId, id);
    if (!access) throw new NotFoundException();
    return access;
  }

  async list(userId: string, kind: OverwriteTarget, id: string): Promise<OverwriteDto[]> {
    const access = await this.projectTarget(userId, kind, id);
    if (
      !hasPermission(access.perms, Permission.MANAGE_PROJECTS) &&
      !hasPermission(access.perms, Permission.MANAGE_ROLES)
    )
      throw new ForbiddenException('forbidden');
    const rows = await this.prisma.overwrite.findMany({
      where: { targetKind: kind, targetId: id },
    });
    return rows.map(toDto);
  }

  /** Sets what a role or member is allowed and denied on the target. Allowing and denying nothing clears it. */
  async set(userId: string, input: SetOverwriteInput): Promise<OverwriteDto | null> {
    const access = await this.projectTarget(userId, input.targetKind, input.targetId);
    if (!hasPermission(access.perms, Permission.MANAGE_PROJECTS))
      throw new ForbiddenException('forbidden');
    const allow = permissionsFromString(input.allow) ?? 0n;
    const deny = permissionsFromString(input.deny) ?? 0n;
    if (((allow | deny) & ~access.perms) !== 0n)
      throw new ForbiddenException('permission_not_held');
    const subjectName = await this.requireSubject(access, input.subjectKind, input.subjectId);

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
      const teamId = access.team.team.id;
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
    const access = await this.projectTarget(
      userId,
      existing.targetKind as OverwriteTarget,
      existing.targetId,
    );
    if (!hasPermission(access.perms, Permission.MANAGE_PROJECTS))
      throw new ForbiddenException('forbidden');
    if (((existing.allow | existing.deny) & ~access.perms) !== 0n)
      throw new ForbiddenException('permission_not_held');
    const subjectName = await this.subjectName(access, existing.subjectKind, existing.subjectId);

    await this.prisma.$transaction(async (tx) => {
      await tx.overwrite.delete({ where: { id: overwriteId } });
      await this.audit.record(tx, {
        teamId: access.team.team.id,
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

  /** The subject must be something that can exist in the project: @everyone, a team role, a role of the project or above it, a team member. */
  private async requireSubject(
    access: ProjectAccess,
    kind: 'role' | 'member',
    id: string,
  ): Promise<string> {
    if (kind === 'role') {
      const role = access.team.roles.find((r) => r.id === id);
      if (!role || (role.projectId !== null && !access.chain.includes(role.projectId)))
        throw new NotFoundException();
      return role.name;
    }
    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: access.team.team.id, userId: id } },
      include: { user: { select: { displayName: true } } },
    });
    if (!member) throw new UnprocessableEntityException('not_a_member');
    return member.nickname || member.user.displayName;
  }

  private async subjectName(
    access: ProjectAccess,
    kind: string,
    id: string,
  ): Promise<string | null> {
    if (kind === 'role') return access.team.roles.find((r) => r.id === id)?.name ?? null;
    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: access.team.team.id, userId: id } },
      include: { user: { select: { displayName: true } } },
    });
    return member ? member.nickname || member.user.displayName : null;
  }
}
