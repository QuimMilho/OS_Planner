import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { toProblem } from '../../core/auth-store';
import { Language } from '../../core/i18n';
import { AccessStore } from '../../data/access-store';
import { TeamStore } from '../../data/team-store';
import { TreeStore } from '../../data/tree-store';

export interface NotebookMoveData {
  notebookId: string;
}

interface Target {
  spaceId: string;
  label: string;
  kind: 'personal' | 'team' | 'project';
  depth: number;
}

/**
 * Moves a notebook to another space: the person's own, or a team or project they may create notebooks in. Says who gains
 * and who loses access first; the server moves everything (pages, files, storage) in one step or not at all.
 */
@Component({
  selector: 'app-notebook-move-dialog',
  imports: [MatDialogModule, MatButtonModule, MatIconModule, TranslocoPipe],
  template: `
    <h2 mat-dialog-title>{{ 'notebook.move.title' | transloco }}</h2>
    <mat-dialog-content>
      <div class="list" role="listbox" [attr.aria-label]="'notebook.move.title' | transloco">
        @for (t of targets(); track t.spaceId) {
          <button
            type="button"
            role="option"
            class="opt"
            [class.sel]="selected() === t.spaceId"
            [attr.aria-selected]="selected() === t.spaceId"
            [attr.data-space]="t.label"
            [style.padding-left.px]="12 + t.depth * 16"
            (click)="selected.set(t.spaceId)"
          >
            <mat-icon>{{
              t.kind === 'personal' ? 'person' : t.kind === 'team' ? 'groups' : 'folder'
            }}</mat-icon>{{ t.label }}
          </button>
        } @empty {
          <p class="muted">{{ 'notebook.move.none' | transloco }}</p>
        }
      </div>
      @if (warning(); as w) {
        <p class="warn" data-move-warning><mat-icon>info</mat-icon>{{ w | transloco }}</p>
      }
      @if (error(); as e) {
        <p class="err" role="alert" data-move-error>{{ e | transloco }}</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" mat-dialog-close>{{ 'common.cancel' | transloco }}</button>
      <button
        mat-flat-button
        type="button"
        [disabled]="!selected() || busy()"
        (click)="move()"
        data-action="confirm-move"
      >
        {{ 'notebook.move.action' | transloco }}
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    .list {
      min-width: 300px;
      max-height: 40vh;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .opt {
      display: flex;
      gap: 8px;
      align-items: center;
      width: 100%;
      border: 0;
      background: none;
      color: var(--text);
      padding: 8px 12px;
      border-radius: 8px;
      cursor: pointer;
      text-align: left;
      font: inherit;
    }
    .opt:hover {
      background: var(--surface-3);
    }
    .opt.sel {
      background: color-mix(in srgb, var(--accent) 16%, transparent);
      font-weight: 600;
    }
    mat-icon {
      font-size: 20px;
      width: 20px;
      height: 20px;
      flex: none;
    }
    .warn {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      font-size: 13px;
      color: var(--text-dim);
      margin: 12px 0 0;
    }
    .err {
      color: var(--mat-sys-error);
      font-size: 13px;
      margin: 8px 0 0;
    }
  `,
})
export class NotebookMoveDialog {
  readonly data = inject<NotebookMoveData>(MAT_DIALOG_DATA);
  readonly ref = inject<MatDialogRef<NotebookMoveDialog, boolean>>(MatDialogRef);
  private readonly http = inject(HttpClient);
  private readonly tree = inject(TreeStore);
  private readonly teams = inject(TeamStore);
  private readonly access = inject(AccessStore);
  private readonly lang = inject(Language);

  readonly selected = signal<string | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  private readonly current = computed(
    () => this.tree.notebookById().get(this.data.notebookId)?.spaceId ?? null,
  );

  /** Every space the person may create notebooks in, except the one the notebook is in. */
  readonly targets = computed<Target[]>(() => {
    const out: Target[] = [];
    const personal = this.tree.personalSpaceId();
    if (personal)
      out.push({
        spaceId: personal,
        label: this.lang.t('notebook.move.personal'),
        kind: 'personal',
        depth: 0,
      });
    for (const team of [...(this.teams.teams() ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      out.push({ spaceId: team.spaceId, label: team.name, kind: 'team', depth: 0 });
      const walk = (nodes: ReturnType<TeamStore['treeOf']>, depth: number) => {
        for (const n of nodes) {
          out.push({ spaceId: n.project.spaceId, label: n.project.name, kind: 'project', depth });
          walk(n.children, depth + 1);
        }
      };
      walk(this.teams.treeOf(team.id), 1);
    }
    return out.filter((t) => t.spaceId !== this.current() && this.access.canCreateIn(t.spaceId));
  });

  readonly warning = computed(() => {
    const target = this.targets().find((t) => t.spaceId === this.selected());
    if (!target) return null;
    const from = this.current();
    const fromPersonal = from === this.tree.personalSpaceId();
    if (target.kind === 'personal') return 'notebook.move.toPersonal';
    return fromPersonal ? 'notebook.move.toTeam' : 'notebook.move.between';
  });

  async move(): Promise<void> {
    const spaceId = this.selected();
    if (!spaceId) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(
        this.http.post(`/api/notebooks/${this.data.notebookId}/move`, { spaceId }),
      );
      this.ref.close(true);
    } catch (e) {
      const p = toProblem(e);
      this.error.set(
        p.status === 413
          ? 'notebook.move.noRoom'
          : p.message === 'media_shared_with_other_notebook'
            ? 'notebook.move.sharedFile'
            : p.offline
              ? 'notebook.move.offline'
              : 'notebook.move.refused',
      );
      this.busy.set(false);
    }
  }
}
