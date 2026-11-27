import { Injectable } from '@nestjs/common';
import {
  DEFAULT_EVERYONE,
  canViewAnything,
  computePermissions,
  hasPermission,
  permissionsForShare,
  permissionsToString,
  rankOf,
  Permission,
  type ShareAccess,
  type Level,
  type PermissionInput,
  type RoleActor,
} from '@os-planner/shared';
import type { Board, Channel, Notebook, NotebookShare, Overwrite, Project, Role, Space, Team } from '../generated/prisma/client.js';
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

/** Where chat happens: the team or project a space belongs to, and what the person may do there before any channel overwrite. */
export interface ChatSpace {
  space: Space;
  teamId: string;
  projectId: string | null;
  team: TeamAccess;
  /** Permissions in the team or project that owns the space. */
  perms: bigint;
  /** The overwrites of the projects on the way down (empty for a team space). */
  levels: ChainLevel[];
}

export interface ChannelAccess {
  channel: Channel;
  chat: ChatSpace;
  /** What the person may do in this channel: roles, project overwrites, then the category's and the channel's own. */
  perms: bigint;
}

/** What a person may do in one notebook, and how they come by it. */
export interface NotebookAccess {
  notebook: Notebook;
  /** Permissions in the notebook: the space's (with the notebook's overwrites) or those of the share. */
  perms: bigint;
  via: 'space' | 'share';
  /** The share, when that is how the person has access. */
  share: NotebookShare | null;
  /** Set for notebooks of a team or project. */
  chat: ChatSpace | null;
}

/** What a person may do on one board, and where it lives. */
export interface BoardAccess {
  board: Board;
  /** Permissions on the board: the space's (with the board's overwrites). A personal board's owner holds everything. */
  perms: bigint;
  /** Set for boards of a team or project; null for a personal board. */
  chat: ChatSpace | null;
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

