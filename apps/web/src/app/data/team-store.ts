import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { hasPermission, permissionsFromString } from '@os-planner/shared/lite';
import type { ProjectDto, TeamDto, TeamMeDto, TeamMemberDto } from '@os-planner/shared';
import { toProblem } from '../core/auth-store';
import { Db, type ChannelRow, type MemberRow } from './db';
import { liveSignal } from './live';
import { byPosition } from './tree-store';

export interface ProjectNode {
  project: ProjectDto;
  children: ProjectNode[];
}

/** Where something sits: the team and the chain of projects from the top down to it. */
export interface Place {
  team: TeamDto | null;
  projects: ProjectDto[];
}

const PERM_KEY = (teamId: string) => `perm:${teamId}`;

/**
 * Teams, their projects and members, and what the person may do there. Read from the local
 * database (so the tree and the lists open offline); Sync refreshes it from the server, and every
 * change a person makes here goes to the server first and is then read back.
 */
@Injectable({ providedIn: 'root' })
export class TeamStore {
  private readonly dbs = inject(Db);
  private readonly http = inject(HttpClient);

  /** `null` until the first read of the local database has finished, so a page can tell "not loaded" from "no such team". */
  readonly teams = liveSignal(this.dbs, (d) => d.teams.toArray(), null as TeamDto[] | null);
  readonly projects = liveSignal(this.dbs, (d) => d.projects.toArray(), [] as ProjectDto[]);
  readonly members = liveSignal(this.dbs, (d) => d.members.toArray(), [] as MemberRow[]);
  /** Resolved permissions per team, as last read from the server (decimal strings, see TeamMeDto). */
  private readonly meRows = liveSignal(
    this.dbs,
    async (d) =>
      (await d.meta.filter((m) => m.key.startsWith('perm:')).toArray()).map(
        (m) => m.value as TeamMeDto,
      ),
    [] as TeamMeDto[],
  );

  /** The channels cached on this device (the chat feature keeps them current): enough to say which space a channel is in. */
  private readonly channelRows = liveSignal(this.dbs, (d) => d.channels.toArray(), [] as ChannelRow[]);

  readonly teamById = computed(() => new Map((this.teams() ?? []).map((t) => [t.id, t])));
  readonly projectById = computed(() => new Map(this.projects().map((p) => [p.id, p])));
  readonly teamBySpace = computed(() => new Map((this.teams() ?? []).map((t) => [t.spaceId, t])));
  readonly projectBySpace = computed(() => new Map(this.projects().map((p) => [p.spaceId, p])));
  private readonly meByTeam = computed(() => new Map(this.meRows().map((m) => [m.teamId, m])));

  /** The space a (cached) channel belongs to, so a chat address can show where in the hierarchy it is. */
  channelSpaceId(channelId: string): string | undefined {
    const row = this.channelRows().find((c) => c.id === channelId);
    // Remembered for the session: a channel that was hidden or deleted still tells which team's sidebar the page sits in.
    if (row) this.channelSpaces.set(channelId, row.spaceId);
    return row?.spaceId ?? this.channelSpaces.get(channelId);
  }
  private readonly channelSpaces = new Map<string, string>();

  /** The projects of a team as a tree in position order (archived ones included; the view decides how to show them). */
  treeOf(teamId: string): ProjectNode[] {
    const mine = this.projects().filter((p) => p.teamId === teamId);
    const nodes = new Map<string, ProjectNode>(
      mine.map((p) => [p.id, { project: p, children: [] }]),
    );
    const roots: ProjectNode[] = [];
    for (const p of [...mine].sort(byPosition)) {
      const node = nodes.get(p.id)!;
      const parent = p.parentId ? nodes.get(p.parentId) : undefined;
      // A project whose parent the person cannot see is shown at the top: the tree never hides what they may open.
      (parent ? parent.children : roots).push(node);
    }
    return roots;
  }

  /** The projects from the top down to `projectId`. */
  chainOf(projectId: string): ProjectDto[] {
    const byId = this.projectById();
    const out: ProjectDto[] = [];
    for (
      let p = byId.get(projectId);
      p && out.length < 32;
      p = p.parentId ? byId.get(p.parentId) : undefined
    )
      out.unshift(p);
    return out;
  }

  /** Team and project of a space (for breadcrumbs); empty for a personal space. */
  placeOfSpace(spaceId: string | undefined): Place | null {
    if (!spaceId) return null;
    const team = this.teamBySpace().get(spaceId);
    if (team) return { team, projects: [] };
    const project = this.projectBySpace().get(spaceId);
    if (!project) return null;
    return {
      team: this.teamById().get(project.teamId) ?? null,
      projects: this.chainOf(project.id),
    };
  }

  membersOf(teamId: string): TeamMemberDto[] {
    return this.members().filter((m) => m.teamId === teamId);
  }

  /** Whether the person may do `permission` in the team (or in one of its projects). The server decides again. */
  can(teamId: string, permission: bigint, projectId?: string): boolean {
    const me = this.meByTeam().get(teamId);
    if (!me) return false;
    const raw = projectId ? me.projects[projectId] : me.permissions;
    const set = raw === undefined ? null : permissionsFromString(raw);
    return set !== null && hasPermission(set, permission);
  }

  /** Join requests waiting for a decision, as last read (0 unless the person may decide on them). */
  pendingRequests(teamId: string): number {
    return this.meByTeam().get(teamId)?.pendingRequests ?? 0;
  }

  /** The permission set (decimal string) the person has in the team or one of its projects, as last read; null if unknown. */
  permissionsOf(teamId: string, projectId?: string): string | null {
    const me = this.meByTeam().get(teamId);
    return me ? (projectId ? (me.projects[projectId] ?? null) : me.permissions) : null;
  }

