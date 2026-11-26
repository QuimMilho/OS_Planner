import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type {
  AcceptedInviteDto,
  BanDto,
  CreatedInviteDto,
  CreateInviteInput,
  DirectoryPageDto,
  DirectoryTeamDto,
  InviteDto,
  InvitePreviewDto,
  JoinRequestDto,
  JoinResultDto,
  TeamDto,
  UpdateTeamInput,
} from '@os-planner/shared';
import { toProblem } from '../core/auth-store';
import { TeamStore } from './team-store';

/**
 * Joining teams: invites, the public directory, requests, bans, leaving and handing a team over. These are online
 * actions (nothing is cached for offline use); every error is passed on as a `Problem` for the page to show, and the
 * team list is read again after whatever changes who is in which team.
 */
@Injectable({ providedIn: 'root' })
export class MembershipStore {
  private readonly http = inject(HttpClient);
  private readonly teams = inject(TeamStore);

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw toProblem(e);
    }
  }

  // ------------------------------------------------------------------ invites

  preview(token: string): Promise<InvitePreviewDto> {
    return this.call(() =>
      firstValueFrom(
        this.http.get<InvitePreviewDto>('/api/invites/preview', { params: { token } }),
      ),
    );
  }

  async accept(token: string): Promise<AcceptedInviteDto> {
    const res = await this.call(() =>
      firstValueFrom(this.http.post<AcceptedInviteDto>('/api/invites/accept', { token })),
    );
    await this.teams.refreshAll();
    return res;
  }

  invites(teamId: string): Promise<InviteDto[]> {
    return this.call(() =>
      firstValueFrom(this.http.get<InviteDto[]>(`/api/teams/${teamId}/invites`)),
    );
  }

  createInvite(teamId: string, input: Partial<CreateInviteInput>): Promise<CreatedInviteDto> {
    return this.call(() =>
      firstValueFrom(this.http.post<CreatedInviteDto>(`/api/teams/${teamId}/invites`, input)),
    );
  }

  revokeInvite(id: string): Promise<void> {
    return this.call(
      async () => void (await firstValueFrom(this.http.delete(`/api/invites/${id}`))),
    );
  }

  resendInvite(id: string): Promise<InviteDto> {
    return this.call(() =>
      firstValueFrom(this.http.post<InviteDto>(`/api/invites/${id}/resend`, null)),
    );
  }

  // ------------------------------------------------------------------ directory and requests

  directory(q: { q?: string; tag?: string; cursor?: string }): Promise<DirectoryPageDto> {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(q)) if (v) params[k] = v;
    return this.call(() =>
      firstValueFrom(this.http.get<DirectoryPageDto>('/api/directory', { params })),
    );
  }

  directoryOne(slug: string): Promise<DirectoryTeamDto> {
    return this.call(() =>
      firstValueFrom(this.http.get<DirectoryTeamDto>(`/api/directory/${encodeURIComponent(slug)}`)),
    );
  }

  async join(teamId: string, message = ''): Promise<JoinResultDto> {
    const res = await this.call(() =>
      firstValueFrom(this.http.post<JoinResultDto>(`/api/teams/${teamId}/join`, { message })),
    );
    if (res.status === 'joined') await this.teams.refreshAll();
    return res;
  }

  withdraw(teamId: string): Promise<void> {
    return this.call(
      async () =>
        void (await firstValueFrom(this.http.delete(`/api/teams/${teamId}/join-request`))),
    );
  }

  requests(teamId: string): Promise<JoinRequestDto[]> {
    return this.call(() =>
      firstValueFrom(this.http.get<JoinRequestDto[]>(`/api/teams/${teamId}/join-requests`)),
    );
  }

  async decide(teamId: string, requestId: string, approve: boolean): Promise<void> {
    await this.call(() =>
      firstValueFrom(
        this.http.post(
          `/api/teams/${teamId}/join-requests/${requestId}/${approve ? 'approve' : 'deny'}`,
          null,
        ),
      ),
    );
    await this.teams.refreshTeam(teamId);
  }

  // ------------------------------------------------------------------ people

  bans(teamId: string): Promise<BanDto[]> {
    return this.call(() => firstValueFrom(this.http.get<BanDto[]>(`/api/teams/${teamId}/bans`)));
  }

  async ban(teamId: string, userId: string, reason: string): Promise<void> {
    await this.call(() =>
      firstValueFrom(this.http.put(`/api/teams/${teamId}/bans/${userId}`, { reason })),
    );
    await this.teams.refreshTeam(teamId);
  }

  unban(teamId: string, userId: string): Promise<void> {
    return this.call(
      async () =>
        void (await firstValueFrom(this.http.delete(`/api/teams/${teamId}/bans/${userId}`))),
    );
  }

  async kick(teamId: string, userId: string): Promise<void> {
    await this.call(() =>
      firstValueFrom(this.http.delete(`/api/teams/${teamId}/members/${userId}`)),
    );
    await this.teams.refreshTeam(teamId);
  }

  /** The person leaves: the team is forgotten here (its row, projects and everything stored from its spaces). */
  async leave(teamId: string): Promise<void> {
    await this.call(() => firstValueFrom(this.http.delete(`/api/teams/${teamId}/members/me`)));
    await this.teams.purgeTeam(teamId);
  }

  async transferOwnership(teamId: string, userId: string, password: string): Promise<void> {
    await this.call(() =>
      firstValueFrom(
        this.http.post(`/api/teams/${teamId}/transfer-ownership`, { userId, password }),
      ),
    );
    await this.teams.refreshAll();
  }

  /** Discoverability and other team settings. */
  async updateTeam(teamId: string, patch: UpdateTeamInput): Promise<TeamDto> {
    const team = await this.call(() =>
      firstValueFrom(this.http.patch<TeamDto>(`/api/teams/${teamId}`, patch)),
    );
    await this.teams.refreshAll();
    return team;
  }
}