  /** The overwrites of these projects (or channels, with `kind`), by target id. One query. */
  async overwritesOf(db: Db, projectIds: readonly string[], kind: 'project' | 'channel' | 'notebook' | 'board' = 'project'): Promise<Map<string, Overwrite[]>> {
    const out = new Map<string, Overwrite[]>();
    if (!projectIds.length) return out;
    const rows = await db.overwrite.findMany({ where: { targetKind: kind, targetId: { in: [...projectIds] } } });
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

  // ---------------------------------------------------------------- chat: channels

  /** The team or project a space belongs to, if the person can see it. Personal spaces have no chat: null. */
  async chatSpace(userId: string, spaceId: string, db: Db = this.prisma): Promise<ChatSpace | null> {
    const space = await db.space.findUnique({ where: { id: spaceId } });
    if (!space) return null;
    if (space.kind === 'team' && space.teamId) {
      const team = await this.teamAccess(userId, space.teamId, db);
      return team ? { space, teamId: team.team.id, projectId: null, team, perms: team.perms, levels: [] } : null;
    }
    if (space.kind === 'project' && space.projectId) {
      const project = await this.projectAccess(userId, space.projectId, db);
      if (!project) return null;
      const levels = await this.chainLevels(db, project.project.path);
      return { space, teamId: project.team.team.id, projectId: project.project.id, team: project.team, perms: project.perms, levels };
    }
    return null;
  }

  /** Permissions in a channel: the container's chain of overwrites, then its category's, then its own. */
  channelPerms(userId: string, chat: ChatSpace, channel: Pick<Channel, 'id' | 'parentId'>, overwrites: ReadonlyMap<string, Overwrite[]>): bigint {
    const levels: ChainLevel[] = [...chat.levels];
    if (channel.parentId) levels.push({ id: channel.parentId, overwrites: overwrites.get(channel.parentId) ?? [] });
    levels.push({ id: channel.id, overwrites: overwrites.get(channel.id) ?? [] });
    return computePermissions(this.buildInput(chat.team.team, chat.team.roles, chat.team.held, userId, levels));
  }

  /**
   * A channel (or category) the person can see (VIEW_CHANNEL there), with what they may do in it. Null otherwise, which
   * every caller answers with 404: a channel that is hidden looks exactly like one that does not exist.
   */
  async channelAccess(userId: string, channelId: string, db: Db = this.prisma): Promise<ChannelAccess | null> {
    const channel = await db.channel.findUnique({ where: { id: channelId } });
    if (!channel?.spaceId) return null; // a direct message belongs to no team: see DirectAccess
    const chat = await this.chatSpace(userId, channel.spaceId, db);
    if (!chat) return null;
    const ids = channel.parentId ? [channel.id, channel.parentId] : [channel.id];
    const perms = this.channelPerms(userId, chat, channel, await this.overwritesOf(db, ids, 'channel'));
    return hasPermission(perms, Permission.VIEW_CHANNEL) ? { channel, chat, perms } : null;
  }

  /**
   * Which of these people can see the channel (VIEW_CHANNEL), worked out for all of them with a handful of queries: the team's
   * roles, their roles, the project chain and the overwrites are read once. Used to decide who may be told about a message,
   * so it must agree with `channelAccess` for every single person.
   */
  async channelViewers(channel: Channel, candidateIds: readonly string[], db: Db = this.prisma): Promise<Set<string>> {
    const viewers = new Set<string>();
    if (!channel.spaceId || !candidateIds.length) return viewers;
    const space = await db.space.findUnique({ where: { id: channel.spaceId } });
    if (!space) return viewers;
    let project: Project | null = null;
    let teamId = space.teamId;
    if (space.kind === 'project' && space.projectId) {
      project = await db.project.findFirst({ where: { id: space.projectId, deletedAt: null } });
      if (!project) return viewers;
      teamId = project.teamId;
    }
    if (!teamId) return viewers;
    const team = await db.team.findFirst({ where: { id: teamId, deletedAt: null } });
    if (!team) return viewers;

    const ids = [...new Set(candidateIds)];
    const members = new Set((await db.teamMember.findMany({ where: { teamId, userId: { in: ids } }, select: { userId: true } })).map((m) => m.userId));
    if (!members.size) return viewers;
    const memberIds = [...members];
    const [roles, held, projectMembers, chain, overwrites] = await Promise.all([
      db.role.findMany({ where: { teamId } }),
      db.memberRole.findMany({ where: { userId: { in: memberIds }, role: { teamId } }, select: { userId: true, roleId: true } }),
      project ? db.projectMember.findMany({ where: { projectId: project.id, userId: { in: memberIds } }, select: { userId: true } }) : [],
      project ? this.chainLevels(db, project.path) : [],
      this.overwritesOf(db, channel.parentId ? [channel.id, channel.parentId] : [channel.id], 'channel'),
    ]);
    const heldBy = new Map<string, Set<string>>();
    for (const h of held) (heldBy.get(h.userId) ?? heldBy.set(h.userId, new Set()).get(h.userId)!).add(h.roleId);
    const inProject = new Set(projectMembers.map((m) => m.userId));

    for (const userId of memberIds) {
      const heldIds = heldBy.get(userId) ?? new Set<string>();
      const teamPerms = computePermissions(this.buildInput(team, roles, heldIds, userId));
      let perms = teamPerms;
      if (project) {
        const canManage = hasPermission(teamPerms, Permission.MANAGE_PROJECTS);
        if (!inProject.has(userId) && !canManage) continue;
        perms = computePermissions(this.buildInput(team, roles, heldIds, userId, chain));
        if (!canManage && !canViewAnything(perms)) continue;
      }
      const access: TeamAccess = { team, perms: teamPerms, isOwner: team.ownerId === userId, roles, held: heldIds };
      const chat: ChatSpace = { space, teamId, projectId: project?.id ?? null, team: access, perms, levels: chain };
      if (hasPermission(this.channelPerms(userId, chat, channel, overwrites), Permission.VIEW_CHANNEL)) viewers.add(userId);
    }
    return viewers;
  }

  /** Every channel of the space with the person's permissions in it (visible or not: callers filter). */
  async channelsOf(userId: string, chat: ChatSpace, db: Db = this.prisma): Promise<{ channel: Channel; perms: bigint }[]> {
    const channels = await db.channel.findMany({ where: { spaceId: chat.space.id } });
    const overwrites = await this.overwritesOf(db, channels.map((c) => c.id), 'channel');
    return channels.map((channel) => ({ channel, perms: this.channelPerms(userId, chat, channel, overwrites) }));
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

  // ---------------------------------------------------------------- one notebook

  /** Permissions in a notebook of a team or project: the container's, then the notebook's own overwrites. */
  notebookPerms(userId: string, chat: ChatSpace, notebookId: string, overwrites: ReadonlyMap<string, Overwrite[]>): bigint {
    const levels: ChainLevel[] = [...chat.levels, { id: notebookId, overwrites: overwrites.get(notebookId) ?? [] }];
    return computePermissions(this.buildInput(chat.team.team, chat.team.roles, chat.team.held, userId, levels));
  }

  /**
   * The notebook, if the person can see it (VIEW_NOTEBOOKS there), with what they may do in it. Null otherwise, which
   * every caller answers with 404: a notebook that is hidden looks exactly like one that does not exist.
   *
   * Three ways in: the space (own personal space, or a team or project with the notebook's overwrites applied), or a
   * direct share (personal notebooks only; also what an edit link turns into). Trashed notebooks are included: callers decide.
   */
  async notebookAccess(userId: string, notebookId: string, db: Db = this.prisma): Promise<NotebookAccess | null> {
    const notebook = await db.notebook.findUnique({ where: { id: notebookId } });
    if (!notebook) return null;
    const space = await db.space.findUnique({ where: { id: notebook.spaceId } });
    if (!space) return null;

    if (space.kind === 'personal') {
      if (space.userId === userId)
        return { notebook, perms: computePermissions({ userId, ownerId: userId, everyone: 0n }), via: 'space', share: null, chat: null };
      const share = await db.notebookShare.findUnique({ where: { notebookId_userId: { notebookId, userId } } });
      if (!share) return null;
      return { notebook, perms: permissionsForShare(share.access as ShareAccess), via: 'share', share, chat: null };
    }

    const chat = await this.chatSpace(userId, space.id, db);
    if (!chat) return null;
    const perms = this.notebookPerms(userId, chat, notebookId, await this.overwritesOf(db, [notebookId], 'notebook'));
    return hasPermission(perms, Permission.VIEW_NOTEBOOKS) ? { notebook, perms, via: 'space', share: null, chat } : null;
  }

  /** The person's access to a notebook, or an error: 404 when they cannot see it, 403 when they can but lack `needed`. */
  async requireNotebook(userId: string, notebookId: string, needed: bigint = Permission.VIEW_NOTEBOOKS, db: Db = this.prisma): Promise<NotebookAccess> {
    const access = await this.notebookAccess(userId, notebookId, db);
    if (!access) throw notFound();
    if (!hasPermission(access.perms, needed)) throw forbidden();
    return access;
  }

  /**
   * The notebooks of a team or project space the person may not see (a notebook overwrite denies VIEW_NOTEBOOKS).
   * Empty for a personal space and for people who can see everything. Sync leaves these out.
   */
  async hiddenNotebooks(userId: string, spaceId: string, db: Db = this.prisma): Promise<Set<string>> {
    const hidden = new Set<string>();
    const chat = await this.chatSpace(userId, spaceId, db);
    if (!chat) return hidden;
    const notebooks = await db.notebook.findMany({ where: { spaceId }, select: { id: true } });
    if (!notebooks.length) return hidden;
    const overwrites = await this.overwritesOf(db, notebooks.map((n) => n.id), 'notebook');
    if (!overwrites.size) return hidden;
    for (const n of notebooks) {
      if (!overwrites.has(n.id)) continue;
      if (!hasPermission(this.notebookPerms(userId, chat, n.id, overwrites), Permission.VIEW_NOTEBOOKS)) hidden.add(n.id);
    }
    return hidden;
  }

  /**
   * What the person may do in each notebook of their teams and projects (the ones they can see), and in each notebook shared
   * with them, as decimal strings by notebook id. Their own notebooks are not listed: they can do everything there. The web app
   * keeps this next to the notebooks so controls show or hide without asking, also offline.
   */
  async notebookPermissions(userId: string, db: Db = this.prisma): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [spaceId, access] of await this.notebookSpaces(userId, db)) {
      if (access.space.kind === 'personal') continue;
      const chat = await this.chatSpace(userId, spaceId, db);
      if (!chat) continue;
      // Trashed notebooks too: the trash page restores them.
      const ids = (await db.notebook.findMany({ where: { spaceId }, select: { id: true } })).map((n) => n.id);
      const overwrites = await this.overwritesOf(db, ids, 'notebook');
      for (const id of ids) {
        const perms = this.notebookPerms(userId, chat, id, overwrites);
        if (hasPermission(perms, Permission.VIEW_NOTEBOOKS)) out[id] = permissionsToString(perms);
      }
    }
    for (const s of await this.sharesOf(userId, db)) out[s.notebookId] = permissionsToString(permissionsForShare(s.access as ShareAccess));
    return out;
  }

