import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import type { TaskDto } from '@os-planner/shared';
import { groupByDue } from '@os-planner/shared/boards';
import { Language } from '../../core/i18n';
import { BoardStore } from '../../data/board-store';
import { TeamStore } from '../../data/team-store';
import { chipStyle, formatDue, PRIORITY_ICON, zoneOffset } from './board-util';

interface Item {
  task: TaskDto;
  boardName: string;
  where: string;
}

/**
 * "My tasks": every task assigned to the person in every space whose boards they can see (their own, their teams', their
 * projects'), grouped by when it is due. Read from the local copy, so it is there offline too.
 */
@Component({
  selector: 'app-my-tasks',
  imports: [FormsModule, RouterLink, MatIconModule, TranslocoPipe],
  template: `
    <div class="page" data-my-tasks>
      <header>
        <h1><mat-icon aria-hidden="true">task_alt</mat-icon>{{ 'myTasks.title' | transloco }}</h1>
        <label class="chk"><input type="checkbox" [ngModel]="showDone()" (ngModelChange)="showDone.set($event)" data-show-done />{{ 'board.showDone' | transloco }}</label>
      </header>
      @for (g of groups(); track g.state) {
        <section [attr.data-group]="g.state">
          <h2>{{ 'myTasks.' + g.state | transloco }} <span class="count">{{ g.items.length }}</span></h2>
          @for (i of g.items; track i.task.id) {
            <a class="task" [routerLink]="['/app/b', i.task.boardId]" [queryParams]="{ task: i.task.id }" [class.done]="!!i.task.completedAt" [attr.data-task]="i.task.title" [attr.data-task-id]="i.task.id">
              <span class="ttl">{{ i.task.title }}</span>
              <span class="where muted">{{ i.where }}</span>
              @if (i.task.priority !== 'none') {
                <mat-icon class="pri" [class.hot]="i.task.priority === 'urgent' || i.task.priority === 'high'" [attr.title]="'task.priority.' + i.task.priority | transloco">{{ icons[i.task.priority] }}</mat-icon>
              }
              @if (i.task.dueAt) {
                <span class="due" [class]="'due d-' + g.state">{{ due(i.task) }}</span>
              }
            </a>
          }
        </section>
      } @empty {
        <p class="muted empty" data-my-tasks-empty>{{ 'myTasks.empty' | transloco }}</p>
      }
    </div>
  `,
  styles: `
    .page { max-width: 860px; margin: 0 auto; padding: 24px 20px; }
    header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
    h1 { margin: 0; font-size: 26px; display: flex; align-items: center; gap: 8px; flex: 1; }
    h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-dim); margin: 22px 0 6px; }
    .count { font-weight: 400; margin-left: 6px; }
    .chk { font-size: 13px; color: var(--text-dim); display: inline-flex; align-items: center; gap: 4px; }
    .task { display: flex; align-items: center; gap: 12px; padding: 9px 12px; border-radius: 10px; color: var(--text); text-decoration: none; }
    .task:hover { background: var(--surface-3); }
    .task.done .ttl { text-decoration: line-through; color: var(--text-dim); }
    .ttl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .where { font-size: 13px; white-space: nowrap; }
    .due { font-size: 12px; padding: 1px 8px; border-radius: 8px; background: var(--surface-3); white-space: nowrap; }
    .due.d-overdue { background: var(--mat-sys-error); color: var(--mat-sys-on-error); }
    .due.d-today { background: color-mix(in srgb, #eab308 60%, var(--surface)); }
    .pri { font-size: 18px; width: 18px; height: 18px; color: var(--text-dim); }
    .pri.hot { color: var(--mat-sys-error); }
    .muted { color: var(--text-dim); }
    .empty { text-align: center; padding: 48px 0; }
    @media (max-width: 640px) { .where { display: none; } }
  `,
})
export class MyTasksPage {
  private readonly store = inject(BoardStore);
  private readonly teams = inject(TeamStore);
  private readonly lang = inject(Language);
  private readonly router = inject(Router);

  protected readonly icons = PRIORITY_ICON;
  protected chip = chipStyle;
  protected readonly showDone = signal(false);

  private readonly items = computed<Item[]>(() => {
    const me = this.store.userId();
    const boards = this.store.boardById();
    const out: Item[] = [];
    for (const task of this.store.tasks()) {
      if (task.deletedAt || !task.assigneeIds.includes(me)) continue;
      const board = boards.get(task.boardId);
      if (!board || board.deletedAt) continue;
      if (!this.showDone() && task.completedAt) continue;
      const place = this.teams.placeOfSpace(board.spaceId);
      const where = place?.team ? [place.team.name, ...place.projects.map((p) => p.name)].join(' / ') : this.lang.t('myTasks.personal');
      out.push({ task, boardName: board.name, where: `${where} · ${board.name}` });
    }
    return out;
  });

  /** Overdue, today, upcoming and no date, each sorted by due date. A finished task is listed with the ones without a date. */
  protected readonly groups = computed(() => groupByDue(this.items(), Date.now(), zoneOffset()));

  protected due(t: TaskDto): string {
    return t.dueAt ? formatDue(t.dueAt, t.allDay, this.lang.current) : '';
  }

  protected open(t: TaskDto): void {
    void this.router.navigate(['/app/b', t.boardId], { queryParams: { task: t.id } });
  }
}
