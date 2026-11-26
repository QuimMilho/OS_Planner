import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { permissionsFromString, rankOf, type RoleActor } from '@os-planner/shared/lite';
import type {
  AuditPageDto,
  CreateRoleInput,
  OverwriteDto,
  PreviewDto,
  ProjectMemberDto,
  RoleDto,
  UpdateRoleInput,
} from '@os-planner/shared';
import { AuthStore, toProblem } from '../core/auth-store';
import { TeamStore } from './team-store';

/** Where roles are asked for: a team (its roles and @everyone) or a project (its own roles and those of the projects above). */
export type RoleScope = { kind: 'team'; id: string } | { kind: 'project'; id: string };

const base = (s: RoleScope): string =>
  s.kind === 'team' ? `/api/teams/${s.id}` : `/api/projects/${s.id}`;

/**
 * Roles, overwrites, the "view as" preview and the audit log. These are administration screens, so they talk to the
 * server directly (nothing is cached for offline use) and every error is passed on as a `Problem` for the page to show.
 * The server decides every request; `actor()` only mirrors the rules so the page can disable what would be refused.
 */
@Injectable({ providedIn: 'root' })
export class RolesStore {
  private readonly http = inject(HttpClient);
  private readonly teams = inject(TeamStore);
  private readonly auth = inject(AuthStore);

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw toProblem(e);
    }
  }

  // ------------------------------------------------------------------ roles

  roles(scope: RoleScope): Promise<RoleDto[]> {
    return this.call(() => firstValueFrom(this.http.get<RoleDto[]>(`${base(scope)}/roles`)));
  }

  createRole(
    scope: RoleScope,
    input: Partial<CreateRoleInput> & { name: string },
  ): Promise<RoleDto> {
    return this.call(() => firstValueFrom(this.http.post<RoleDto>(`${base(scope)}/roles`, input)));
  }

  updateRole(roleId: string, patch: UpdateRoleInput): Promise<RoleDto> {
    return this.call(() => firstValueFrom(this.http.patch<RoleDto>(`/api/roles/${roleId}`, patch)));
  }

  deleteRole(roleId: string): Promise<void> {
    return this.call(
      async () => void (await firstValueFrom(this.http.delete(`/api/roles/${roleId}`))),
    );
  }

  reorder(scope: RoleScope, ids: string[]): Promise<RoleDto[]> {
    return this.call(() =>
      firstValueFrom(this.http.put<RoleDto[]>(`${base(scope)}/roles/order`, { ids })),
    );
  }

  async assign(scope: RoleScope, userId: string, roleId: string): Promise<void> {
    await this.call(() =>
      firstValueFrom(this.http.put(`${base(scope)}/members/${userId}/roles/${roleId}`, null)),
    );
    await this.refresh(scope);
  }

  async unassign(scope: RoleScope, userId: string, roleId: string): Promise<void> {
    await this.call(() =>
      firstValueFrom(this.http.delete(`${base(scope)}/members/${userId}/roles/${roleId}`)),
    );
    await this.refresh(scope);
  }

  projectMembers(projectId: string): Promise<ProjectMemberDto[]> {
    return this.call(() =>
      firstValueFrom(this.http.get<ProjectMemberDto[]>(`/api/projects/${projectId}/members`)),
    );
  }

  /** Pulls the person's own permissions again: a role they just changed may be their own. */
  async refresh(scope: RoleScope): Promise<void> {
    const teamId =
      scope.kind === 'team' ? scope.id : this.teams.projectById().get(scope.id)?.teamId;
    if (teamId) await this.teams.refreshTeam(teamId).catch(() => undefined);
  }

  setNickname(teamId: string, userId: string, nickname: string | null): Promise<void> {
    return this.call(async () => {
      await firstValueFrom(this.http.patch(`/api/teams/${teamId}/members/${userId}`, { nickname }));
      await this.teams.refreshTeam(teamId);
    });
  }

  // ------------------------------------------------------------------ overwrites

  overwrites(projectId: string): Promise<OverwriteDto[]> {
    return this.call(() =>
      firstValueFrom(
        this.http.get<OverwriteDto[]>('/api/overwrites', {
          params: { kind: 'project', id: projectId },
        }),
      ),
    );
  }

  /** Allowing and denying nothing removes the overwrite. */
  setOverwrite(
    projectId: string,
    subjectKind: 'role' | 'member',
    subjectId: string,
    allow: string,
    deny: string,
  ): Promise<OverwriteDto | null> {
    return this.call(async () => {
      const row = await firstValueFrom(
        this.http.put<OverwriteDto | null>('/api/overwrites', {
          targetKind: 'project',
          targetId: projectId,
          subjectKind,
          subjectId,
          allow,
          deny,
        }),
      );
      const teamId = this.teams.projectById().get(projectId)?.teamId;
      if (teamId) await this.teams.refreshTeam(teamId).catch(() => undefined);
      return row;
    });
  }

  // ------------------------------------------------------------------ view as, audit

  preview(
    subject: { kind: 'role' | 'member'; id: string },
    where: { kind: 'team' | 'project'; id: string },
  ): Promise<PreviewDto> {
    return this.call(() =>
      firstValueFrom(
        this.http.get<PreviewDto>('/api/permissions/preview', {
          params: { subject: `${subject.kind}:${subject.id}`, kind: where.kind, id: where.id },
        }),
      ),
    );
  }

  audit(
    teamId: string,
    query: {
      action?: string;
      actor?: string;
      from?: string;
      to?: string;
      cursor?: string;
      limit?: number;
    },
  ): Promise<AuditPageDto> {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(query))
      if (v !== undefined && v !== '') params[k] = String(v);
    return this.call(() =>
      firstValueFrom(this.http.get<AuditPageDto>(`/api/teams/${teamId}/audit`, { params })),
    );
  }

  // ------------------------------------------------------------------ mirroring the rules

  /**
   * The person as the role rules see them in a scope: their permissions there and the highest position among the roles
   * that apply to them. Project roles above the open project are not known here, so the rank may be a little low; the
   * server has the last word.
   */
  actor(
    scope: RoleScope,
    roles: readonly RoleDto[],
    projectMemberRoleIds: readonly string[] = [],
  ): RoleActor {
    const team = this.teams
      .teamById()
      .get(
        scope.kind === 'team' ? scope.id : (this.teams.projectById().get(scope.id)?.teamId ?? ''),
      );
    const me = team
      ? this.teams.membersOf(team.id).find((m) => m.userId === this.auth.userId())
      : undefined;
    const held = new Set([...(me?.roleIds ?? []), ...projectMemberRoleIds]);
    const raw = this.teams.permissionsOf(
      team?.id ?? '',
      scope.kind === 'project' ? scope.id : undefined,
    );
    return {
      isOwner: team?.isOwner ?? false,
      perms: raw === null ? 0n : (permissionsFromString(raw) ?? 0n),
      rank: team?.isOwner
        ? Number.POSITIVE_INFINITY
        : rankOf(roles.filter((r) => held.has(r.id)).map((r) => r.position)),
    };
  }
}