  /** Every notebook shared with the person (not trashed), with the share. */
  sharesOf(userId: string, db: Db = this.prisma): Promise<(NotebookShare & { notebook: Notebook })[]> {
    return db.notebookShare.findMany({ where: { userId, notebook: { deletedAt: null } }, include: { notebook: true } });
  }

  // ---------------------------------------------------------------- boards

  /** Permissions on a board of a team or project: the container's, then the board's own overwrites. */
  boardPerms(userId: string, chat: ChatSpace, boardId: string, overwrites: ReadonlyMap<string, Overwrite[]>): bigint {
    const levels: ChainLevel[] = [...chat.levels, { id: boardId, overwrites: overwrites.get(boardId) ?? [] }];
    return computePermissions(this.buildInput(chat.team.team, chat.team.roles, chat.team.held, userId, levels));
  }

  /**
   * The board, if the person can see it (VIEW_BOARDS there), with what they may do on it. Null otherwise, which every caller
   * answers with 404: a board that is hidden looks exactly like one that does not exist. A personal board is its owner's alone.
   * Trashed boards are included: callers decide.
   */
  async boardAccess(userId: string, boardId: string, db: Db = this.prisma): Promise<BoardAccess | null> {
    const board = await db.board.findUnique({ where: { id: boardId } });
    if (!board) return null;
    const space = await db.space.findUnique({ where: { id: board.spaceId } });
    if (!space) return null;
    if (space.kind === 'personal')
      return space.userId === userId ? { board, perms: computePermissions({ userId, ownerId: userId, everyone: 0n }), chat: null } : null;
    const chat = await this.chatSpace(userId, space.id, db);
    if (!chat) return null;
    const perms = this.boardPerms(userId, chat, boardId, await this.overwritesOf(db, [boardId], 'board'));
    return hasPermission(perms, Permission.VIEW_BOARDS) ? { board, perms, chat } : null;
  }

