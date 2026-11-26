import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  checkReorder,
  checkRoleAction,
  hasPermission,
  Permission,
  permissionsFromString,
  permissionsToString,
  positionsForOrder,
  type CreateRoleInput,
  type RoleDto,
  type UpdateRoleInput,
} from '@os-planner/shared';
import { newId } from '../common/crypto.js';
import { ENV, type Env } from '../config/env.js';
import type { Role } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from './audit.service.js';
import {
  RoleHierarchy,
  targetOf,
  type RoleScope,
  type ScopeRef,
} from './role-hierarchy.service.js';

const bits = (value: string): bigint => permissionsFromString(value) ?? 0n;

/** What the audit log keeps of a role. */
const snapshot = (r: Role) => ({
  name: r.name,
  color: r.color,
  permissions: permissionsToString(r.permissions),
  hoist: r.hoist,
  mentionable: r.mentionable,
  position: r.position,
  projectId: r.projectId,
  isEveryone: r.isEveryone,
});

/** Roles of a team and of its projects, and who holds them. */
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hierarchy: RoleHierarchy,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private toDto(r: Role, memberCount: number): RoleDto {
    return {
      id: r.id,
      teamId: r.teamId,
      projectId: r.projectId,
      name: r.name,
      color: r.color,
      position: r.position,
      permissions: permissionsToString(r.permissions),
      hoist: r.hoist,
      mentionable: r.mentionable,
      isEveryone: r.isEveryone,
      memberCount,
      createdAt: r.createdAt.toISOString(),
    };
  }

  /** Roles of exactly this scope: the team's, or one project's. */
  private ownRoles(s: RoleScope): Role[] {
    return s.team.roles.filter((r) => r.projectId === s.projectId && !r.isEveryone);
  }

  private async requireRole(roleId: string) {
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role) throw new NotFoundException();
    return role;
  }

  // ---------------------------------------------------------------- reading

  /**
   * Any member may read the roles: the UI shows names and colours. At team level that is the team roles and
   * @everyone; inside a project it is the roles of that project and of the projects above it.
   */
  async list(userId: string, ref: ScopeRef): Promise<RoleDto[]> {
    const s = await this.hierarchy.scope(userId, ref);
    const chain = new Set(s.chain);
    const roles = s.team.roles.filter((r) =>
      s.projectId ? r.projectId !== null && chain.has(r.projectId) : r.projectId === null,
    );
    const counts = await this.prisma.memberRole.groupBy({
      by: ['roleId'],
      where: { roleId: { in: roles.map((r) => r.id) } },
      _count: { roleId: true },
    });
    const byRole = new Map(counts.map((c) => [c.roleId, c._count.roleId]));
    const everyoneCount = roles.some((r) => r.isEveryone)
      ? await this.prisma.teamMember.count({ where: { teamId: s.team.team.id } })
      : 0;
    return roles
      .sort((a, b) => b.position - a.position || a.name.localeCompare(b.name))
      .map((r) => this.toDto(r, r.isEveryone ? everyoneCount : (byRole.get(r.id) ?? 0)));
  }

  // ---------------------------------------------------------------- creating and changing

  async create(userId: string, ref: ScopeRef, input: CreateRoleInput): Promise<RoleDto> {
    const s = await this.hierarchy.scope(userId, ref);
    const permissions = bits(input.permissions);
    this.hierarchy.enforce(checkRoleAction(s.actor, 'create', null, permissions));

    return this.prisma.$transaction(async (tx) => {
      if (input.id) {
        const existing = await tx.role.findUnique({ where: { id: input.id } });
        if (existing) {
          if (existing.teamId !== s.team.team.id || existing.projectId !== s.projectId)
            throw new ConflictException('id_taken');
          return this.toDto(existing, 0);
        }
      }
      const teamId = s.team.team.id;
      if (
        (await tx.role.count({ where: { teamId, isEveryone: false } })) >=
        this.env.MAX_ROLES_PER_TEAM
      )
        throw new ConflictException('role_limit_reached');

      // New roles start at the bottom (position 1, just above @everyone); the others of the scope move up one.
      await tx.role.updateMany({
        where: { teamId, projectId: s.projectId, isEveryone: false },
        data: { position: { increment: 1 } },
      });
      const row = await tx.role.create({
        data: {
          id: input.id ?? newId(),
          teamId,
          projectId: s.projectId,
          name: input.name,
          color: input.color ?? null,
          position: 1,
          permissions,
          hoist: input.hoist,
          mentionable: input.mentionable,
        },
      });
      await this.audit.record(tx, {
        teamId,
        actorId: userId,
        action: 'role.create',
        targetKind: 'role',
        targetId: row.id,
        after: snapshot(row),
      });
      return this.toDto(row, 0);
    });
  }

  async update(userId: string, roleId: string, patch: UpdateRoleInput): Promise<RoleDto> {
    const role = await this.requireRole(roleId);
    const s = await this.hierarchy.scopeOfRole(userId, role);

    if (role.isEveryone) {
      // Only what @everyone is allowed to have changes: its permissions. Name, colour, grouping stay.
      const same =
        (patch.name === undefined || patch.name === role.name) &&
        (patch.color === undefined || patch.color === role.color) &&
        (patch.hoist === undefined || patch.hoist === role.hoist) &&
        (patch.mentionable === undefined || patch.mentionable === role.mentionable);
      if (!same) throw new ForbiddenException('everyone_protected');
    }
    const newPermissions = patch.permissions === undefined ? undefined : bits(patch.permissions);
    this.hierarchy.enforce(checkRoleAction(s.actor, 'edit', targetOf(role), newPermissions));

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.role.update({
        where: { id: roleId },
        data: {
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.color !== undefined && { color: patch.color }),
          ...(newPermissions !== undefined && { permissions: newPermissions }),
          ...(patch.hoist !== undefined && { hoist: patch.hoist }),
          ...(patch.mentionable !== undefined && { mentionable: patch.mentionable }),
        },
      });
      const before = snapshot(role);
      const after = snapshot(row);
      const changed = (Object.keys(after) as (keyof typeof after)[]).filter(
        (k) => before[k] !== after[k],
      );
      if (changed.length) {
        if (
          hasPermission(role.permissions, Permission.ADMINISTRATOR) &&
          !hasPermission(row.permissions, Permission.ADMINISTRATOR)
        )
          await this.hierarchy.assertAdministratorRemains(tx, role.teamId);
        await this.audit.record(tx, {
          teamId: role.teamId,
          actorId: userId,
          action: 'role.update',
          targetKind: 'role',
          targetId: roleId,
          before: Object.fromEntries(changed.map((k) => [k, before[k]])),
          after: Object.fromEntries(changed.map((k) => [k, after[k]])),
        });
      }
      return this.toDto(row, await tx.memberRole.count({ where: { roleId } }));
    });
  }

  /** Removes the role from everybody who held it and from every overwrite that named it, in one transaction. */
  async remove(userId: string, roleId: string): Promise<void> {
    const role = await this.requireRole(roleId);
    const s = await this.hierarchy.scopeOfRole(userId, role);
    this.hierarchy.enforce(checkRoleAction(s.actor, 'delete', targetOf(role)));

    await this.prisma.$transaction(async (tx) => {
      const holders = await tx.memberRole.count({ where: { roleId } });
      await tx.overwrite.deleteMany({ where: { subjectKind: 'role', subjectId: roleId } });
      await tx.role.delete({ where: { id: roleId } }); // member rows go with it (foreign key)
      if (hasPermission(role.permissions, Permission.ADMINISTRATOR))
        await this.hierarchy.assertAdministratorRemains(tx, role.teamId);
      await this.audit.record(tx, {
        teamId: role.teamId,
        actorId: userId,
        action: 'role.delete',
        targetKind: 'role',
        targetId: roleId,
        before: { ...snapshot(role), memberCount: holders },
      });
    });
  }

  /** Puts the roles of the scope in a new order (most powerful first). Positions are rewritten as n..1. */
  async reorder(userId: string, ref: ScopeRef, ids: string[]): Promise<RoleDto[]> {
    const s = await this.hierarchy.scope(userId, ref);
    const own = this.ownRoles(s);
    this.hierarchy.enforce(checkReorder(s.actor, own, ids));

    const positions = positionsForOrder(ids);
    const moved = own.filter((r) => positions.get(r.id) !== r.position);
    if (moved.length) {
      await this.prisma.$transaction(async (tx) => {
        for (const r of moved)
          await tx.role.update({ where: { id: r.id }, data: { position: positions.get(r.id)! } });
        const order = (list: Role[]) =>
          [...list].sort((a, b) => b.position - a.position).map((r) => r.id);
        await this.audit.record(tx, {
          teamId: s.team.team.id,
          actorId: userId,
          action: 'role.reorder',
          targetKind: s.projectId ? 'project' : 'team',
          targetId: s.projectId ?? s.team.team.id,
          before: { order: order(own) },
          after: { order: ids },
        });
      });
    }
    return this.list(userId, ref);
  }

  // ---------------------------------------------------------------- holding roles

  /**
   * Gives a role to a member. Team roles go to team members; a project role goes to a member of that project
   * (`ref` is the project). Giving what they already hold changes nothing and writes nothing.
   */
  async assign(userId: string, ref: ScopeRef, targetUserId: string, roleId: string): Promise<void> {
    const s = await this.hierarchy.scope(userId, ref);
    const role = await this.roleInScope(s, roleId);
    await this.requireHolder(s, targetUserId);
    this.hierarchy.enforce(checkRoleAction(s.actor, 'assign', targetOf(role)));

    if (
      await this.prisma.memberRole.findUnique({
        where: { userId_roleId: { userId: targetUserId, roleId } },
      })
    )
      return;
    await this.prisma.$transaction(async (tx) => {
      await tx.memberRole.create({ data: { userId: targetUserId, roleId } });
      await this.audit.record(tx, {
        teamId: s.team.team.id,
        actorId: userId,
        action: 'role.assign',
        targetKind: 'member',
        targetId: targetUserId,
        after: { roleId, roleName: role.name, projectId: role.projectId },
      });
    });
  }

  async unassign(
    userId: string,
    ref: ScopeRef,
    targetUserId: string,
    roleId: string,
  ): Promise<void> {
    const s = await this.hierarchy.scope(userId, ref);
    const role = await this.roleInScope(s, roleId);
    this.hierarchy.enforce(checkRoleAction(s.actor, 'unassign', targetOf(role)));

    if (
      !(await this.prisma.memberRole.findUnique({
        where: { userId_roleId: { userId: targetUserId, roleId } },
      }))
    )
      return;
    await this.prisma.$transaction(async (tx) => {
      await tx.memberRole.delete({ where: { userId_roleId: { userId: targetUserId, roleId } } });
      if (hasPermission(role.permissions, Permission.ADMINISTRATOR))
        await this.hierarchy.assertAdministratorRemains(tx, s.team.team.id);
      await this.audit.record(tx, {
        teamId: s.team.team.id,
        actorId: userId,
        action: 'role.unassign',
        targetKind: 'member',
        targetId: targetUserId,
        before: { roleId, roleName: role.name, projectId: role.projectId },
      });
    });
  }

  /** A role that can be given or taken in this scope: not @everyone, and of the team (or of exactly this project). */
  private async roleInScope(s: RoleScope, roleId: string): Promise<Role> {
    const role = s.team.roles.find((r) => r.id === roleId);
    if (!role || role.isEveryone || role.projectId !== s.projectId) throw new NotFoundException();
    return role;
  }

  /** The member must belong to the team (team roles) or to the project (project roles). */
  private async requireHolder(s: RoleScope, targetUserId: string): Promise<void> {
    const ok = s.projectId
      ? (await this.prisma.projectMember.count({
          where: { projectId: s.projectId, userId: targetUserId },
        })) > 0
      : (await this.prisma.teamMember.count({
          where: { teamId: s.team.team.id, userId: targetUserId },
        })) > 0;
    if (!ok) {
      if (s.projectId) throw new UnprocessableEntityException('not_a_member');
      throw new NotFoundException();
    }
  }
}
