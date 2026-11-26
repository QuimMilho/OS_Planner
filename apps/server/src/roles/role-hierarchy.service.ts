import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  hasPermission,
  Permission,
  type RoleActor,
  type RoleDenial,
  type RoleTarget,
} from '@os-planner/shared';
import type { Role } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import {
  PermissionService,
  type ProjectAccess,
  type TeamAccess,
} from '../spaces/permission.service.js';

/** Where a role question is asked: at team level, or inside one project (and so its sub-projects). */
export type ScopeRef =
  { teamId: string; projectId?: undefined } | { projectId: string; teamId?: undefined };

export interface RoleScope {
  team: TeamAccess;
  project: ProjectAccess | null;
  /** What the person may do in this context. */
  perms: bigint;
  /** Project ids from the root down to this project (empty at team level). */
  chain: string[];
  /** The project the roles of this scope belong to; null for team roles. */
  projectId: string | null;
  actor: RoleActor;
}

export const targetOf = (r: Role): RoleTarget => ({
  position: r.position,
  isEveryone: r.isEveryone,
  permissions: r.permissions,
});

/**
 * Every rule about who may touch roles lives here, on top of the pure rules in @os-planner/shared
 * (`checkRoleAction`, `checkReorder`, which the web UI also runs to hide what would be refused).
 * Errors: 404 for someone who cannot see the team or project at all, 403 for a member who may not do it.
 */
@Injectable()
export class RoleHierarchy {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionService,
  ) {}

  /** The person's standing in a scope, or a 404 when they cannot see the team (or project). */
  async scope(
    userId: string,
    ref: ScopeRef,
    db: PrismaService | Tx = this.prisma,
  ): Promise<RoleScope> {
    if (ref.projectId !== undefined) {
      const project = await this.perms.projectAccess(userId, ref.projectId, db);
      if (!project) throw new NotFoundException();
      return {
        team: project.team,
        project,
        perms: project.perms,
        chain: project.chain,
        projectId: project.project.id,
        actor: this.perms.actorIn(project.team, project.perms, project.chain),
      };
    }
    const team = await this.perms.teamAccess(userId, ref.teamId, db);
    if (!team) throw new NotFoundException();
    return {
      team,
      project: null,
      perms: team.perms,
      chain: [],
      projectId: null,
      actor: this.perms.actorIn(team, team.perms),
    };
  }

  /** The scope a stored role belongs to. */
  scopeOfRole(
    userId: string,
    role: Role,
    db: PrismaService | Tx = this.prisma,
  ): Promise<RoleScope> {
    return this.scope(
      userId,
      role.projectId ? { projectId: role.projectId } : { teamId: role.teamId },
      db,
    );
  }

  /** Turns a refusal from the shared rules into the HTTP error. */
  enforce(denial: RoleDenial | null): void {
    if (!denial) return;
    if (denial === 'invalid_order') throw new UnprocessableEntityException(denial);
    throw new ForbiddenException(denial);
  }

  /**
   * After a change that could remove administrative power, there must still be somebody who has it: the owner (who is
   * a member), or at least one member holding `ADMINISTRATOR` through @everyone or a team role. Otherwise 422
   * `last_administrator` and the caller's transaction rolls back. (An owner always remains while the account exists;
   * the rule is what keeps a team whose owner account was deleted from losing its last administrator.)
   */
  async assertAdministratorRemains(tx: Tx, teamId: string): Promise<void> {
    const team = await tx.team.findUnique({ where: { id: teamId }, select: { ownerId: true } });
    if (
      team?.ownerId &&
      (await tx.teamMember.count({ where: { teamId, userId: team.ownerId } })) > 0
    )
      return;

    const roles = await tx.role.findMany({ where: { teamId, projectId: null } });
    const everyone = roles.find((r) => r.isEveryone);
    if (
      everyone &&
      hasPermission(everyone.permissions, Permission.ADMINISTRATOR) &&
      (await tx.teamMember.count({ where: { teamId } })) > 0
    )
      return;
    const adminRoles = roles
      .filter((r) => !r.isEveryone && hasPermission(r.permissions, Permission.ADMINISTRATOR))
      .map((r) => r.id);
    if (
      adminRoles.length &&
      (await tx.memberRole.count({
        where: { roleId: { in: adminRoles }, user: { teamMemberships: { some: { teamId } } } },
      })) > 0
    )
      return;
    throw new UnprocessableEntityException('last_administrator');
  }
}