  /** The person's access to a board, or an error: 404 when they cannot see it, 403 when they can but lack `needed`. */
  async requireBoard(userId: string, boardId: string, needed: bigint = Permission.VIEW_BOARDS, db: Db = this.prisma): Promise<BoardAccess> {
    const access = await this.boardAccess(userId, boardId, db);
    if (!access) throw notFound();
    if (!hasPermission(access.perms, needed)) throw forbidden();
    return access;
  }

  /**
   * The person's access to a space's boards and labels, or an error: 404 when they cannot see boards there at all, 403 when
   * they can but lack `needed` (MANAGE_BOARDS to create a board, MANAGE_LABELS for labels, CREATE_TASKS to add a task).
   */
  async requireBoardSpace(userId: string, spaceId: string, needed: bigint = Permission.VIEW_BOARDS, db: Db = this.prisma): Promise<SpaceAccess> {
    const access = await this.spaceAccess(userId, spaceId, db);
    if (!access || !hasPermission(access.perms, Permission.VIEW_BOARDS)) throw notFound();
    if (!hasPermission(access.perms, needed)) throw forbidden();
    return access;
  }

  /** The boards of a team or project space the person may not see (a board overwrite denies VIEW_BOARDS). Sync leaves these out. */
  async hiddenBoards(userId: string, spaceId: string, db: Db = this.prisma): Promise<Set<string>> {
    const hidden = new Set<string>();
    const chat = await this.chatSpace(userId, spaceId, db);
    if (!chat) return hidden;
    const boards = await db.board.findMany({ where: { spaceId }, select: { id: true } });
    if (!boards.length) return hidden;
    const overwrites = await this.overwritesOf(db, boards.map((b) => b.id), 'board');
    if (!overwrites.size) return hidden;
    for (const b of boards) {
      if (!overwrites.has(b.id)) continue;
      if (!hasPermission(this.boardPerms(userId, chat, b.id, overwrites), Permission.VIEW_BOARDS)) hidden.add(b.id);
    }
    return hidden;
  }

  /**
   * What the person may do on each board they can see and in each space whose boards they can see, as decimal strings. The web
   * app keeps this next to the boards so controls show or hide without asking, also offline.
   */
  async boardPermissions(userId: string, db: Db = this.prisma): Promise<{ boards: Record<string, string>; spaces: Record<string, string> }> {
    const out = { boards: {} as Record<string, string>, spaces: {} as Record<string, string> };
    for (const [spaceId, access] of await this.boardSpaces(userId, db)) {
      out.spaces[spaceId] = permissionsToString(access.perms);
      const ids = (await db.board.findMany({ where: { spaceId }, select: { id: true } })).map((b) => b.id);
      if (access.space.kind === 'personal') {
        for (const id of ids) out.boards[id] = permissionsToString(access.perms);
        continue;
      }
      const chat = await this.chatSpace(userId, spaceId, db);
      if (!chat) continue;
      const overwrites = await this.overwritesOf(db, ids, 'board');
      for (const id of ids) {
        const perms = this.boardPerms(userId, chat, id, overwrites);
        if (hasPermission(perms, Permission.VIEW_BOARDS)) out.boards[id] = permissionsToString(perms);
      }
    }
    return out;
  }

