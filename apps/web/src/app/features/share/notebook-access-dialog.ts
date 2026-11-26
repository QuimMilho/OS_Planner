import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoPipe } from '@jsverse/transloco';
import type { RoleDto } from '@os-planner/shared';
import type { ApiProblem } from '../../core/auth-store';
import { Notify } from '../../core/notify';
import { AccessStore } from '../../data/access-store';
import { RolesStore } from '../../data/roles-store';
import { TeamStore } from '../../data/team-store';
import { TreeStore } from '../../data/tree-store';
import { OverwriteEditor } from '../team/overwrite-editor';
import { roleErrorKey } from '../team/roles-editor';

export interface NotebookAccessData {
  notebookId: string;
  name: string;
}

/** Who may see and change one team notebook: allow and deny per role and per member, on top of what the team and project give. */
@Component({
  selector: 'app-notebook-access-dialog',
  imports: [MatDialogModule, MatButtonModule, TranslocoPipe, OverwriteEditor],
  template: `
    <h2 mat-dialog-title>{{ 'notebook.access.title' | transloco: { name: data.name } }}</h2>
    <mat-dialog-content>
      <p class="muted">{{ 'notebook.access.hint' | transloco }}</p>
      @if (teamId(); as team) {
        <app-overwrite-editor
          kind="notebook"
          [projectId]="data.notebookId"
          [teamId]="team"
          [held]="held()"
          [roles]="roles()"
        />
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end"
      ><button mat-button type="button" mat-dialog-close>
        {{ 'common.close' | transloco }}
      </button></mat-dialog-actions
    >
  `,
  styles: `
    .muted {
      color: var(--text-dim);
      font-size: 13px;
      margin: 0 0 12px;
    }
  `,
})
export class NotebookAccessDialog {
  readonly data = inject<NotebookAccessData>(MAT_DIALOG_DATA);
  private readonly tree = inject(TreeStore);
  private readonly teams = inject(TeamStore);
  private readonly access = inject(AccessStore);
  private readonly rolesStore = inject(RolesStore);
  private readonly notify = inject(Notify);

  readonly roles = signal<RoleDto[]>([]);
  private readonly place = computed(() =>
    this.teams.placeOfSpace(this.tree.notebookById().get(this.data.notebookId)?.spaceId),
  );
  readonly teamId = computed(() => this.place()?.team?.id ?? null);
  readonly held = computed(() => this.access.heldIn(this.data.notebookId));

  constructor() {
    effect(() => {
      const place = this.place();
      if (!place?.team) return;
      untracked(() => void this.loadRoles(place.team!.id, place.projects.at(-1)?.id ?? null));
    });
  }

  private async loadRoles(teamId: string, projectId: string | null): Promise<void> {
    try {
      const [team, inProject] = await Promise.all([
        this.rolesStore.roles({ kind: 'team', id: teamId }),
        projectId ? this.rolesStore.roles({ kind: 'project', id: projectId }) : Promise.resolve([]),
      ]);
      this.roles.set([...team, ...inProject]);
    } catch (e) {
      this.notify.error(roleErrorKey(e as ApiProblem));
    }
  }
}
