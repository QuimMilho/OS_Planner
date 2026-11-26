import { Injectable } from '@nestjs/common';
import {
  DEFAULT_EVERYONE,
  canViewAnything,
  computePermissions,
  hasPermission,
  rankOf,
  Permission,
  type Level,
  type PermissionInput,
  type RoleActor,
} from '@os-planner/shared';
import type { Overwrite, Project, Role, Space, Team } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { forbidden, notFound } from '../tree/tree.error.js';

type Db = PrismaService | Tx;

/** The ids of the projects from the root down to (and including) the one at `path` ("/team/p1/p2/" -> [p1, p2]). */
export const chainIdsOf = (path: string): string[] => path.split('/').filter(Boolean).slice(1);

/** One project on the way down, with the overwrites set on it. */
export interface ChainLevel {
  id: string;
  overwrites: Overwrite[];
}

export interface TeamAccess {
  team: Team;
  /** What the person may do at team level (the base for everything below). */
  perms: bigint;
  isOwner: boolean;
  /** Every role of the team: team roles, project roles and @everyone. */
  roles: Role[];
  /** Ids of the roles the person holds (@everyone is implicit and not listed). */
  held: ReadonlySet<string>;
}

export interface ProjectAccess {
  project: Project;
  team: TeamAccess;
  /** Resolved permissions inside the project. */
  perms: bigint;
  isMember: boolean;
  /** Project ids from the root down to this project. */
  chain: string[];
}

export interface SpaceAccess {
  space: Space;
  perms: bigint;
  /** Set for team and project spaces. */
  teamId: string | null;
  projectId: string | null;
}

export interface VisibleProject {
  project: Project & { space: Space | null };
  isMember: boolean;
  perms: bigint;
}

/**
 * Who may do what, resolved from the shared permission engine (the web uses the same code to
 * show or hide controls; this is the authoritative copy).
 *
 * Seeing comes first: something the person cannot see answers 404, something they can see but
 * may not do answers 403. A team is visible to its members. A project is visible to whoever manages
 * projects, and to its members as long as their permissions there include a `VIEW_*` bit (an overwrite
 * can take every one of them away). A personal space is visible to its owner.
 *
 * Roles and overwrites are read in a few batched queries per question: the team's roles, the member's
 * role ids, and the overwrites of every project on the path.
 */