  // ------------------------------------------------------------------ reading from the server

  /** Teams, then everything about each of them. Network errors propagate (the caller treats them as "offline"). */
  async refreshAll(): Promise<void> {
    const db = this.dbs.db;
    const teams = await firstValueFrom(this.http.get<TeamDto[]>('/api/teams'));
    const known = new Set(teams.map((t) => t.id));
    const gone = (await db.teams.toArray()).filter((t) => !known.has(t.id));
    await db.teams.bulkPut(teams);
    for (const team of gone) await this.purgeTeam(team.id);
    for (const team of teams) await this.refreshTeam(team.id);
  }

  /** Projects, members and permissions of one team. A 404 means the person is no longer in it. */
  async refreshTeam(teamId: string): Promise<boolean> {
    const db = this.dbs.db;
    try {
      const [projects, members, me] = await Promise.all([
        firstValueFrom(this.http.get<ProjectDto[]>(`/api/teams/${teamId}/projects`)),
        firstValueFrom(this.http.get<TeamMemberDto[]>(`/api/teams/${teamId}/members`)),
        firstValueFrom(this.http.get<TeamMeDto>(`/api/teams/${teamId}/me`)),
      ]);
      const keep = new Set(projects.map((p) => p.id));
      const dropped = (await db.projects.where('teamId').equals(teamId).toArray()).filter(
        (p) => !keep.has(p.id),
      );
      await this.purgeSpaces(dropped.map((p) => p.spaceId));
      await db.transaction('rw', db.projects, db.members, db.meta, async () => {
        await db.projects.bulkDelete(dropped.map((p) => p.id));
        await db.projects.bulkPut(projects);
        await db.members.where('teamId').equals(teamId).delete();
        await db.members.bulkPut(members.map((m) => ({ ...m, teamId })));
        await db.meta.put({ key: PERM_KEY(teamId), value: me });
      });
      return true;
    } catch (e) {
      if (e instanceof HttpErrorResponse && e.status === 404) {
        await this.purgeTeam(teamId);
        return false;
      }
      throw e;
    }
  }

  /** Reads one team that is not in the local database yet (a link opened before the first sync). False if the person cannot see it. */
  async fetchTeam(teamId: string): Promise<boolean> {
    try {
      const team = await firstValueFrom(this.http.get<TeamDto>(`/api/teams/${teamId}`));
      await this.dbs.db.teams.put(team);
      return await this.refreshTeam(teamId);
    } catch (e) {
      if (e instanceof HttpErrorResponse && e.status === 404) return false;
      throw e;
    }
  }

  // ------------------------------------------------------------------ forgetting

  /** The person lost the team: its row, projects, members and everything stored from its spaces go. */
  async purgeTeam(teamId: string): Promise<void> {
    const db = this.dbs.db;
    const team = await db.teams.get(teamId);
    const projects = await db.projects.where('teamId').equals(teamId).toArray();
    await this.purgeSpaces([...(team ? [team.spaceId] : []), ...projects.map((p) => p.spaceId)]);
    await db.transaction('rw', db.teams, db.projects, db.members, db.meta, async () => {
      await db.projects.where('teamId').equals(teamId).delete();
      await db.members.where('teamId').equals(teamId).delete();
      await db.meta.delete(PERM_KEY(teamId));
      await db.teams.delete(teamId);
    });
  }

  /** Removes everything stored locally from the given spaces and forgets their sync cursors. */
  async purgeSpaces(spaceIds: string[]): Promise<void> {
    if (!spaceIds.length) return;
    const db = this.dbs.db;
    await db.transaction(
      'rw',
      [db.notebooks, db.categories, db.pages, db.contents, db.meta],
      async () => {
        const pageIds = (await db.pages.where('spaceId').anyOf(spaceIds).primaryKeys()) as string[];
        await db.contents.bulkDelete(pageIds);
        await db.pages.where('spaceId').anyOf(spaceIds).delete();
        await db.categories.where('spaceId').anyOf(spaceIds).delete();
        await db.notebooks.where('spaceId').anyOf(spaceIds).delete();
        const cursors =
          ((await db.meta.get('cursors'))?.value as Record<string, number> | undefined) ?? {};
        for (const id of spaceIds) delete cursors[id];
        await db.meta.put({ key: 'cursors', value: cursors });
      },
    );
  }

  // ------------------------------------------------------------------ changing things (online; the server decides)

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw toProblem(e);
    }
  }

  createProject(teamId: string, name: string, parentId: string | null): Promise<ProjectDto> {
    return this.call(async () => {
      const project = await firstValueFrom(
        this.http.post<ProjectDto>(`/api/teams/${teamId}/projects`, { name, parentId }),
      );
      await this.refreshTeam(teamId);
      return project;
    });
  }

  updateProject(
    project: ProjectDto,
    patch: { name?: string; description?: string; archived?: boolean },
  ): Promise<void> {
    return this.call(async () => {
      await firstValueFrom(this.http.patch(`/api/projects/${project.id}`, patch));
      await this.refreshTeam(project.teamId);
    });
  }

  moveProject(project: ProjectDto, parentId: string | null): Promise<void> {
    return this.call(async () => {
      await firstValueFrom(this.http.post(`/api/projects/${project.id}/move`, { parentId }));
      await this.refreshTeam(project.teamId);
    });
  }

  deleteProject(project: ProjectDto): Promise<void> {
    return this.call(async () => {
      await firstValueFrom(this.http.delete(`/api/projects/${project.id}`));
      await this.refreshTeam(project.teamId);
    });
  }
}
