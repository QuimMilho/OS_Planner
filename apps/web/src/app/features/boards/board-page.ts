import { CdkDrag, CdkDropList, CdkDropListGroup, type CdkDragDrop } from '@angular/cdk/drag-drop';
import { Component, ElementRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MatDialog, type MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { comparePositions, Permission, positionBetween } from '@os-planner/shared/lite';
import type { BoardDto, ColumnDto, TaskDto } from '@os-planner/shared';
import { map } from 'rxjs';
import { toProblem } from '../../core/auth-store';
import { Language } from '../../core/i18n';
import { Notify } from '../../core/notify';
import { Online } from '../../core/online';
import { BoardError, BoardStore } from '../../data/board-store';
import { Db } from '../../data/db';
import { Outbox } from '../../data/outbox';
import { Dialogs } from '../../shared/dialogs';
import { BoardSettingsDialog, BoardTrashDialog, LabelsDialog } from './board-dialogs';
import { chipStyle, dueOf, errKey, failKey, formatDue, initials, isFiltering, matches, NO_FILTER, PRIORITIES, PRIORITY_ICON, type BoardFilter } from './board-util';
import { TaskDrawer } from './task-drawer';

/** One list of cards a task can be dropped into: a column, in one swimlane. */
interface Cell {
  column: ColumnDto;
  lane: string;
  items: TaskDto[];
}

interface Lane {
  key: string;
  label: string;
  cells: Cell[];
}

interface SavedFilter {
  id: string;
  name: string;
  filter: BoardFilter;
}

type SortKey = 'title' | 'status' | 'priority' | 'due' | 'assignee';

const PRIORITY_RANK: Record<string, number> = { urgent: 4, high: 3, medium: 2, low: 1, none: 0 };
const COLLAPSED_PREFIX = 'os_planner.board.collapsed.';
const VIEW_PREFIX = 'os_planner.board.view.';

/**
 * A board: its columns of cards (drag them between columns and up and down; a column with a limit refuses a drop when it is full),
 * a list view of the same tasks, a filter bar, and the task panel. Everything is read from the local database, so it works offline.
 */
@Component({
  selector: 'app-board-page',
  imports: [FormsModule, RouterLink, MatButtonModule, MatIconModule, MatMenuModule, TranslocoPipe, CdkDropListGroup, CdkDropList, CdkDrag],
  template: `
    @if (board(); as b) {
      <div class="page" (keydown)="onKey($event)" data-board-page [attr.data-board-id]="b.id">
        <p id="board-card-hint" class="sr-only">{{ 'board.cardHint' | transloco }}</p>
        <header class="bar">
          <h1 data-board-title>
            <mat-icon aria-hidden="true">view_kanban</mat-icon>{{ b.name }}
          </h1>
          @if (b.archivedAt) {
            <span class="tag" data-archived>{{ 'board.archived' | transloco }}</span>
          }
          <span class="grow"></span>
          <div class="seg" role="group" [attr.aria-label]="'board.view' | transloco">
            <button type="button" [class.on]="view() === 'board'" (click)="setView('board')" data-view="board"><mat-icon>view_kanban</mat-icon>{{ 'board.viewBoard' | transloco }}</button>
            <button type="button" [class.on]="view() === 'list'" (click)="setView('list')" data-view="list"><mat-icon>table_rows</mat-icon>{{ 'board.viewList' | transloco }}</button>
          </div>
          @if (canCreate()) {
            <button mat-flat-button type="button" (click)="focusQuickAdd()" data-action="new-task"><mat-icon>add</mat-icon>{{ 'task.new' | transloco }}</button>
          }
          <button mat-icon-button type="button" [matMenuTriggerFor]="more" [attr.aria-label]="'common.more' | transloco" data-board-menu><mat-icon>more_vert</mat-icon></button>
          <mat-menu #more="matMenu">
            @if (canManage()) {
              <button mat-menu-item type="button" (click)="settings()" data-action="board-settings"><mat-icon>tune</mat-icon>{{ 'board.settings' | transloco }}</button>
            }
            <button mat-menu-item type="button" (click)="labels()" data-action="labels"><mat-icon>label</mat-icon>{{ 'label.title' | transloco }}</button>
            <button mat-menu-item type="button" (click)="trash()" data-action="board-trash"><mat-icon>delete_sweep</mat-icon>{{ 'board.trash' | transloco }}</button>
            @if (canManage()) {
              <button mat-menu-item type="button" (click)="duplicate()" data-action="duplicate-board"><mat-icon>content_copy</mat-icon>{{ 'board.duplicate' | transloco }}</button>
              <button mat-menu-item type="button" (click)="archive()" data-action="archive-board"><mat-icon>{{ b.archivedAt ? 'unarchive' : 'archive' }}</mat-icon>{{ (b.archivedAt ? 'board.unarchive' : 'board.archive') | transloco }}</button>
              <button mat-menu-item type="button" (click)="remove()" data-action="delete-board"><mat-icon>delete</mat-icon>{{ 'board.delete' | transloco }}</button>
            }
          </mat-menu>
        </header>

        <div class="filters" role="search" data-filters>
          <input type="search" [ngModel]="filter().text" (ngModelChange)="setFilter({ text: $event })" [placeholder]="'board.filterText' | transloco" [attr.aria-label]="'board.filterText' | transloco" data-filter-text />
          <select [ngModel]="filter().assignee" (ngModelChange)="setFilter({ assignee: $event })" [attr.aria-label]="'task.assignees' | transloco" data-filter-assignee>
            <option value="any">{{ 'board.anyone' | transloco }}</option>
            <option value="none">{{ 'board.unassigned' | transloco }}</option>
            @for (m of members(); track m.userId) {
              <option [value]="m.userId">{{ m.displayName }}</option>
            }
          </select>
          <select [ngModel]="filter().labelId" (ngModelChange)="setFilter({ labelId: $event })" [attr.aria-label]="'task.labels' | transloco" data-filter-label>
            <option value="">{{ 'board.anyLabel' | transloco }}</option>
            @for (l of boardLabels(); track l.id) {
              <option [value]="l.id">{{ l.name }}</option>
            }
          </select>
          <select [ngModel]="filter().priority" (ngModelChange)="setFilter({ priority: $event })" [attr.aria-label]="'task.priorityLabel' | transloco" data-filter-priority>
            <option value="">{{ 'board.anyPriority' | transloco }}</option>
            @for (p of priorities; track p) {
              <option [value]="p">{{ 'task.priority.' + p | transloco }}</option>
            }
          </select>
          <select [ngModel]="filter().due" (ngModelChange)="setFilter({ due: $event })" [attr.aria-label]="'task.due' | transloco" data-filter-due>
            <option value="">{{ 'board.anyDue' | transloco }}</option>
            @for (d of dueStates; track d) {
              <option [value]="d">{{ 'task.dueState.' + d | transloco }}</option>
            }
          </select>
          <label class="chk"><input type="checkbox" [ngModel]="filter().showDone" (ngModelChange)="setFilter({ showDone: $event })" />{{ 'board.showDone' | transloco }}</label>
          @if (view() === 'board') {
            <label class="chk"><input type="checkbox" [ngModel]="lanes()" (ngModelChange)="lanes.set($event)" data-swimlanes />{{ 'board.swimlanes' | transloco }}</label>
          }
          @if (filtering()) {
            <button mat-button type="button" (click)="clearFilter()" data-action="clear-filter">{{ 'board.clearFilter' | transloco }}</button>
            <button mat-button type="button" (click)="saveFilter()" data-action="save-filter">{{ 'board.saveFilter' | transloco }}</button>
          }
          @if (saved().length) {
            <button mat-button type="button" [matMenuTriggerFor]="savedMenu" data-action="saved-filters"><mat-icon>bookmark</mat-icon>{{ 'board.savedFilters' | transloco }}</button>
            <mat-menu #savedMenu="matMenu">
              @for (s of saved(); track s.id) {
                <div class="saved">
                  <button mat-menu-item type="button" (click)="applySaved(s)">{{ s.name }}</button>
                  <button type="button" class="x" (click)="dropSaved(s)" [attr.aria-label]="'common.delete' | transloco"><mat-icon>close</mat-icon></button>
                </div>
              }
            </mat-menu>
          }
        </div>

        @if (view() === 'board') {
          <div class="kanban" cdkDropListGroup data-kanban>
            @for (lane of grid(); track lane.key) {
              @if (grid().length > 1) {
                <h3 class="lane" [attr.data-lane]="lane.label">{{ lane.label }}</h3>
              }
              <div class="cols">
                @for (cell of lane.cells; track cell.column.id) {
                  <section class="col" [class.collapsed]="isCollapsed(cell.column.id)" [class.full]="isFull(cell.column)" [attr.data-column]="cell.column.name" [attr.data-column-id]="cell.column.id">
                    <header>
                      <button type="button" class="fold" (click)="toggleCollapse(cell.column.id)" [attr.aria-expanded]="!isCollapsed(cell.column.id)" [attr.aria-label]="cell.column.name">
                        <mat-icon>{{ isCollapsed(cell.column.id) ? 'chevron_right' : 'expand_more' }}</mat-icon>
                      </button>
                      <span class="cname" [style]="colorStyle(cell.column)">{{ cell.column.name }}</span>
                      <span class="count" [class.over]="isFull(cell.column)" data-wip [attr.data-count]="count(cell.column)" [attr.title]="wipTitle(cell.column)">
                        {{ count(cell.column) }}@if (cell.column.wipLimit) {<ng-container>/{{ cell.column.wipLimit }}</ng-container>}
                      </span>
                    </header>
                    @if (!isCollapsed(cell.column.id)) {
                      <div
                        class="cards"
                        cdkDropList
                        [cdkDropListData]="cell"
                        [cdkDropListDisabled]="!canMoveAny()"
                        (cdkDropListDropped)="dropped($event)"
                        [attr.data-cards]="cell.column.name"
                      >
                        @for (t of cell.items; track t.id) {
                          <article
                            class="card"
                            cdkDrag
                            [cdkDragData]="t"
                            [cdkDragDisabled]="!canMove(t)"
                            tabindex="0"
                            aria-describedby="board-card-hint"
                            aria-keyshortcuts="Enter Alt+ArrowLeft Alt+ArrowRight"
                            [attr.data-task]="t.title"
                            [attr.data-task-id]="t.id"
                            [class.done]="!!t.completedAt"
                            (click)="open(t.id)"
                          >
                            @if (t.labelIds.length) {
                              <div class="labs">
                                @for (l of labelsOf(t); track l.id) {
                                  <span class="lab" [style]="chip(l.color)" [attr.title]="l.name">{{ l.name }}</span>
                                }
                              </div>
                            }
                            <div class="ttl">{{ t.title }}@if (outbox.pendingIds().has(t.id)) { <i class="unsynced" data-unsynced [attr.title]="'offline.unsynced' | transloco"></i> }</div>
                            <div class="meta">
                              @if (t.priority !== 'none') {
                                <span class="pri" [class]="'pri p-' + t.priority" [attr.title]="'task.priority.' + t.priority | transloco"><mat-icon>{{ priorityIcon[t.priority] }}</mat-icon></span>
                              }
                              @if (t.dueAt) {
                                <span class="due" [class]="'due d-' + dueState(t)" data-due>{{ due(t) }}</span>
                              }
                              @if (t.checklist.length) {
                                <span class="ic" data-checklist><mat-icon>checklist</mat-icon>{{ doneOf(t) }}/{{ t.checklist.length }}</span>
                              }
                              @if (subCount(t.id)) {
                                <span class="ic"><mat-icon>account_tree</mat-icon>{{ subCount(t.id) }}</span>
                              }
                              @if (t.commentCount) {
                                <span class="ic"><mat-icon>chat_bubble_outline</mat-icon>{{ t.commentCount }}</span>
                              }
                              @if (t.attachmentCount) {
                                <span class="ic"><mat-icon>attach_file</mat-icon>{{ t.attachmentCount }}</span>
                              }
                              <span class="grow"></span>
                              @for (id of t.assigneeIds.slice(0, 3); track id) {
                                <span class="av" [attr.title]="nameOf(id)">{{ initialsOf(nameOf(id)) }}</span>
                              }
                            </div>
                          </article>
                        }
                      </div>
                      @if (canCreate() && lane.key === grid()[0]!.key) {
                        <input
                          class="quick"
                          type="text"
                          [placeholder]="'task.quickAdd' | transloco"
                          [attr.aria-label]="'task.quickAdd' | transloco"
                          maxlength="200"
                          (keydown.enter)="quickAdd(cell.column, $any($event.target))"
                          data-quick-add
                        />
                      }
                    }
                  </section>
                }
              </div>
            }
          </div>
        } @else {
          <div class="listwrap">
            <div class="row opts">
              <label>{{ 'board.groupBy' | transloco }}
                <select [ngModel]="group()" (ngModelChange)="group.set($event)" data-group-by>
                  <option value="none">{{ 'board.groupNone' | transloco }}</option>
                  <option value="status">{{ 'task.status' | transloco }}</option>
                  <option value="assignee">{{ 'task.assignees' | transloco }}</option>
                  <option value="due">{{ 'task.due' | transloco }}</option>
                  <option value="priority">{{ 'task.priorityLabel' | transloco }}</option>
                </select>
              </label>
              @if (canCreate()) {
                <input class="quick" type="text" [placeholder]="'task.quickAdd' | transloco" maxlength="200" (keydown.enter)="quickAddFirst($any($event.target))" data-quick-add />
              }
            </div>
            <table class="list" data-list>
              <thead>
                <tr>
                  <th></th>
                  @for (k of sortKeys; track k) {
                    <th>
                      <button type="button" (click)="sortBy(k)" [attr.data-sort]="k">{{ 'board.col.' + k | transloco }}@if (sort().key === k) {<mat-icon>{{ sort().dir === 1 ? 'arrow_upward' : 'arrow_downward' }}</mat-icon>}</button>
                    </th>
                  }
                  <th>{{ 'task.labels' | transloco }}</th>
                </tr>
              </thead>
              @for (g of groupedRows(); track g.key) {
                <tbody>
                  @if (group() !== 'none') {
                    <tr class="grp"><th colspan="7" [attr.data-group]="g.label">{{ g.label }} <span class="muted">{{ g.rows.length }}</span></th></tr>
                  }
                  @for (t of g.rows; track t.id) {
                    <tr [attr.data-task]="t.title" [attr.data-task-id]="t.id" [class.done]="!!t.completedAt">
                      <td><input type="checkbox" [checked]="!!t.completedAt" [disabled]="!canEditOwn(t)" (change)="done(t, $any($event.target).checked)" [attr.aria-label]="'task.markDone' | transloco" /></td>
                      <td>
                        <input type="text" class="cell title" [value]="t.title" [disabled]="!canEditOwn(t)" (change)="rename(t, $any($event.target).value)" (dblclick)="open(t.id)" maxlength="200" data-cell="title" />
                        <button type="button" class="openbtn" (click)="open(t.id)" [attr.aria-label]="'common.open' | transloco"><mat-icon>open_in_new</mat-icon></button>
                      </td>
                      <td>
                        <select class="cell" [value]="t.columnId" [disabled]="!canMove(t)" (change)="setStatus(t, $any($event.target).value)" data-cell="status">
                          @for (c of columns(); track c.id) {
                            <option [value]="c.id" [selected]="c.id === t.columnId">{{ c.name }}</option>
                          }
                        </select>
                      </td>
                      <td>
                        <select class="cell" [disabled]="!canEdit()" (change)="priority(t, $any($event.target).value)" data-cell="priority">
                          @for (p of priorities; track p) {
                            <option [value]="p" [selected]="p === t.priority">{{ 'task.priority.' + p | transloco }}</option>
                          }
                        </select>
                      </td>
                      <td>
                        <input type="date" class="cell" [value]="dueValue(t)" [disabled]="!canEdit() || !t.allDay && !!t.dueAt" (change)="setDue(t, $any($event.target).value)" data-cell="due" />
                      </td>
                      <td>{{ names(t) }}</td>
                      <td>
                        @for (l of labelsOf(t); track l.id) {
                          <span class="lab" [style]="chip(l.color)">{{ l.name }}</span>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              }
            </table>
          </div>
        }
      </div>
    } @else if (missing()) {
      <div class="nf" role="alert">
        <mat-icon>search_off</mat-icon>
        <h1>{{ 'errors.notFoundTitle' | transloco }}</h1>
        <p class="muted">{{ 'errors.notFound' | transloco }}</p>
        <a mat-flat-button routerLink="/app">{{ 'errors.backHome' | transloco }}</a>
      </div>
    } @else {
      <p class="muted loading">{{ 'common.loading' | transloco }}</p>
    }
  `,
  styles: `
    :host { display: block; height: 100%; }
    .page { display: flex; flex-direction: column; height: 100%; min-height: 0; padding: 12px 16px 0; box-sizing: border-box; }
    .bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    h1 { margin: 0; font-size: 22px; display: flex; align-items: center; gap: 8px; }
    .grow { flex: 1; }
    .tag { font-size: 12px; padding: 1px 8px; border-radius: 10px; background: var(--surface-3); color: var(--text-dim); }
    .seg { display: inline-flex; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
    .seg button { display: inline-flex; align-items: center; gap: 4px; border: 0; background: none; color: var(--text-dim); padding: 6px 10px; cursor: pointer; font: inherit; font-size: 13px; }
    .seg button.on { background: var(--surface-3); color: var(--text); }
    .seg mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 10px 0; }
    .filters input[type='search'], .filters select, .quick, .cell { font: inherit; font-size: 13px; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 5px 8px; }
    .chk { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; color: var(--text-dim); }
    .saved { display: flex; align-items: center; }
    .x { border: 0; background: none; color: var(--text-dim); cursor: pointer; padding: 4px; display: grid; place-items: center; }
    .kanban { flex: 1; min-height: 0; overflow: auto; padding-bottom: 16px; }
    .lane { margin: 14px 0 6px; font-size: 14px; color: var(--text-dim); }
    .cols { display: flex; gap: 12px; align-items: flex-start; min-width: min-content; padding-bottom: 8px; }
    .col { width: 280px; flex: none; background: var(--surface-2, var(--surface-3)); border-radius: 12px; padding: 8px; display: flex; flex-direction: column; gap: 8px; border: 2px solid transparent; }
    .col.collapsed { width: 56px; }
    .col.collapsed .cname { writing-mode: vertical-rl; }
    .col.full { border-color: color-mix(in srgb, var(--mat-sys-error) 60%, transparent); }
    .col header { display: flex; align-items: center; gap: 4px; }
    .fold { border: 0; background: none; color: var(--text-dim); cursor: pointer; display: grid; place-items: center; padding: 0; }
    .cname { flex: 1; font-weight: 600; font-size: 14px; padding: 0 4px; border-radius: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .count { font-size: 12px; color: var(--text-dim); background: var(--surface); border-radius: 10px; padding: 1px 8px; }
    .count.over { background: var(--mat-sys-error); color: var(--mat-sys-on-error); }
    .cards { display: flex; flex-direction: column; gap: 8px; min-height: 40px; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; cursor: pointer; display: flex; flex-direction: column; gap: 6px; outline: none; }
    .card:hover, .card:focus-visible { border-color: var(--accent); }
    .card.done .ttl { text-decoration: line-through; color: var(--text-dim); }
    .ttl { font-size: 14px; overflow-wrap: anywhere; }
    .unsynced { display: inline-block; width: 7px; height: 7px; margin-left: 6px; border-radius: 50%; background: var(--accent); vertical-align: middle; }
    .labs { display: flex; gap: 4px; flex-wrap: wrap; }
    .lab { padding: 0 8px; border-radius: 10px; font-size: 11px; line-height: 18px; margin-right: 4px; display: inline-block; }
    .meta { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-dim); flex-wrap: wrap; }
    .ic { display: inline-flex; align-items: center; gap: 2px; }
    .ic mat-icon, .pri mat-icon { font-size: 15px; width: 15px; height: 15px; }
    .pri.p-urgent, .pri.p-high { color: var(--mat-sys-error); }
    .due { padding: 0 6px; border-radius: 6px; background: var(--surface-3); }
    .due.d-overdue { background: var(--mat-sys-error); color: var(--mat-sys-on-error); }
    .due.d-today { background: color-mix(in srgb, #eab308 60%, var(--surface)); color: var(--text); }
    .av { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; background: var(--accent); color: var(--mat-sys-on-primary); font-size: 10px; font-weight: 700; margin-left: -4px; }
    .quick { width: 100%; box-sizing: border-box; }
    .cdk-drag-preview { box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35); border-radius: 10px; background: var(--surface); padding: 8px 10px; }
    .cdk-drag-placeholder { opacity: 0.3; }
    .cdk-drop-list-dragging .card:not(.cdk-drag-placeholder) { transition: transform 150ms; }
    .listwrap { flex: 1; overflow: auto; padding-bottom: 16px; }
    .opts { display: flex; gap: 12px; align-items: center; margin-bottom: 8px; font-size: 13px; }
    .opts .quick { max-width: 320px; }
    table.list { width: 100%; border-collapse: collapse; font-size: 13px; }
    .list th, .list td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }
    .list th button { border: 0; background: none; color: var(--text-dim); font: inherit; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; padding: 0; }
    .list th mat-icon { font-size: 14px; width: 14px; height: 14px; }
    .list .grp th { background: var(--surface-3); }
    .list tr.done td { color: var(--text-dim); }
    .cell { width: 100%; box-sizing: border-box; border-color: transparent; background: transparent; }
    .cell:hover:not(:disabled), .cell:focus { border-color: var(--border); background: var(--surface); }
    td:nth-child(2) { display: flex; align-items: center; gap: 4px; }
    .openbtn { border: 0; background: none; color: var(--text-dim); cursor: pointer; display: grid; padding: 0; }
    .openbtn mat-icon { font-size: 16px; width: 16px; height: 16px; }
    .muted { color: var(--text-dim); }
    .loading, .nf { padding: 48px 20px; text-align: center; }
    .nf { display: flex; flex-direction: column; align-items: center; gap: 12px; }
    @media (max-width: 640px) { .col { width: 82vw; } }
  `,
})
export class BoardPage {
  protected readonly store = inject(BoardStore);
  protected readonly outbox = inject(Outbox);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly dialog = inject(MatDialog);
  private readonly dialogs = inject(Dialogs);
  private readonly notify = inject(Notify);
  private readonly lang = inject(Language);
  private readonly dbs = inject(Db);
  private readonly online = inject(Online);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly priorities = PRIORITIES;
  protected readonly priorityIcon = PRIORITY_ICON;
  protected readonly dueStates = ['overdue', 'today', 'upcoming', 'none'] as const;
  protected readonly sortKeys: SortKey[] = ['title', 'status', 'priority', 'due', 'assignee'];
  protected chip = chipStyle;
  protected initialsOf = initials;

  private readonly boardId = toSignal(this.route.paramMap.pipe(map((p) => p.get('boardId') ?? '')), { initialValue: '' });
  private readonly taskParam = toSignal(this.route.queryParamMap.pipe(map((p) => p.get('task'))), { initialValue: null });
  protected readonly missing = signal(false);

  protected readonly board = computed(() => {
    const b = this.store.boardById().get(this.boardId());
    return b && !b.deletedAt ? b : undefined;
  });
  protected readonly columns = computed(() => this.store.columnsOf(this.boardId()));
  protected readonly members = computed(() => (this.board() ? this.store.membersOf(this.board()!) : []));
  protected readonly boardLabels = computed(() => (this.board() ? this.store.labelsFor(this.board()!.spaceId) : []));
  protected readonly canCreate = computed(() => !!this.board() && !this.board()!.archivedAt && this.store.can(this.boardId(), Permission.CREATE_TASKS));
  protected readonly canEdit = computed(() => !!this.board() && !this.board()!.archivedAt && this.store.can(this.boardId(), Permission.EDIT_TASKS));
  protected readonly canManage = computed(() => this.store.can(this.boardId(), Permission.MANAGE_BOARDS));
  private readonly me = this.store.userId;

  // ---- view state
  protected readonly view = signal<'board' | 'list'>('board');
  protected readonly filter = signal<BoardFilter>({ ...NO_FILTER });
  protected readonly filtering = computed(() => isFiltering(this.filter()));
  protected readonly lanes = signal(false);
  protected readonly group = signal<'none' | 'status' | 'assignee' | 'due' | 'priority'>('none');
  protected readonly sort = signal<{ key: SortKey; dir: 1 | -1 }>({ key: 'status', dir: 1 });
  protected readonly collapsed = signal<ReadonlySet<string>>(new Set());
  protected readonly saved = signal<SavedFilter[]>([]);
  private drawer: MatDialogRef<TaskDrawer> | null = null;

  /** Top-level tasks by column (everything in it, whatever the filter says: the limit counts them all). */
  private readonly byColumn = computed(() => {
    const out = new Map<string, TaskDto[]>();
    for (const t of this.store.tasks()) {
      if (t.boardId !== this.boardId() || t.deletedAt || t.parentTaskId) continue;
      (out.get(t.columnId) ?? out.set(t.columnId, []).get(t.columnId)!).push(t);
    }
    for (const list of out.values()) list.sort(comparePositions);
    return out;
  });
  private readonly subCounts = computed(() => {
    const out = new Map<string, number>();
    for (const t of this.store.tasks()) if (t.parentTaskId && !t.deletedAt && t.boardId === this.boardId()) out.set(t.parentTaskId, (out.get(t.parentTaskId) ?? 0) + 1);
    return out;
  });

  /** The lists cards can be dropped in: one per column, or one per column for each person when swimlanes are on. */
  protected readonly grid = computed<Lane[]>(() => {
    const now = Date.now();
    const f = this.filter();
    const cols = this.columns();
    const visible = (c: ColumnDto) => (this.byColumn().get(c.id) ?? []).filter((t) => matches(t, f, now));
    if (!this.lanes()) return [{ key: 'all', label: '', cells: cols.map((column) => ({ column, lane: 'all', items: visible(column) })) }];
    const people = this.members().filter((m) => this.store.tasks().some((t) => t.boardId === this.boardId() && !t.deletedAt && t.assigneeIds.includes(m.userId)));
    const lanes: Lane[] = people.map((m) => ({ key: m.userId, label: m.displayName, cells: cols.map((column) => ({ column, lane: m.userId, items: visible(column).filter((t) => t.assigneeIds.includes(m.userId)) })) }));
    lanes.push({ key: 'none', label: this.lang.t('board.unassigned'), cells: cols.map((column) => ({ column, lane: 'none', items: visible(column).filter((t) => !t.assigneeIds.length) })) });
    return lanes;
  });

  protected readonly rows = computed(() => {
    const f = this.filter();
    const now = Date.now();
    const colName = new Map(this.columns().map((c) => [c.id, c]));
    const { key, dir } = this.sort();
    const rank = (t: TaskDto): string | number => {
      if (key === 'title') return t.title.toLowerCase();
      if (key === 'status') return `${(colName.get(t.columnId)?.position ?? '')}`;
      if (key === 'priority') return PRIORITY_RANK[t.priority] ?? 0;
      if (key === 'due') return t.dueAt ? Date.parse(t.dueAt) : Number.POSITIVE_INFINITY;
      return this.names(t).toLowerCase();
    };
    return this.store
      .tasks()
      .filter((t) => t.boardId === this.boardId() && !t.deletedAt && !t.parentTaskId && matches(t, f, now))
      .sort((a, b) => {
        const x = rank(a);
        const y = rank(b);
        return (x < y ? -1 : x > y ? 1 : comparePositions(a, b)) * dir;
      });
  });

  protected readonly groupedRows = computed(() => {
    const g = this.group();
    const rows = this.rows();
    if (g === 'none') return [{ key: 'all', label: '', rows }];
    const cols = new Map(this.columns().map((c) => [c.id, c.name]));
    const label = (t: TaskDto): string[] => {
      if (g === 'status') return [cols.get(t.columnId) ?? '?'];
      if (g === 'priority') return [this.lang.t(`task.priority.${t.priority}`)];
      if (g === 'due') return [this.lang.t(`task.dueState.${dueOf(t)}`)];
      return t.assigneeIds.length ? t.assigneeIds.map((id) => this.nameOf(id)) : [this.lang.t('board.unassigned')];
    };
    const out = new Map<string, TaskDto[]>();
    for (const t of rows) for (const l of label(t)) (out.get(l) ?? out.set(l, []).get(l)!).push(t);
    return [...out].map(([key, list]) => ({ key, label: key, rows: list }));
  });

  constructor() {
    // Open (and keep current) the board named by the address: the local copy first, then the server's.
    effect((onCleanup) => {
      const id = this.boardId();
      if (!id) return;
      untracked(() => {
        this.missing.set(false);
        this.restoreView(id);
        const leave = this.store.open(id);
        onCleanup(leave);
        if (this.online.isOnline()) void this.store.loadBoard(id).then((d) => !d && !this.store.boardById().get(id) && this.missing.set(true), () => undefined);
        else if (!this.store.boardById().get(id)) setTimeout(() => !this.store.boardById().get(id) && this.missing.set(true), 600);
      });
    });
    effect(() => {
      // once the server says there is no such board, or it went away
      const b = this.store.boardById().get(this.boardId());
      if (b?.deletedAt) untracked(() => this.missing.set(true));
    });
    // The task panel follows `?task=`.
    effect(() => {
      const id = this.taskParam();
      untracked(() => this.syncDrawer(id));
    });
  }

  // ------------------------------------------------------------------ the task panel

  private syncDrawer(id: string | null): void {
    if (!id) {
      this.drawer?.close();
      return;
    }
    if (this.drawer) return;
    // A link may name a task this device has not got yet.
    if (!this.store.taskById().has(id) && this.online.isOnline()) void this.store.reloadTask(id);
    const ref = this.dialog.open(TaskDrawer, {
      data: { taskId: id },
      width: 'min(760px, 100vw)',
      maxWidth: '100vw',
      height: '100vh',
      position: { right: '0', top: '0' },
      panelClass: 'task-drawer',
      ariaLabel: this.lang.t('task.drawer'),
      autoFocus: false,
    });
    this.drawer = ref;
    ref.afterClosed().subscribe(() => {
      this.drawer = null;
      if (this.taskParam()) void this.router.navigate([], { relativeTo: this.route, queryParams: { task: null }, queryParamsHandling: 'merge', replaceUrl: true });
    });
  }

  protected open(id: string): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: { task: id }, queryParamsHandling: 'merge' });
  }

  // ------------------------------------------------------------------ what is shown

  protected count(c: ColumnDto): number {
    return (this.byColumn().get(c.id) ?? []).length;
  }
  protected isFull(c: ColumnDto): boolean {
    return !!c.wipLimit && this.count(c) >= c.wipLimit;
  }
  protected wipTitle(c: ColumnDto): string | null {
    return c.wipLimit ? this.lang.t('column.wipTitle', { n: this.count(c), limit: c.wipLimit }) : null;
  }
  protected colorStyle(c: ColumnDto): Record<string, string> {
    return c.color ? { ...chipStyle(c.color), padding: '0 8px' } : {};
  }
  protected labelsOf(t: TaskDto) {
    return this.boardLabels().filter((l) => t.labelIds.includes(l.id));
  }
  protected doneOf(t: TaskDto): number {
    return t.checklist.filter((c) => c.done).length;
  }
  protected subCount(id: string): number {
    return this.subCounts().get(id) ?? 0;
  }
  protected nameOf(userId: string): string {
    return this.store.nameOf(this.board(), userId);
  }
  protected names(t: TaskDto): string {
    return t.assigneeIds.map((id) => this.nameOf(id)).join(', ');
  }
  protected dueState(t: TaskDto) {
    return dueOf(t);
  }
  protected due(t: TaskDto): string {
    return t.dueAt ? formatDue(t.dueAt, t.allDay, this.lang.current) : '';
  }
  protected dueValue(t: TaskDto): string {
    return t.dueAt ? (t.allDay ? t.dueAt.slice(0, 10) : t.dueAt.slice(0, 10)) : '';
  }

  // ------------------------------------------------------------------ rights

  protected canEditOwn(t: TaskDto): boolean {
    const b = this.board();
    return !!b && !b.archivedAt && (this.canEdit() || t.createdBy === this.me() || t.assigneeIds.includes(this.me()));
  }
  protected canMove(t: TaskDto): boolean {
    return !t.parentTaskId && this.canEditOwn(t);
  }
  protected canMoveAny(): boolean {
    return !!this.board() && !this.board()!.archivedAt && (this.canEdit() || this.store.tasks().some((t) => t.boardId === this.boardId() && this.canMove(t)));
  }

  // ------------------------------------------------------------------ view, filter, collapse

  private restoreView(boardId: string): void {
    try {
      this.view.set(localStorage.getItem(VIEW_PREFIX + boardId) === 'list' ? 'list' : 'board');
      this.collapsed.set(new Set(JSON.parse(localStorage.getItem(COLLAPSED_PREFIX + boardId) ?? '[]') as string[]));
    } catch {
      /* storage unavailable: defaults */
    }
    this.filter.set({ ...NO_FILTER });
    void this.dbs.db.meta.get(`bf:${boardId}`).then((row) => this.saved.set(((row?.value as SavedFilter[] | undefined) ?? []).slice(0, 20)));
  }

  protected setView(v: 'board' | 'list'): void {
    this.view.set(v);
    try {
      localStorage.setItem(VIEW_PREFIX + this.boardId(), v);
    } catch {
      /* ignore */
    }
  }
  protected isCollapsed(id: string): boolean {
    return this.collapsed().has(id);
  }
  protected toggleCollapse(id: string): void {
    const next = new Set(this.collapsed());
    if (!next.delete(id)) next.add(id);
    this.collapsed.set(next);
    try {
      localStorage.setItem(COLLAPSED_PREFIX + this.boardId(), JSON.stringify([...next]));
    } catch {
      /* ignore */
    }
  }
  protected setFilter(change: Partial<BoardFilter>): void {
    this.filter.update((f) => ({ ...f, ...change }));
  }
  protected clearFilter(): void {
    this.filter.set({ ...NO_FILTER });
  }
  protected async saveFilter(): Promise<void> {
    const answer = await this.dialogs.prompt({ titleKey: 'board.saveFilter', labelKey: 'board.filterName', validate: (v) => (v.trim() ? null : 'board.nameRequired') });
    if (answer?.action !== 'ok') return;
    const next = [...this.saved(), { id: crypto.randomUUID(), name: answer.value.trim(), filter: { ...this.filter() } }].slice(-20);
    this.saved.set(next);
    await this.dbs.db.meta.put({ key: `bf:${this.boardId()}`, value: next });
  }
  protected applySaved(s: SavedFilter): void {
    this.filter.set({ ...NO_FILTER, ...s.filter });
  }
  protected async dropSaved(s: SavedFilter): Promise<void> {
    const next = this.saved().filter((x) => x.id !== s.id);
    this.saved.set(next);
    await this.dbs.db.meta.put({ key: `bf:${this.boardId()}`, value: next });
  }
  protected sortBy(key: SortKey): void {
    this.sort.update((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }));
  }

  // ------------------------------------------------------------------ dragging

  protected async dropped(event: CdkDragDrop<Cell>): Promise<void> {
    const task = event.item.data as TaskDto;
    const target = event.container.data;
    const sameList = event.previousContainer === event.container;
    // the neighbours are the cards on screen, without the one that was lifted
    const items = target.items.filter((t) => t.id !== task.id);
    const index = Math.min(event.currentIndex, items.length);
    if (sameList && event.previousIndex === event.currentIndex) return;
    let position: string;
    try {
      position = positionBetween(items[index - 1]?.position ?? null, items[index]?.position ?? null);
    } catch {
      position = positionBetween(items[index - 1]?.position ?? null, null);
    }
    await this.move(task, target.column, position);
  }

  private async move(task: TaskDto, column: ColumnDto, position: string): Promise<void> {
    try {
      await this.store.moveTask(task.id, column.id, position);
    } catch (e) {
      if (e instanceof BoardError && e.code === 'wip_limit') this.notify.error('board.wipFull', { name: column.name, limit: column.wipLimit });
      else this.notify.error(failKey(e));
    }
  }

  // ------------------------------------------------------------------ adding and editing

  protected async quickAdd(column: ColumnDto, input: HTMLInputElement): Promise<void> {
    const title = input.value.trim();
    const board = this.board();
    if (!title || !board) return;
    try {
      await this.store.createTask(board, column.id, title);
      input.value = '';
    } catch (e) {
      this.notify.error(failKey(e), { name: column.name, limit: column.wipLimit });
    }
  }
  protected quickAddFirst(input: HTMLInputElement): Promise<void> {
    const first = this.columns().find((c) => c.kind === 'todo') ?? this.columns()[0];
    return first ? this.quickAdd(first, input) : Promise.resolve();
  }
  protected focusQuickAdd(): void {
    this.view.set('board');
    setTimeout(() => this.host.nativeElement.querySelector<HTMLInputElement>('[data-quick-add]')?.focus(), 0);
  }

  protected rename(t: TaskDto, value: string): void {
    if (value.trim() && value.trim() !== t.title) void this.store.updateTask(t.id, { title: value.trim() });
  }
  protected done(t: TaskDto, completed: boolean): void {
    void this.store.updateTask(t.id, { completed });
  }
  protected priority(t: TaskDto, value: string): void {
    void this.store.updateTask(t.id, { priority: value as TaskDto['priority'] });
  }
  protected setDue(t: TaskDto, value: string): void {
    void this.store.updateTask(t.id, { allDay: true, dueAt: value ? `${value}T00:00:00.000Z` : null });
  }
  protected async setStatus(t: TaskDto, columnId: string): Promise<void> {
    const column = this.columns().find((c) => c.id === columnId);
    if (!column || column.id === t.columnId) return;
    await this.move(t, column, this.store.positionAt(t.boardId, column.id, Number.MAX_SAFE_INTEGER, null, t.id));
  }

  // ------------------------------------------------------------------ the keyboard

  protected onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement;
    const typing = target.closest('input, textarea, select, [contenteditable="true"]');
    if (typing) return;
    if (e.key.toLowerCase() === 'c' && !e.ctrlKey && !e.metaKey && !e.altKey && this.canCreate()) {
      e.preventDefault();
      this.focusQuickAdd();
      return;
    }
    const card = target.closest<HTMLElement>('article.card[data-task-id]');
    if (!card) return;
    const id = card.dataset['taskId']!;
    const task = this.store.taskById().get(id);
    if (!task) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      this.open(id);
    } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      const cols = this.columns();
      const next = cols[cols.findIndex((c) => c.id === task.columnId) + (e.key === 'ArrowRight' ? 1 : -1)];
      if (next && this.canMove(task)) {
        void this.move(task, next, this.store.positionAt(task.boardId, next.id, Number.MAX_SAFE_INTEGER, null, task.id)).then(() => setTimeout(() => this.focusCard(id), 50));
      }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const list = Array.from(card.parentElement?.querySelectorAll<HTMLElement>('article.card') ?? []);
      list[list.indexOf(card) + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const cols = Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('.cards'));
      const here = cols.indexOf(card.parentElement as HTMLElement);
      const index = Array.from(card.parentElement?.children ?? []).indexOf(card);
      const there = cols[here + (e.key === 'ArrowRight' ? 1 : -1)];
      const cards = Array.from(there?.querySelectorAll<HTMLElement>('article.card') ?? []);
      cards[Math.min(index, cards.length - 1)]?.focus();
    }
  }

  private focusCard(id: string): void {
    this.host.nativeElement.querySelector<HTMLElement>(`article.card[data-task-id="${id}"]`)?.focus();
  }

  // ------------------------------------------------------------------ the board's menu

  protected settings(): void {
    this.dialog.open(BoardSettingsDialog, { data: { boardId: this.boardId() }, width: 'min(720px, 96vw)' });
  }
  protected labels(): void {
    const b = this.board();
    if (b) this.dialog.open(LabelsDialog, { data: { spaceId: b.spaceId }, width: 'min(720px, 96vw)' });
  }
  protected trash(): void {
    this.dialog.open(BoardTrashDialog, { data: { boardId: this.boardId() }, width: 'min(560px, 96vw)' });
  }

  protected async duplicate(): Promise<void> {
    const withTasks = await this.dialogs.confirm({ titleKey: 'board.duplicate', messageKey: 'board.duplicateWithTasks', confirmKey: 'board.withTasks' });
    try {
      const copy = await this.store.duplicateBoard(this.boardId(), withTasks);
      void this.router.navigate(['/app/b', copy.id]);
    } catch (e) {
      this.notify.error(errKey(toProblem(e).code));
    }
  }

  protected async archive(): Promise<void> {
    const b = this.board() as BoardDto;
    try {
      await this.store.updateBoard(b.id, { archived: !b.archivedAt });
    } catch (e) {
      this.notify.error(errKey(toProblem(e).code));
    }
  }

  protected async remove(): Promise<void> {
    const b = this.board();
    if (!b) return;
    if (!(await this.dialogs.confirm({ titleKey: 'board.delete', messageKey: 'board.deleteMessage', params: { name: b.name }, confirmKey: 'common.delete', danger: true }))) return;
    try {
      await this.store.deleteBoard(b.id);
      void this.router.navigate(['/app']);
    } catch (e) {
      this.notify.error(errKey(toProblem(e).code));
    }
  }
}

/** `/app/task/:id` (what a notification or a pasted link opens): finds the board of the task and shows it with the task open. */
@Component({
  selector: 'app-task-redirect',
  template: ``,
})
export class TaskRedirect {
  constructor() {
    const route = inject(ActivatedRoute);
    const router = inject(Router);
    const store = inject(BoardStore);
    const id = route.snapshot.paramMap.get('id') ?? '';
    void (async () => {
      const task = store.taskById().get(id) ?? (await store.reloadTask(id));
      if (task) await router.navigate(['/app/b', task.boardId], { queryParams: { task: id }, replaceUrl: true });
      else await router.navigate(['/app/not-found'], { replaceUrl: true });
    })();
  }
}