@Injectable()
export class PermissionService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- the engine's input

  /** Everything `computePermissions` needs for one member and one chain of projects. */
  buildInput(
    team: Team,
    roles: readonly Role[],
    held: ReadonlySet<string>,
    userId: string,
    chain: readonly ChainLevel[] = [],
  ): PermissionInput {
    const everyone = roles.find((r) => r.isEveryone);
    const inChain = new Set(chain.map((c) => c.id));
    // A project role only exists inside its project and below.
    const usable = roles.filter((r) => !r.isEveryone && (r.projectId === null || inChain.has(r.projectId)));

    const levels: Level[] = chain.map((c) => {
      const level: { ref: string; everyone?: { allow: bigint; deny: bigint }; roles: Record<string, { allow: bigint; deny: bigint }>; members: Record<string, { allow: bigint; deny: bigint }> } = {
        ref: c.id,
        roles: {},
        members: {},
      };
      for (const o of c.overwrites) {
        const pair = { allow: o.allow, deny: o.deny };
        if (o.subjectKind === 'member') {
          if (o.subjectId === userId) level.members[userId] = pair;
        } else if (everyone && o.subjectId === everyone.id) level.everyone = pair;
        else level.roles[o.subjectId] = pair;
      }
      return level;
    });

    return {
      userId,
      ownerId: team.ownerId,
      everyone: everyone?.permissions ?? DEFAULT_EVERYONE,
      roles: Object.fromEntries(usable.map((r) => [r.id, r.permissions])),
      memberRoleIds: [...held],
      chain: levels,
    };
  }

  /** The overwrites of these projects, by project id. One query. */
  async overwritesOf(db: Db, projectIds: readonly string[]): Promise<Map<string, Overwrite[]>> {
    const out = new Map<string, Overwrite[]>();
    if (!projectIds.length) return out;
    const rows = await db.overwrite.findMany({ where: { targetKind: 'project', targetId: { in: [...projectIds] } } });
    for (const o of rows) (out.get(o.targetId) ?? out.set(o.targetId, []).get(o.targetId)!).push(o);
    return out;
  }

  /** The projects on the way to `path`, each with its overwrites. */
  async chainLevels(db: Db, path: string): Promise<ChainLevel[]> {
    const ids = chainIdsOf(path);
    const overwrites = await this.overwritesOf(db, ids);
    return ids.map((id) => ({ id, overwrites: overwrites.get(id) ?? [] }));
  }

  // ---------------------------------------------------------------- team and project

  private async teamFromRow(team: Team, userId: string, db: Db): Promise<TeamAccess> {
    const [roles, held] = await Promise.all([
      db.role.findMany({ where: { teamId: team.id } }),
      db.memberRole.findMany({ where: { userId, role: { teamId: team.id } }, select: { roleId: true } }),
    ]);
    const heldIds = new Set(held.map((h) => h.roleId));
    const perms = computePermissions(this.buildInput(team, roles, heldIds, userId));
    return { team, perms, isOwner: team.ownerId === userId, roles, held: heldIds };
  }

  /** The team, if it exists, is not deleted and the person belongs to it. */
  async teamAccess(userId: string, teamId: string, db: Db = this.prisma): Promise<TeamAccess | null> {
    const team = await db.team.findFirst({
      where: { id: teamId, deletedAt: null, members: { some: { userId } } },
    });
    return team ? this.teamFromRow(team, userId, db) : null;
  }

  /** The project, if it is visible to the person (see the class comment). */
  async projectAccess(userId: string, projectId: string, db: Db = this.prisma): Promise<ProjectAccess | null> {
    const project = await db.project.findFirst({ where: { id: projectId, deletedAt: null } });
    if (!project) return null;
    const team = await this.teamAccess(userId, project.teamId, db);
    if (!team) return null;
    const isMember = (await db.projectMember.count({ where: { projectId, userId } })) > 0;
    const canManage = hasPermission(team.perms, Permission.MANAGE_PROJECTS);
    if (!isMember && !canManage) return null;
    const chain = await this.chainLevels(db, project.path);
    const perms = computePermissions(this.buildInput(team.team, team.roles, team.held, userId, chain));
    // Managers always see their projects, or nobody could ever repair an overwrite that hides one.
    if (!canManage && !canViewAnything(perms)) return null;
    return { project, team, isMember, perms, chain: chain.map((c) => c.id) };
  }

  /**
   * Every project of the team the person can see, with the permissions they have in it. Managers see all of them;
   * members see the ones they belong to unless an overwrite takes every `VIEW_*` permission away.
   */
  async visibleProjects(userId: string, team: TeamAccess, db: Db = this.prisma): Promise<VisibleProject[]> {
    const projects = await db.project.findMany({
      where: { teamId: team.team.id, deletedAt: null },
      include: { space: true },
    });
    if (!projects.length) return [];
    const mine = new Set(
      (await db.projectMember.findMany({ where: { userId, project: { teamId: team.team.id } }, select: { projectId: true } })).map(
        (m) => m.projectId,
      ),
    );
    const overwrites = await this.overwritesOf(db, [...new Set(projects.flatMap((p) => chainIdsOf(p.path)))]);
    const canManage = hasPermission(team.perms, Permission.MANAGE_PROJECTS);

    const out: VisibleProject[] = [];
    for (const project of projects) {
      const isMember = mine.has(project.id);
      if (!isMember && !canManage) continue;
      const chain = chainIdsOf(project.path).map((id) => ({ id, overwrites: overwrites.get(id) ?? [] }));
      const perms = computePermissions(this.buildInput(team.team, team.roles, team.held, userId, chain));
      if (!canManage && !canViewAnything(perms)) continue;
      out.push({ project, isMember, perms });
    }
    return out;
  }

  // ---------------------------------------------------------------- roles in a context

  /** Highest position among the person's roles that apply in a context: team roles, plus the project roles of `chain`. */
  rankIn(team: TeamAccess, chain: readonly string[] = []): number {
    const inChain = new Set(chain);
    return rankOf(
      team.roles
        .filter((r) => !r.isEveryone && team.held.has(r.id) && (r.projectId === null || inChain.has(r.projectId)))
        .map((r) => r.position),
    );
  }

  /** The person as the role rules see them, in a context (team level, or a project's chain). */
  actorIn(team: TeamAccess, perms: bigint, chain: readonly string[] = []): RoleActor {
    return {
      isOwner: team.isOwner,
      perms,
      rank: team.isOwner ? Number.POSITIVE_INFINITY : this.rankIn(team, chain),
    };
  }

  // ---------------------------------------------------------------- spaces

  /** The space, if the person can see the container that owns it. Null otherwise (answer 404). */
  async spaceAccess(userId: string, spaceId: string, db: Db = this.prisma): Promise<SpaceAccess | null> {
    const space = await db.space.findUnique({ where: { id: spaceId } });
    if (!space) return null;
    if (space.kind === 'personal') {
      return space.userId === userId
        ? {
            space,
            perms: computePermissions({ userId, ownerId: userId, everyone: 0n }),
            teamId: null,
            projectId: null,
          }
        : null;
    }
    if (space.kind === 'team' && space.teamId) {
      const team = await this.teamAccess(userId, space.teamId, db);
      return team ? { space, perms: team.perms, teamId: team.team.id, projectId: null } : null;
    }
    if (space.kind === 'project' && space.projectId) {
      const project = await this.projectAccess(userId, space.projectId, db);
      return project
        ? {
            space,
            perms: project.perms,
            teamId: project.team.team.id,
            projectId: project.project.id,
          }
        : null;
    }
    return null;
  }

  /**
   * The person's access to a space's notebooks, or an error: 404 when they cannot see them at all,
   * 403 when they can but lack `needed`.
   */
  async requireSpace(
    userId: string,
    spaceId: string,
    needed: bigint = Permission.VIEW_NOTEBOOKS,
    db: Db = this.prisma,
  ): Promise<SpaceAccess> {
    const access = await this.spaceAccess(userId, spaceId, db);
    if (!access || !hasPermission(access.perms, Permission.VIEW_NOTEBOOKS)) throw notFound();
    if (!hasPermission(access.perms, needed)) throw forbidden();
    return access;
  }

  /** Every space whose notebooks the person may see, with their permissions there: personal, teams, projects. */
  async notebookSpaces(userId: string, db: Db = this.prisma): Promise<Map<string, SpaceAccess>> {
    const out = new Map<string, SpaceAccess>();
    const personal = await db.space.findUnique({ where: { userId } });
    if (personal)
      out.set(personal.id, {
        space: personal,
        perms: computePermissions({ userId, ownerId: userId, everyone: 0n }),
        teamId: null,
        projectId: null,
      });

    const memberships = await db.teamMember.findMany({
      where: { userId, team: { deletedAt: null } },
      include: { team: { include: { space: true } } },
    });
    for (const m of memberships) {
      const team = await this.teamFromRow(m.team, userId, db);
      if (m.team.space && hasPermission(team.perms, Permission.VIEW_NOTEBOOKS))
        out.set(m.team.space.id, {
          space: m.team.space,
          perms: team.perms,
          teamId: m.team.id,
          projectId: null,
        });
      for (const v of await this.visibleProjects(userId, team, db)) {
        if (v.project.space && hasPermission(v.perms, Permission.VIEW_NOTEBOOKS))
          out.set(v.project.space.id, {
            space: v.project.space,
            perms: v.perms,
            teamId: m.team.id,
            projectId: v.project.id,
          });
      }
    }
    return out;
  }
}
