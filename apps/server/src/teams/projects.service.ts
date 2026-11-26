import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  hasPermission,
  MAX_PROJECT_DEPTH,
  Permission,
  positionBetween,
  type CreateProjectInput,
  type MoveProjectInput,
  type ProjectDto,
  type ProjectMemberDto,
  type UpdateProjectInput,
} from '@os-planner/shared';
import { newId } from '../common/crypto.js';
import type { Project } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { QuotaService } from '../quota/quota.service.js';
import { AuditService } from '../roles/audit.service.js';
import { PermissionService } from '../spaces/permission.service.js';

const byPosition = <T extends { position: string }>(a: T, b: T) =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : 0;

/** Depth of a project from its path: "/team/p1/p2/" is 2. */
const depthOf = (path: string): number => path.split('/').filter(Boolean).length - 1;

const invalid = (message: string) => new UnprocessableEntityException(message);

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionService,
    private readonly quota: QuotaService,
    private readonly audit: AuditService,
  ) {}

  private toDto(p: Project, isMember: boolean): ProjectDto {
    return {
      id: p.id,
      teamId: p.teamId,
      parentId: p.parentId,
      name: p.name,
      description: p.description,
      icon: p.icon,
      color: p.color,
      position: p.position,
      spaceId: p.spaceId,
      archivedAt: p.archivedAt?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
      isMember,
    };
  }

  // ---------------------------------------------------------------- reading

  /** Every project of the team the person can see: all of them for whoever manages projects, otherwise the ones they belong to. */
  async list(userId: string, teamId: string): Promise<ProjectDto[]> {
    const team = await this.perms.teamAccess(userId, teamId);
    if (!team) throw new NotFoundException();
    const visible = await this.perms.visibleProjects(userId, team);
    return visible
      .sort((a, b) => byPosition(a.project, b.project))
      .map((v) => this.toDto(v.project, v.isMember));
  }

  async get(userId: string, id: string): Promise<ProjectDto> {
    const access = await this.perms.projectAccess(userId, id);
    if (!access) throw new NotFoundException();
    return this.toDto(access.project, access.isMember);
  }

  // ---------------------------------------------------------------- creating and changing

  async create(userId: string, teamId: string, input: CreateProjectInput): Promise<ProjectDto> {
    const team = await this.perms.teamAccess(userId, teamId);
    if (!team) throw new NotFoundException();
    if (!hasPermission(team.perms, Permission.MANAGE_PROJECTS))
      throw new ForbiddenException('forbidden');

    return this.prisma.$transaction(async (tx) => {
      if (input.id) {
        const existing = await tx.project.findUnique({ where: { id: input.id } });
        if (existing) {
          if (existing.teamId !== teamId || existing.deletedAt)
            throw new ConflictException('id_taken');
          return this.toDto(
            existing,
            (await tx.projectMember.count({ where: { projectId: existing.id, userId } })) > 0,
          );
        }
      }

      let parent: Project | null = null;
      if (input.parentId) {
        parent = await tx.project.findFirst({
          where: { id: input.parentId, teamId, deletedAt: null },
        });
        if (!parent) throw new NotFoundException();
        if (depthOf(parent.path) + 1 > MAX_PROJECT_DEPTH)
          throw invalid(`projects can nest at most ${MAX_PROJECT_DEPTH} levels`);
      }

      const limits = await this.quota.limitFor('team', teamId, tx);
      if (
        limits.maxProjects > 0 &&
        (await tx.project.count({ where: { teamId, deletedAt: null } })) >= limits.maxProjects
      ) {
        throw new ConflictException('project_limit_reached');
      }

      const id = input.id ?? newId();
      const spaceId = newId();
      const siblings = await tx.project.findMany({
        where: { teamId, parentId: parent?.id ?? null, deletedAt: null },
        select: { position: true },
      });
      const last =
        siblings
          .map((s) => s.position)
          .sort()
          .at(-1) ?? null;

      const row = await tx.project.create({
        data: {
          id,
          teamId,
          parentId: parent?.id ?? null,
          name: input.name,
          description: input.description ?? '',
          icon: input.icon ?? null,
          color: input.color ?? null,
          position: input.position ?? positionBetween(last, null),
          spaceId,
          path: `${parent?.path ?? `/${teamId}/`}${id}/`,
        },
      });
      await tx.space.create({ data: { id: spaceId, kind: 'project', projectId: id } });

      // The creator joins, unless that would put them in a sub-project without being in its parent.
      const inParent = parent
        ? (await tx.projectMember.count({ where: { projectId: parent.id, userId } })) > 0
        : true;
      if (inParent) await tx.projectMember.create({ data: { projectId: id, userId } });
      await this.audit.record(tx, {
        teamId,
        actorId: userId,
        action: 'project.create',
        targetKind: 'project',
        targetId: id,
        after: { name: row.name, parentId: row.parentId },
      });
      return this.toDto(row, inParent);
    });
  }

  /** The project and the permission check, for the actions that need MANAGE_PROJECTS. */
  private async manage(userId: string, id: string) {
    const access = await this.perms.projectAccess(userId, id);
    if (!access) throw new NotFoundException();
    if (!hasPermission(access.perms, Permission.MANAGE_PROJECTS))
      throw new ForbiddenException('forbidden');
    return access;
  }

  async update(userId: string, id: string, patch: UpdateProjectInput): Promise<ProjectDto> {
    const access = await this.manage(userId, id);
    const before = access.project;
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.project.update({
        where: { id },
        data: {
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.description !== undefined && { description: patch.description }),
          ...(patch.icon !== undefined && { icon: patch.icon }),
          ...(patch.color !== undefined && { color: patch.color }),
          ...(patch.position !== undefined && { position: patch.position }),
          ...(patch.archived !== undefined && {
            archivedAt: patch.archived ? (before.archivedAt ?? new Date()) : null,
          }),
        },
      });
      // Reordering siblings is not worth a line in the log; everything else is.
      const fields = ['name', 'description', 'icon', 'color'] as const;
      const changed = fields.filter((f) => before[f] !== updated[f]);
      const archivedChanged = (before.archivedAt === null) !== (updated.archivedAt === null);
      if (changed.length || archivedChanged)
        await this.audit.record(tx, {
          teamId: before.teamId,
          actorId: userId,
          action: 'project.update',
          targetKind: 'project',
          targetId: id,
          before: { ...Object.fromEntries(changed.map((f) => [f, before[f]])), ...(archivedChanged && { archived: before.archivedAt !== null }) },
          after: { ...Object.fromEntries(changed.map((f) => [f, updated[f]])), ...(archivedChanged && { archived: updated.archivedAt !== null }) },
        });
      return updated;
    });
    return this.toDto(row, access.isMember);
  }

  /** Soft delete of the project and everything below it; spaces are revoked in sync at once, and purged after 30 days. */
  async remove(userId: string, id: string): Promise<void> {
    const access = await this.manage(userId, id);
    await this.prisma.$transaction(async (tx) => {
      const subtree = await tx.project.findMany({
        where: { teamId: access.project.teamId, deletedAt: null, path: { startsWith: access.project.path } },
        select: { id: true },
      });
      const ids = subtree.map((p) => p.id);
      await tx.project.updateMany({ where: { id: { in: ids } }, data: { deletedAt: new Date() } });
      // The project's roles (and with them who held them) and every overwrite on it go at once.
      await tx.overwrite.deleteMany({ where: { targetKind: 'project', targetId: { in: ids } } });
      const roles = await tx.role.findMany({ where: { projectId: { in: ids } }, select: { id: true } });
      if (roles.length) {
        await tx.overwrite.deleteMany({ where: { subjectKind: 'role', subjectId: { in: roles.map((r) => r.id) } } });
        await tx.role.deleteMany({ where: { id: { in: roles.map((r) => r.id) } } });
      }
      await this.audit.record(tx, {
        teamId: access.project.teamId,
        actorId: userId,
        action: 'project.delete',
        targetKind: 'project',
        targetId: id,
        before: { name: access.project.name, subProjects: ids.length - 1, roles: roles.length },
      });
    });
  }

  /**
   * Moves a project (with its sub-projects) under another one, or to the top. The person needs
   * MANAGE_PROJECTS where it was and where it goes; it cannot go into itself or below itself, nor
   * into another team. People who are not members of the new parent are taken out of the moved
   * projects, so a sub-project never has a member its parent lacks.
   */
  async move(userId: string, id: string, input: MoveProjectInput): Promise<ProjectDto> {
    const access = await this.manage(userId, id);
    const project = access.project;

    let target: Project | null = null;
    if (input.parentId) {
      const dest = await this.perms.projectAccess(userId, input.parentId);
      if (!dest) throw new NotFoundException();
      if (!hasPermission(dest.perms, Permission.MANAGE_PROJECTS))
        throw new ForbiddenException('forbidden');
      target = dest.project;
      if (target.teamId !== project.teamId) throw invalid('a project cannot move to another team');
      if (target.id === project.id || target.path.startsWith(project.path))
        throw invalid('a project cannot be moved into itself or its own sub-project');
    }

    return this.prisma.$transaction(async (tx) => {
      const subtree = await tx.project.findMany({
        where: { teamId: project.teamId, path: { startsWith: project.path }, deletedAt: null },
        select: { id: true, path: true },
      });
      const height = Math.max(...subtree.map((p) => depthOf(p.path))) - depthOf(project.path) + 1;
      const newDepth = (target ? depthOf(target.path) : 0) + 1;
      if (newDepth + height - 1 > MAX_PROJECT_DEPTH)
        throw invalid(`projects can nest at most ${MAX_PROJECT_DEPTH} levels`);

      const oldPath = project.path;
      const newPath = `${target?.path ?? `/${project.teamId}/`}${project.id}/`;
      if (newPath !== oldPath) {
        await tx.$executeRaw`UPDATE \`Project\` SET \`path\` = CONCAT(${newPath}, SUBSTRING(\`path\`, ${oldPath.length + 1})) WHERE \`teamId\` = ${project.teamId} AND \`path\` LIKE ${`${oldPath.replace(/[\\%_]/g, '\\$&')}%`}`;
      }

      let position = input.position;
      if (!position) {
        const siblings = await tx.project.findMany({
          where: {
            teamId: project.teamId,
            parentId: target?.id ?? null,
            deletedAt: null,
            id: { not: id },
          },
          select: { position: true },
        });
        position = positionBetween(
          siblings
            .map((s) => s.position)
            .sort()
            .at(-1) ?? null,
          null,
        );
      }
      const row = await tx.project.update({
        where: { id },
        data: { parentId: target?.id ?? null, position },
      });

      if (target) {
        const allowed = (
          await tx.projectMember.findMany({
            where: { projectId: target.id },
            select: { userId: true },
          })
        ).map((m) => m.userId);
        await tx.projectMember.deleteMany({
          where: { projectId: { in: subtree.map((p) => p.id) }, userId: { notIn: allowed } },
        });
      }
      if (project.parentId !== row.parentId)
        await this.audit.record(tx, {
          teamId: project.teamId,
          actorId: userId,
          action: 'project.move',
          targetKind: 'project',
          targetId: id,
          before: { parentId: project.parentId },
          after: { parentId: row.parentId },
        });
      return this.toDto(
        row,
        (await tx.projectMember.count({ where: { projectId: id, userId } })) > 0,
      );
    });
  }

  // ---------------------------------------------------------------- members

  async members(userId: string, id: string): Promise<ProjectMemberDto[]> {
    const access = await this.perms.projectAccess(userId, id);
    if (!access) throw new NotFoundException();
    const rows = await this.prisma.projectMember.findMany({
      where: { projectId: id },
      include: { user: { select: { displayName: true } } },
      orderBy: { joinedAt: 'asc' },
    });
    const held = await this.prisma.memberRole.findMany({ where: { role: { projectId: id } }, select: { userId: true, roleId: true } });
    const rolesOf = new Map<string, string[]>();
    for (const h of held) (rolesOf.get(h.userId) ?? rolesOf.set(h.userId, []).get(h.userId)!).push(h.roleId);
    return rows.map((m) => ({
      userId: m.userId,
      displayName: m.user.displayName,
      roleIds: rolesOf.get(m.userId) ?? [],
      joinedAt: m.joinedAt.toISOString(),
    }));
  }

  /** The person must belong to the team and, for a sub-project, to its parent project. */
  async addMember(userId: string, id: string, targetId: string): Promise<ProjectMemberDto[]> {
    const access = await this.manage(userId, id);
    const project = access.project;
    if (
      (await this.prisma.teamMember.count({
        where: { teamId: project.teamId, userId: targetId },
      })) === 0
    )
      throw invalid('the person is not a member of the team');
    if (
      project.parentId &&
      (await this.prisma.projectMember.count({
        where: { projectId: project.parentId, userId: targetId },
      })) === 0
    ) {
      throw invalid('the person is not a member of the parent project');
    }
    await this.prisma.$transaction(async (tx) => {
      if ((await tx.projectMember.count({ where: { projectId: id, userId: targetId } })) > 0) return;
      await tx.projectMember.create({ data: { projectId: id, userId: targetId } });
      await this.audit.record(tx, {
        teamId: project.teamId,
        actorId: userId,
        action: 'project.member.add',
        targetKind: 'member',
        targetId,
        after: { projectId: id, projectName: project.name },
      });
    });
    return this.members(userId, id);
  }

  /** Takes the person out of the project and of every sub-project below it. People may leave on their own. */
  async removeMember(userId: string, id: string, targetId: string): Promise<void> {
    const access = await this.perms.projectAccess(userId, id);
    if (!access) throw new NotFoundException();
    if (targetId !== userId && !hasPermission(access.perms, Permission.MANAGE_PROJECTS))
      throw new ForbiddenException('forbidden');
    await this.prisma.$transaction(async (tx) => {
      if ((await tx.projectMember.count({ where: { projectId: id, userId: targetId } })) === 0) return;
      await this.dropFromSubtree(tx, access.project, targetId);
      await this.audit.record(tx, {
        teamId: access.project.teamId,
        actorId: userId,
        action: 'project.member.remove',
        targetKind: 'member',
        targetId,
        before: { projectId: id, projectName: access.project.name, left: targetId === userId },
      });
    });
  }

  /** Takes the person out of the project and everything below it, with the project roles and member overwrites they had there. */
  private async dropFromSubtree(tx: Tx, project: Project, userId: string): Promise<void> {
    const below = (
      await tx.project.findMany({
        where: { teamId: project.teamId, path: { startsWith: project.path } },
        select: { id: true },
      })
    ).map((p) => p.id);
    await tx.projectMember.deleteMany({ where: { userId, projectId: { in: below } } });
    await tx.memberRole.deleteMany({ where: { userId, role: { projectId: { in: below } } } });
    await tx.overwrite.deleteMany({
      where: { subjectKind: 'member', subjectId: userId, targetKind: 'project', targetId: { in: below } },
    });
  }
}