  /** Every space whose boards the person may see (VIEW_BOARDS in it), with their permissions there. */
  boardSpaces(userId: string, db: Db = this.prisma): Promise<Map<string, SpaceAccess>> {
    return this.notebookSpaces(userId, db, Permission.VIEW_BOARDS);
  }

  /**
   * Which of these people can see the board (VIEW_BOARDS), worked out for all of them with a handful of queries. Used to decide
   * who may be assigned a task or told about a comment, so it must agree with `boardAccess` for every single person.
   */
  async boardViewers(board: Pick<Board, 'id' | 'spaceId'>, candidateIds: readonly string[], db: Db = this.prisma): Promise<Set<string>> {
    const viewers = new Set<string>();
    if (!candidateIds.length) return viewers;
    const space = await db.space.findUnique({ where: { id: board.spaceId } });
    if (!space) return viewers;
    if (space.kind === 'personal') {
      if (space.userId && candidateIds.includes(space.userId)) viewers.add(space.userId);
      return viewers;
    }
    let project: Project | null = null;
    let teamId = space.teamId;
    if (space.kind === 'project' && space.projectId) {
      project = await db.project.findFirst({ where: { id: space.projectId, deletedAt: null } });
      if (!project) return viewers;
      teamId = project.teamId;
    }
    if (!teamId) return viewers;
    const team = await db.team.findFirst({ where: { id: teamId, deletedAt: null } });
    if (!team) return viewers;

    const ids = [...new Set(candidateIds)];
    const members = new Set((await db.teamMember.findMany({ where: { teamId, userId: { in: ids } }, select: { userId: true } })).map((m) => m.userId));
    if (!members.size) return viewers;
    const memberIds = [...members];
    const [roles, held, projectMembers, chain, overwrites] = await Promise.all([
      db.role.findMany({ where: { teamId } }),
      db.memberRole.findMany({ where: { userId: { in: memberIds }, role: { teamId } }, select: { userId: true, roleId: true } }),
      project ? db.projectMember.findMany({ where: { projectId: project.id, userId: { in: memberIds } }, select: { userId: true } }) : [],
      project ? this.chainLevels(db, project.path) : [],
      this.overwritesOf(db, [board.id], 'board'),
    ]);
    const heldBy = new Map<string, Set<string>>();
    for (const h of held) (heldBy.get(h.userId) ?? heldBy.set(h.userId, new Set()).get(h.userId)!).add(h.roleId);
    const inProject = new Set(projectMembers.map((m) => m.userId));

    for (const userId of memberIds) {
      const heldIds = heldBy.get(userId) ?? new Set<string>();
      const teamPerms = computePermissions(this.buildInput(team, roles, heldIds, userId));
      let perms = teamPerms;
      if (project) {
        const canManage = hasPermission(teamPerms, Permission.MANAGE_PROJECTS);
        if (!inProject.has(userId) && !canManage) continue;
        perms = computePermissions(this.buildInput(team, roles, heldIds, userId, chain));
        if (!canManage && !canViewAnything(perms)) continue;
      }
      const levels: ChainLevel[] = [...chain, { id: board.id, overwrites: overwrites.get(board.id) ?? [] }];
      const final = computePermissions(this.buildInput(team, roles, heldIds, userId, levels));
      if (hasPermission(final, Permission.VIEW_BOARDS)) viewers.add(userId);
    }
    return viewers;
  }

  // ---------------------------------------------------------------- calendar

  /** Every space whose calendar the person may see (VIEW_CALENDAR in it), with their permissions there. Personal space included. */
  calendarSpaces(userId: string, db: Db = this.prisma): Promise<Map<string, SpaceAccess>> {
    return this.notebookSpaces(userId, db, Permission.VIEW_CALENDAR);
  }

