import { Component, Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  MAT_DIALOG_DATA,
  MatDialog,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { Permission } from '@os-planner/shared/lite';
import type { ProjectDto } from '@os-planner/shared';
import { toProblem } from '../../core/auth-store';
import { Language } from '../../core/i18n';
import { Notify } from '../../core/notify';
import { TeamStore } from '../../data/team-store';
import { Dialogs } from '../../shared/dialogs';

const COLLAPSED_KEY = 'os_planner.collapsedProjects';

// ---------------------------------------------------------------- "move to…" dialog

export interface MoveProjectData {
  project: ProjectDto;
}
export interface MoveProjectResult {
  parentId: string | null;
}

interface Target {
  id: string | null;
  label: string;
  depth: number;
  disabled: boolean;
}

@Component({
  selector: 'app-move-project-dialog',
  imports: [MatDialogModule, MatButtonModule, MatIconModule, TranslocoPipe],
  template: `
    <h2 mat-dialog-title>{{ 'project.moveTo' | transloco }}</h2>
    <mat-dialog-content>
      <div class="list" role="listbox">
        @for (o of targets(); track o.id ?? 'top') {
          <button
            type="button"
            role="option"
            class="opt"
            [style.padding-left.px]="16 + o.depth * 16"
            [disabled]="o.disabled"
            [attr.data-target]="o.label"
            (click)="ref.close({ parentId: o.id })"
          >
            <mat-icon>{{ o.id ? 'folder' : 'vertical_align_top' }}</mat-icon>{{ o.label }}
          </button>
        }
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end"
      ><button mat-button type="button" mat-dialog-close>
        {{ 'common.cancel' | transloco }}
      </button></mat-dialog-actions
    >
  `,
  styles: `
    .list {
      min-width: 300px;
      max-height: 50vh;
      overflow: auto;
    }
    .opt {
      display: flex;
      gap: 8px;
      align-items: center;
      width: 100%;
      border: 0;
      background: none;
      color: var(--text);
      padding: 8px 16px;
      border-radius: 8px;
      cursor: pointer;
      text-align: left;
      font: inherit;
    }
    .opt:hover:not(:disabled) {
      background: var(--surface-3);
    }
    .opt:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    mat-icon {
      font-size: 20px;
      width: 20px;
      height: 20px;
    }
  `,
})
export class MoveProjectDialog {
  readonly data = inject<MoveProjectData>(MAT_DIALOG_DATA);
  readonly ref = inject<MatDialogRef<MoveProjectDialog, MoveProjectResult>>(MatDialogRef);
  private readonly teams = inject(TeamStore);
  private readonly lang = inject(Language);

  readonly targets = computed<Target[]>(() => {
    const project = this.data.project;
    const out: Target[] = [
      {
        id: null,
        label: this.lang.t('project.topLevel'),
        depth: 0,
        disabled: project.parentId === null,
      },
    ];
    const walk = (nodes: ReturnType<TeamStore['treeOf']>, depth: number, blocked: boolean) => {
      for (const n of nodes) {
        const self = n.project.id === project.id;
        out.push({
          id: n.project.id,
          label: n.project.name,
          depth,
          disabled: blocked || self || n.project.id === project.parentId,
        });
        walk(n.children, depth + 1, blocked || self); // nothing below the project itself is a legal target
      }
    };
    walk(this.teams.treeOf(project.teamId), 0, false);
    return out;
  });
}

// ---------------------------------------------------------------- what people can do with projects

/** The actions behind the project tree's buttons, menus and drag-and-drop. Everything goes to the server first. */
@Injectable({ providedIn: 'root' })
export class TeamUi {
  readonly teams = inject(TeamStore);
  private readonly dialogs = inject(Dialogs);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);
  private readonly router = inject(Router);

  readonly collapsed = signal<Set<string>>(this.load());
  /** The project being dragged in the tree (dragover cannot read the transfer data, so it is kept here). */
  readonly dragging = signal<ProjectDto | null>(null);
  /** The row a drag is hovering over (`'top'` for the top-level drop zone). */
  readonly dropTarget = signal<string | null>(null);

  /** Whether the dragged project may be dropped under `targetId` (null: the top level). */
  canDropOn(targetId: string | null): boolean {
    const dragged = this.dragging();
    if (!dragged || targetId === dragged.parentId || targetId === dragged.id) return false;
    return targetId === null || !this.descendants(dragged).has(targetId);
  }

  async drop(targetId: string | null): Promise<void> {
    const dragged = this.dragging();
    const ok = this.canDropOn(targetId);
    this.dragging.set(null);
    this.dropTarget.set(null);
    if (dragged && ok) await this.move(dragged, targetId);
  }

  private load(): Set<string> {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  }

  isOpen(id: string): boolean {
    return !this.collapsed().has(id);
  }

  toggle(id: string): void {
    this.collapsed.update((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  }

  canManage(teamId: string): boolean {
    return this.teams.can(teamId, Permission.MANAGE_PROJECTS);
  }

  /** The project with everything below it. */
  descendants(project: ProjectDto): Set<string> {
    const ids = new Set([project.id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const p of this.teams.projects())
        if (p.parentId && ids.has(p.parentId) && !ids.has(p.id)) (ids.add(p.id), (grew = true));
    }
    return ids;
  }

  async newProject(teamId: string, parentId: string | null): Promise<void> {
    const answer = await this.dialogs.prompt({
      titleKey: parentId ? 'project.newSub' : 'project.new',
      labelKey: 'project.name',
      confirmKey: 'common.save',
    });
    if (answer?.action !== 'ok' || !answer.value.trim()) return;
    await this.attempt(async () => {
      const project = await this.teams.createProject(teamId, answer.value.trim(), parentId);
      if (parentId && !this.isOpen(parentId)) this.toggle(parentId);
      await this.router.navigate(['/app/t', teamId, 'p', project.id]);
    });
  }

  async rename(project: ProjectDto): Promise<void> {
    const answer = await this.dialogs.prompt({
      titleKey: 'project.rename',
      labelKey: 'project.name',
      value: project.name,
      confirmKey: 'common.save',
    });
    if (answer?.action !== 'ok' || !answer.value.trim() || answer.value.trim() === project.name)
      return;
    await this.attempt(() => this.teams.updateProject(project, { name: answer.value.trim() }));
  }

  async archive(project: ProjectDto): Promise<void> {
    await this.attempt(() => this.teams.updateProject(project, { archived: !project.archivedAt }));
  }

  async move(project: ProjectDto, parentId?: string | null): Promise<void> {
    let target = parentId;
    if (target === undefined) {
      const chosen = await firstValueFrom(
        this.dialog
          .open<MoveProjectDialog, MoveProjectData, MoveProjectResult>(MoveProjectDialog, {
            data: { project },
          })
          .afterClosed(),
      );
      if (!chosen) return;
      target = chosen.parentId;
    }
    if (target === project.parentId) return;
    await this.attempt(() => this.teams.moveProject(project, target));
  }

  async remove(project: ProjectDto): Promise<void> {
    const sure = await this.dialogs.confirm({
      titleKey: 'project.deleteTitle',
      messageKey: 'project.deleteMessage',
      params: { name: project.name },
      confirmKey: 'common.delete',
      danger: true,
    });
    if (!sure) return;
    await this.attempt(async () => {
      await this.teams.deleteProject(project);
      await this.router.navigate(
        project.parentId
          ? ['/app/t', project.teamId, 'p', project.parentId]
          : ['/app/t', project.teamId],
      );
    });
  }

  /** Runs an action and turns the server's answer into a message the person understands. */
  async attempt(action: () => Promise<unknown>): Promise<boolean> {
    try {
      await action();
      return true;
    } catch (e) {
      const problem = toProblem(e);
      const key = problem.offline
        ? 'errors.offline'
        : problem.status === 403
          ? 'errors.forbidden'
          : problem.status === 404
            ? 'errors.notFound'
            : problem.code === 'project_limit_reached'
              ? 'project.limitReached'
              : problem.status === 422
                ? 'project.invalid'
                : 'errors.generic';
      this.notify.error(key);
      return false;
    }
  }
}
