import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { hasPermission, permissionsFromString, Permission } from '@os-planner/shared/lite';
import type { NotebookDto } from '@os-planner/shared';
import { Db } from './db';
import { liveSignal } from './live';
import { TeamStore } from './team-store';
import { TreeStore } from './tree-store';

const KEY = 'notebookPerms';

/**
 * What the person may do in each notebook: everything in their own, what the share says in one shared with them, and what
 * their roles and the notebook's overwrites say in a team or project notebook (read from the server with every sync and kept
 * locally, so the controls are right offline too). A notebook without a known answer is read-only: never assume a right.
 * The server decides again on every request.
 */
@Injectable({ providedIn: 'root' })
export class AccessStore {
  private readonly dbs = inject(Db);
  private readonly http = inject(HttpClient);
  private readonly tree = inject(TreeStore);
  private readonly teams = inject(TeamStore);

  /** Permissions by notebook id (decimal strings), for the notebooks that are not the person's own. */
  private readonly perms = liveSignal(
    this.dbs,
    async (d) => ((await d.meta.get(KEY))?.value ?? {}) as Record<string, string>,
    {} as Record<string, string>,
  );

  /** True when the notebook is the person's own: they own it, so nothing is ever denied. */
  isOwn(notebook: Pick<NotebookDto, 'spaceId'> | undefined): boolean {
    return !!notebook && this.tree.isPersonal(notebook);
  }

  /** Whether the person may do `permission` in the notebook. */
  can(notebookId: string, permission: bigint): boolean {
    const notebook = this.tree.notebookById().get(notebookId);
    if (!notebook) return false;
    if (this.isOwn(notebook)) return true;
    const raw = this.perms()[notebookId];
    const set = raw === undefined ? null : permissionsFromString(raw);
    return set !== null && hasPermission(set, permission);
  }

  /** The permission set (decimal string) in a notebook that is not the person's own, if known. */
  heldIn(notebookId: string): string | null {
    return this.perms()[notebookId] ?? null;
  }

  canEdit(notebookId: string): boolean {
    return this.can(notebookId, Permission.EDIT_PAGES);
  }

  /** Whether the person may create notebooks in a space (their own: always; a team or project: by role). */
  canCreateIn(spaceId: string): boolean {
    if (spaceId === this.tree.personalSpaceId()) return true;
    const team = this.teams.teamBySpace().get(spaceId);
    if (team) return this.teams.can(team.id, Permission.CREATE_NOTEBOOKS);
    const project = this.teams.projectBySpace().get(spaceId);
    return project
      ? this.teams.can(project.teamId, Permission.CREATE_NOTEBOOKS, project.id)
      : false;
  }

  /** Reads the answers from the server. Network errors propagate (the caller treats them as "offline"). */
  async refresh(): Promise<void> {
    const perms = await firstValueFrom(
      this.http.get<Record<string, string>>('/api/notebook-permissions'),
    );
    await this.dbs.db.meta.put({ key: KEY, value: perms });
  }
}