  /**
   * The person's access to a space's calendar, or an error: 404 when they cannot see it at all, 403 when they can but lack `needed`
   * (CREATE_MEETINGS to make one, MANAGE_MEETINGS to change other people's, ADD_TO_MEMBER_CALENDARS to name others).
   */
  async requireCalendarSpace(userId: string, spaceId: string, needed: bigint = Permission.VIEW_CALENDAR, db: Db = this.prisma): Promise<SpaceAccess> {
    const access = await this.spaceAccess(userId, spaceId, db);
    if (!access || !hasPermission(access.perms, Permission.VIEW_CALENDAR)) throw notFound();
    if (!hasPermission(access.perms, needed)) throw forbidden();
    return access;
  }

  /** What the person may do in each space whose calendar they can see, as decimal strings (the web keeps it for offline use). */
  async calendarPermissions(userId: string, db: Db = this.prisma): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [spaceId, access] of await this.calendarSpaces(userId, db)) out[spaceId] = permissionsToString(access.perms);
    return out;
  }

  /** Ids of every role (of every team) the person holds. Role ids are unique, so one set serves all their teams. */
  async heldRoleIds(userId: string, db: Db = this.prisma): Promise<Set<string>> {
    return new Set((await db.memberRole.findMany({ where: { userId }, select: { roleId: true } })).map((r) => r.roleId));
  }

  /**
   * Which of these people hold `bit` in a space, worked out for all of them with a handful of queries (the container's roles and
   * overwrites, no deeper level). Used to expand a role on an event into the people who can see it, so it must agree with
   * `spaceAccess` for every single person.
   */
  async spaceViewers(spaceId: string, candidateIds: readonly string[], bit: bigint, db: Db = this.prisma): Promise<Set<string>> {
    const viewers = new Set<string>();
    if (!candidateIds.length) return viewers;
    const space = await db.space.findUnique({ where: { id: spaceId } });
    if (!space) return viewers;
    if (space.kind === 'personal') {
      if (space.userId && candidateIds.includes(space.userId)) viewers.add(space.userId);
      return viewers;
    }
    let project: Project | null = null;
    let teamId = space.teamId;
    if (space.kind === 'project' && space.projectId) {
      project = await db.project.findFirst({ where: { id: space.projectId, deletedAt: null } });
      if (!project) return viewers;
      teamId = project.teamId;
    }
    if (!teamId) return viewers;
    const team = await db.team.findFirst({ where: { id: teamId, deletedAt: null } });
    if (!team) return viewers;

    const ids = [...new Set(candidateIds)];
    const members = new Set((await db.teamMember.findMany({ where: { teamId, userId: { in: ids } }, select: { userId: true } })).map((m) => m.userId));
    if (!members.size) return viewers;
    const memberIds = [...members];
    const [roles, held, projectMembers, chain] = await Promise.all([
      db.role.findMany({ where: { teamId } }),
      db.memberRole.findMany({ where: { userId: { in: memberIds }, role: { teamId } }, select: { userId: true, roleId: true } }),
      project ? db.projectMember.findMany({ where: { projectId: project.id, userId: { in: memberIds } }, select: { userId: true } }) : [],
      project ? this.chainLevels(db, project.path) : [],
    ]);
    const heldBy = new Map<string, Set<string>>();
    for (const h of held) (heldBy.get(h.userId) ?? heldBy.set(h.userId, new Set()).get(h.userId)!).add(h.roleId);
    const inProject = new Set(projectMembers.map((m) => m.userId));

    for (const userId of memberIds) {
      const heldIds = heldBy.get(userId) ?? new Set<string>();
      const teamPerms = computePermissions(this.buildInput(team, roles, heldIds, userId));
      let perms = teamPerms;
      if (project) {
        const canManage = hasPermission(teamPerms, Permission.MANAGE_PROJECTS);
        if (!inProject.has(userId) && !canManage) continue;
        perms = computePermissions(this.buildInput(team, roles, heldIds, userId, chain));
        if (!canManage && !canViewAnything(perms)) continue;
      }
      if (hasPermission(perms, bit)) viewers.add(userId);
    }
    return viewers;
  }

  /** Every space whose notebooks the person may see, with their permissions there: personal, teams, projects. */
  async notebookSpaces(userId: string, db: Db = this.prisma, bit: bigint = Permission.VIEW_NOTEBOOKS): Promise<Map<string, SpaceAccess>> {
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
      if (m.team.space && hasPermission(team.perms, bit))
        out.set(m.team.space.id, {
          space: m.team.space,
          perms: team.perms,
          teamId: m.team.id,
          projectId: null,
        });
      for (const v of await this.visibleProjects(userId, team, db)) {
        if (v.project.space && hasPermission(v.perms, bit))
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
