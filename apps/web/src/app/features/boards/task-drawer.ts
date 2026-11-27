import { HttpClient } from '@angular/common/http';
import { Component, DestroyRef, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { RouterLink } from '@angular/router';
import { HistoryStore } from '../../data/history-store';
import { Editor } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import { TranslocoPipe } from '@jsverse/transloco';
import { comparePositions, Permission, positionBetween } from '@os-planner/shared/lite';
import type { TaskAttachmentDto, TaskCommentDto, TaskDetailDto, TaskDto, TaskDocDto } from '@os-planner/shared';
import { validateTaskDescription } from '@os-planner/shared/boards';
import { firstValueFrom } from 'rxjs';
import { AuthStore, toProblem } from '../../core/auth-store';
import { apiUrl } from '../../core/api-config';
import { uuidv7 } from '../../core/ids';
import { Language } from '../../core/i18n';
import { Notify } from '../../core/notify';
import { Online } from '../../core/online';
import { RealtimeService } from '../../core/realtime';
import { BoardError, BoardStore } from '../../data/board-store';
import { MediaStore } from '../../data/media-store';
import { Dialogs } from '../../shared/dialogs';
import { chipStyle, commentParts, errKey, failKey, formatDue, fromInput, initials, PRIORITIES, PRIORITY_ICON, toInput } from './board-util';

export interface TaskDrawerData {
  taskId: string;
}

/**
 * The task as a panel: every field (title, column, priority, dates, people, labels), the description, the checklist, subtasks,
 * files, comments with mentions, and the history. Fields the person may not change are shown but locked. Changes to the task
 * itself are made here at once and queued like the board's (so they work offline); comments and files need a connection.
 */
@Component({
  selector: 'app-task-drawer',
  imports: [FormsModule, RouterLink, MatDialogModule, MatButtonModule, MatIconModule, MatMenuModule, TranslocoPipe],
  template: `
    @if (task(); as t) {
      <div class="drawer" data-task-drawer [attr.data-task-id]="t.id">
        <header class="top">
          <input
            class="title"
            type="text"
            [value]="t.title"
            [disabled]="!editOwn()"
            (change)="setTitle($any($event.target).value)"
            maxlength="200"
            [attr.aria-label]="'task.title' | transloco"
            data-task-title
          />
          <button mat-icon-button type="button" [matMenuTriggerFor]="more" [attr.aria-label]="'common.more' | transloco" data-task-menu><mat-icon>more_vert</mat-icon></button>
          <mat-menu #more="matMenu">
            <button mat-menu-item type="button" (click)="copyLink()" data-action="copy-link"><mat-icon>link</mat-icon>{{ 'task.copyLink' | transloco }}</button>
            @if (canCreate()) {
              <button mat-menu-item type="button" (click)="duplicate()" data-action="duplicate-task"><mat-icon>content_copy</mat-icon>{{ 'task.duplicate' | transloco }}</button>
            }
            @if (history.forEntity(data.taskId).length) {
              <a mat-menu-item routerLink="/app/history" [queryParams]="{ entity: data.taskId }" data-action="show-history"><mat-icon>history</mat-icon>{{ 'history.showMine' | transloco }}</a>
            }
            @if (canDelete()) {
              <button mat-menu-item type="button" (click)="remove()" data-action="delete-task"><mat-icon>delete</mat-icon>{{ 'task.delete' | transloco }}</button>
            }
          </mat-menu>
          <button mat-icon-button type="button" mat-dialog-close [aria-label]="'common.close' | transloco" data-action="close-task"><mat-icon>close</mat-icon></button>
        </header>
        @if (readOnly()) {
          <p class="muted lock"><mat-icon>lock</mat-icon>{{ 'task.readOnly' | transloco }}</p>
        }

        <section class="fields">
          <label class="f">
            <span>{{ 'task.status' | transloco }}</span>
            @if (t.parentTaskId) {
              <span class="v">{{ t.completedAt ? ('task.done' | transloco) : ('task.open' | transloco) }}</span>
            } @else {
              <select [value]="t.columnId" [disabled]="!editOwn()" (change)="setColumn($any($event.target).value)" data-field="status">
                @for (c of columns(); track c.id) {
                  <option [value]="c.id" [selected]="c.id === t.columnId">{{ c.name }}</option>
                }
              </select>
            }
          </label>
          <label class="f">
            <span>{{ 'task.priorityLabel' | transloco }}</span>
            <select [disabled]="!editAny()" (change)="patch({ priority: $any($event.target).value })" data-field="priority">
              @for (p of priorities; track p) {
                <option [value]="p" [selected]="p === t.priority">{{ 'task.priority.' + p | transloco }}</option>
              }
            </select>
          </label>
          <label class="f">
            <span>{{ 'task.start' | transloco }}</span>
            @if (t.allDay) {
              <input type="date" [value]="input(t.startAt, true)" [disabled]="!editAny()" (change)="setDate('startAt', $any($event.target).value)" data-field="start" />
            } @else {
              <input type="datetime-local" [value]="input(t.startAt, false)" [disabled]="!editAny()" (change)="setDate('startAt', $any($event.target).value)" data-field="start" />
            }
          </label>
          <label class="f">
            <span>{{ 'task.due' | transloco }}</span>
            @if (t.allDay) {
              <input type="date" [value]="input(t.dueAt, true)" [disabled]="!editAny()" (change)="setDate('dueAt', $any($event.target).value)" data-field="due" />
            } @else {
              <input type="datetime-local" [value]="input(t.dueAt, false)" [disabled]="!editAny()" (change)="setDate('dueAt', $any($event.target).value)" data-field="due" />
            }
          </label>
          <label class="f check">
            <input type="checkbox" [checked]="t.allDay" [disabled]="!editAny()" (change)="patch({ allDay: $any($event.target).checked })" data-field="all-day" />
            <span>{{ 'task.allDay' | transloco }}</span>
          </label>
          <label class="f check">
            <input type="checkbox" [checked]="!!t.completedAt" [disabled]="!editOwn()" (change)="patch({ completed: $any($event.target).checked })" data-field="completed" />
            <span>{{ 'task.markDone' | transloco }}</span>
          </label>
        </section>

        <section>
          <h3>{{ 'task.assignees' | transloco }}</h3>
          <div class="chips">
            @for (id of t.assigneeIds; track id) {
              <span class="person" [attr.data-assignee]="name(id)">
                <span class="av">{{ initialsOf(name(id)) }}</span>{{ name(id) }}
                @if (canAssign()) {
                  <button type="button" class="x" (click)="unassign(id)" [attr.aria-label]="'common.delete' | transloco"><mat-icon>close</mat-icon></button>
                }
              </span>
            } @empty {
              <span class="muted">{{ 'task.noAssignees' | transloco }}</span>
            }
            @if (canAssign()) {
              @if (!t.assigneeIds.includes(me())) {
                <button mat-stroked-button type="button" (click)="assign(me())" data-action="assign-me">{{ 'task.assignMe' | transloco }}</button>
              }
              <button mat-stroked-button type="button" [matMenuTriggerFor]="people" data-action="assign-menu"><mat-icon>person_add</mat-icon>{{ 'task.assign' | transloco }}</button>
              <mat-menu #people="matMenu">
                @for (m of members(); track m.userId) {
                  <button mat-menu-item type="button" (click)="toggleAssignee(m.userId)" [attr.data-assignee-option]="m.displayName">
                    <mat-icon>{{ t.assigneeIds.includes(m.userId) ? 'check_box' : 'check_box_outline_blank' }}</mat-icon>{{ m.displayName }}
                  </button>
                }
              </mat-menu>
            }
          </div>
        </section>

        <section>
          <h3>{{ 'task.labels' | transloco }}</h3>
          <div class="chips">
            @for (l of taskLabels(); track l.id) {
              <span class="lab" [style]="chip(l.color)" [attr.data-label]="l.name">{{ l.name }}</span>
            } @empty {
              <span class="muted">{{ 'task.noLabels' | transloco }}</span>
            }
            @if (editAny()) {
              <button mat-stroked-button type="button" [matMenuTriggerFor]="labelMenu" data-action="label-menu"><mat-icon>label</mat-icon>{{ 'task.addLabel' | transloco }}</button>
              <mat-menu #labelMenu="matMenu">
                @for (l of availableLabels(); track l.id) {
                  <button mat-menu-item type="button" (click)="toggleLabel(l.id)" [attr.data-label-option]="l.name">
                    <mat-icon>{{ t.labelIds.includes(l.id) ? 'check_box' : 'check_box_outline_blank' }}</mat-icon>{{ l.name }}
                  </button>
                } @empty {
                  <span class="menu-empty muted">{{ 'label.none' | transloco }}</span>
                }
              </mat-menu>
            }
          </div>
        </section>

        <section>
          <h3>{{ 'task.description' | transloco }}</h3>
          @if (editOwn()) {
            <div class="tools">
              <button type="button" (click)="cmd('bold')" [attr.aria-label]="'task.bold' | transloco"><mat-icon>format_bold</mat-icon></button>
              <button type="button" (click)="cmd('italic')" [attr.aria-label]="'task.italic' | transloco"><mat-icon>format_italic</mat-icon></button>
              <button type="button" (click)="cmd('bulletList')" [attr.aria-label]="'task.bullets' | transloco"><mat-icon>format_list_bulleted</mat-icon></button>
              <button type="button" (click)="cmd('orderedList')" [attr.aria-label]="'task.numbers' | transloco"><mat-icon>format_list_numbered</mat-icon></button>
              <button type="button" (click)="link()" [attr.aria-label]="'task.link' | transloco"><mat-icon>link</mat-icon></button>
            </div>
          }
          <div class="desc" #desc data-task-description [class.ro]="!editOwn()"></div>
        </section>

        <section>
          <h3>{{ 'checklist.title' | transloco }} @if (t.checklist.length) { <span class="muted" data-checklist-progress>{{ doneCount(t) }}/{{ t.checklist.length }}</span> }</h3>
          @if (t.checklist.length) {
            <div class="bar"><span [style.width.%]="(doneCount(t) * 100) / t.checklist.length"></span></div>
          }
          @for (c of t.checklist; track c.id) {
            <div class="item" [attr.data-checklist-item]="c.text">
              <input type="checkbox" [checked]="c.done" [disabled]="!editOwn()" (change)="toggleItem(c.id, $any($event.target).checked)" [attr.aria-label]="c.text" />
              <input type="text" class="grow" [value]="c.text" [disabled]="!editOwn()" (change)="editItem(c.id, $any($event.target).value)" maxlength="300" />
              @if (editOwn()) {
                <button type="button" class="x" (click)="removeItem(c.id)" [attr.aria-label]="'common.delete' | transloco"><mat-icon>close</mat-icon></button>
              }
            </div>
          }
          @if (editOwn()) {
            <input type="text" class="add" [(ngModel)]="newItem" (keydown.enter)="addItem()" [placeholder]="'checklist.add' | transloco" maxlength="300" data-checklist-add />
          }
        </section>

        @if (!t.parentTaskId) {
          <section>
            <h3>{{ 'task.subtasks' | transloco }}</h3>
            @for (s of subtasks(); track s.id) {
              <div class="item" [attr.data-subtask]="s.title">
                <input type="checkbox" [checked]="!!s.completedAt" [disabled]="!editOwn()" (change)="toggleSub(s.id, $any($event.target).checked)" [attr.aria-label]="s.title" />
                <span class="grow" [class.done]="!!s.completedAt">{{ s.title }}</span>
              </div>
            }
            @if (canCreate()) {
              <input type="text" class="add" [(ngModel)]="newSub" (keydown.enter)="addSub()" [placeholder]="'task.addSubtask' | transloco" maxlength="200" data-subtask-add />
            }
          </section>
        }

        <section>
          <h3>{{ 'task.attachments' | transloco }}</h3>
          <div class="files">
            @for (a of attachments(); track a.id) {
              <figure class="file" [attr.data-attachment]="a.name">
                @if (a.kind === 'image' && urls()[a.mediaId]) {
                  <img [src]="urls()[a.mediaId]" [alt]="a.name" />
                }
                <figcaption>{{ a.name }}</figcaption>
                @if (canEditFiles(a)) {
                  <button type="button" class="x" (click)="removeFile(a)" [attr.aria-label]="'common.delete' | transloco"><mat-icon>close</mat-icon></button>
                }
              </figure>
            } @empty {
              <span class="muted">{{ 'task.noAttachments' | transloco }}</span>
            }
          </div>
          @if (editOwn()) {
            <input #file type="file" accept="image/*,video/*" hidden (change)="upload($any($event.target))" data-attach-input />
            <button mat-stroked-button type="button" [disabled]="!online.isOnline()" (click)="file.click()" data-action="attach"><mat-icon>attach_file</mat-icon>{{ 'task.attach' | transloco }}</button>
          }
        </section>

        <section>
          <h3>{{ 'task.comments' | transloco }}</h3>
          @for (c of comments(); track c.id) {
            <div class="comment" [attr.data-comment]="c.id">
              <div class="meta"><strong>{{ c.authorName || ('chat.deletedUser' | transloco) }}</strong> <span class="muted">{{ lang.date(c.createdAt) }}@if (c.editedAt) { · {{ 'chat.edited' | transloco }} }</span></div>
              @if (editing() === c.id) {
                <textarea class="field" [(ngModel)]="editText" rows="2"></textarea>
                <button mat-button type="button" (click)="saveComment(c)">{{ 'common.save' | transloco }}</button>
                <button mat-button type="button" (click)="editing.set(null)">{{ 'common.cancel' | transloco }}</button>
              } @else {
                <p class="body">
                  @for (p of parts(c); track $index) {
                    @if (p.mention !== undefined) {
                      <span class="mention" data-mention>&#64;{{ p.mention }}</span>
                    } @else {
                      <ng-container>{{ p.text }}</ng-container>
                    }
                  }
                </p>
                <div class="acts">
                  @if (c.authorId === me()) {
                    <button type="button" class="link" (click)="startEdit(c)">{{ 'task.edit' | transloco }}</button>
                  }
                  @if (c.authorId === me() || editAny()) {
                    <button type="button" class="link" (click)="deleteComment(c)">{{ 'common.delete' | transloco }}</button>
                  }
                </div>
              }
            </div>
          }
          @if (canCommentHere()) {
            <div class="compose">
              <textarea
                #box
                class="field"
                rows="2"
                [ngModel]="draft()"
                (ngModelChange)="draft.set($event)"
                (input)="caret.set($any($event.target).selectionStart ?? 0)"
                (click)="caret.set($any($event.target).selectionStart ?? 0)"
                [placeholder]="'task.commentPlaceholder' | transloco"
                maxlength="4000"
                data-comment-input
              ></textarea>
              @if (suggestions().length) {
                <div class="suggest" role="listbox" data-mention-list>
                  @for (m of suggestions(); track m.userId) {
                    <button type="button" role="option" (mousedown)="$event.preventDefault()" (click)="pick(m)" [attr.data-mention-option]="m.displayName">{{ m.displayName }}</button>
                  }
                </div>
              }
              <button mat-flat-button type="button" [disabled]="!draft().trim() || !online.isOnline() || sending()" (click)="send()" data-action="send-comment">{{ 'task.comment' | transloco }}</button>
              @if (!online.isOnline()) {
                <span class="muted">{{ 'task.needsConnection' | transloco }}</span>
              }
            </div>
          }
        </section>

        <section>
          <h3>{{ 'task.activity' | transloco }}</h3>
          <ol class="activity" data-activity>
            @for (a of activity(); track a.id) {
              <li [attr.data-activity-kind]="a.kind">
                <strong>{{ a.actorName || ('chat.deletedUser' | transloco) }}</strong> {{ activityText(a) }}
                <span class="muted">{{ lang.date(a.createdAt) }}</span>
              </li>
            } @empty {
              <li class="muted">{{ 'task.noActivity' | transloco }}</li>
            }
          </ol>
        </section>
      </div>
    } @else {
      <div class="drawer"><p class="muted">{{ 'task.gone' | transloco }}</p><button mat-button type="button" mat-dialog-close>{{ 'common.close' | transloco }}</button></div>
    }
  `,
  styles: `
    :host { display: block; }
    .drawer { padding: 16px 20px 32px; display: flex; flex-direction: column; gap: 4px; }
    .top { display: flex; align-items: center; gap: 4px; position: sticky; top: 0; background: var(--surface-2, var(--surface)); z-index: 2; padding: 4px 0; }
    .title { flex: 1; min-width: 0; font: inherit; font-size: 20px; font-weight: 600; color: inherit; background: transparent; border: 1px solid transparent; border-radius: 8px; padding: 6px 8px; }
    .title:hover:not(:disabled), .title:focus { border-color: var(--border); background: var(--surface); }
    h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-dim); margin: 18px 0 6px; display: flex; gap: 8px; align-items: baseline; }
    .lock { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 13px; }
    .lock mat-icon { font-size: 16px; width: 16px; height: 16px; }
    .fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin-top: 8px; }
    .f { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--text-dim); }
    .f.check { flex-direction: row; align-items: center; gap: 8px; font-size: 14px; color: var(--text); }
    .f select, .f input[type='date'], .f input[type='datetime-local'], .field, .add, .item input[type='text'] { font: inherit; font-size: 14px; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; }
    .field { width: 100%; box-sizing: border-box; resize: vertical; }
    .add { width: 100%; box-sizing: border-box; margin-top: 6px; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .person { display: inline-flex; align-items: center; gap: 6px; padding: 2px 4px 2px 2px; border-radius: 14px; background: var(--surface-3); font-size: 13px; }
    .av { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; background: var(--accent); color: var(--mat-sys-on-primary); font-size: 10px; font-weight: 700; }
    .lab { padding: 2px 10px; border-radius: 12px; font-size: 13px; }
    .x { border: 0; background: none; color: inherit; opacity: 0.7; cursor: pointer; padding: 0; display: grid; place-items: center; border-radius: 50%; }
    .x:hover { opacity: 1; }
    .x mat-icon { font-size: 16px; width: 16px; height: 16px; }
    .tools { display: flex; gap: 2px; margin-bottom: 4px; }
    .tools button { border: 0; background: none; color: var(--text-dim); cursor: pointer; padding: 4px; border-radius: 6px; display: grid; place-items: center; }
    .tools button:hover { background: var(--surface-3); }
    .desc { min-height: 70px; border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; background: var(--surface); }
    .desc.ro { background: transparent; border-color: transparent; padding-left: 0; }
    .desc :where(.ProseMirror) { outline: none; min-height: 56px; }
    .desc :where(p) { margin: 4px 0; }
    .bar { height: 6px; background: var(--surface-3); border-radius: 3px; overflow: hidden; margin-bottom: 6px; }
    .bar span { display: block; height: 100%; background: var(--accent); }
    .item { display: flex; align-items: center; gap: 8px; margin: 3px 0; }
    .item .grow { flex: 1; min-width: 0; }
    .item .done { text-decoration: line-through; color: var(--text-dim); }
    .files { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 6px; }
    .file { position: relative; margin: 0; width: 120px; font-size: 12px; }
    .file img { width: 120px; height: 80px; object-fit: cover; border-radius: 8px; display: block; }
    .file .x { position: absolute; top: 2px; right: 2px; background: var(--surface); }
    .file figcaption { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .comment { padding: 8px 0; border-bottom: 1px solid var(--border); }
    .comment .body { margin: 2px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    .mention { background: color-mix(in srgb, var(--accent) 22%, transparent); border-radius: 4px; padding: 0 3px; }
    .acts { display: flex; gap: 12px; }
    .link { border: 0; background: none; color: var(--text-dim); cursor: pointer; font-size: 12px; padding: 0; }
    .link:hover { color: var(--text); text-decoration: underline; }
    .compose { position: relative; display: flex; flex-direction: column; gap: 6px; margin-top: 8px; align-items: flex-start; }
    .suggest { position: absolute; left: 0; right: 0; bottom: 78px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25); z-index: 5; max-height: 180px; overflow: auto; display: flex; flex-direction: column; }
    .suggest button { text-align: left; border: 0; background: none; color: inherit; padding: 6px 10px; cursor: pointer; font: inherit; }
    .suggest button:hover { background: var(--surface-3); }
    .activity { list-style: none; padding: 0; margin: 0; font-size: 13px; display: flex; flex-direction: column; gap: 4px; }
    .menu-empty { padding: 8px 16px; display: block; }
    .muted { color: var(--text-dim); font-size: 13px; }
  `,
})
export class TaskDrawer {
  private readonly data = inject<TaskDrawerData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<TaskDrawer>);
  protected readonly store = inject(BoardStore);
  protected readonly history = inject(HistoryStore);
  private readonly auth = inject(AuthStore);
  private readonly http = inject(HttpClient);
  private readonly rt = inject(RealtimeService);
  private readonly media = inject(MediaStore);
  private readonly dialogs = inject(Dialogs);
  private readonly notify = inject(Notify);
  protected readonly lang = inject(Language);
  protected readonly online = inject(Online);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly priorities = PRIORITIES;
  protected readonly priorityIcon = PRIORITY_ICON;
  protected chip = chipStyle;
  protected input = toInput;
  protected initialsOf = initials;
  protected readonly desc = viewChild<ElementRef<HTMLElement>>('desc');

  protected readonly task = computed(() => {
    const t = this.store.taskById().get(this.data.taskId);
    return t && !t.deletedAt ? t : undefined;
  });
  protected readonly board = computed(() => {
    const t = this.task();
    return t ? this.store.boardById().get(t.boardId) : undefined;
  });
  protected readonly me = this.store.userId;
  protected readonly columns = computed(() => (this.task() ? this.store.columnsOf(this.task()!.boardId) : []));
  protected readonly members = computed(() => (this.board() ? this.store.membersOf(this.board()!) : []));
  protected readonly subtasks = computed(() =>
    this.store
      .tasks()
      .filter((t) => t.parentTaskId === this.data.taskId && !t.deletedAt)
      .sort(comparePositions),
  );
  protected readonly taskLabels = computed(() => {
    const t = this.task();
    const all = this.availableLabels();
    return t ? all.filter((l) => t.labelIds.includes(l.id)) : [];
  });
  protected readonly availableLabels = computed(() => (this.board() ? this.store.labelsFor(this.board()!.spaceId) : []));

  // ---- what the person may do here
  private perm(bit: bigint): boolean {
    const b = this.board();
    return !!b && !b.archivedAt && this.store.can(b.id, bit);
  }
  protected readonly editAny = computed(() => this.perm(Permission.EDIT_TASKS));
  protected readonly own = computed(() => {
    const t = this.task();
    return !!t && (t.createdBy === this.me() || t.assigneeIds.includes(this.me()));
  });
  protected readonly editOwn = computed(() => this.editAny() || (this.own() && !!this.board() && !this.board()!.archivedAt));
  protected readonly canAssign = computed(() => this.perm(Permission.ASSIGN_TASKS));
  protected readonly canCreate = computed(() => this.perm(Permission.CREATE_TASKS));
  protected readonly canCommentHere = computed(() => this.canCreate());
  protected readonly canDelete = computed(() => this.editAny() || (this.task()?.createdBy === this.me() && !!this.board() && !this.board()!.archivedAt));
  protected readonly readOnly = computed(() => !this.editOwn());

  // ---- what comes from the server on open
  private readonly detail = signal<TaskDetailDto | null>(null);
  protected readonly comments = signal<TaskCommentDto[]>([]);
  protected readonly attachments = signal<TaskAttachmentDto[]>([]);
  protected readonly activity = signal<TaskDetailDto['activity']>([]);
  protected readonly urls = signal<Record<string, string>>({});

  protected newItem = '';
  protected newSub = '';
  protected readonly draft = signal('');
  protected readonly caret = signal(0);
  protected readonly sending = signal(false);
  protected readonly editing = signal<string | null>(null);
  protected editText = '';
  private readonly picked = new Map<string, string>();
  protected readonly suggestions = computed(() => {
    const m = /(?:^|\s)@([^\s@]{0,30})$/.exec(this.draft().slice(0, this.caret()));
    if (!m) return [];
    const q = m[1]!.toLowerCase();
    return this.members()
      .filter((x) => x.userId !== this.me() && x.displayName.toLowerCase().includes(q))
      .slice(0, 6);
  });

  private editor: Editor | null = null;
  private lastSaved = '';

  constructor() {
    void this.loadDetail();
    // Comments written by others arrive live while the panel is open.
    const sub = this.rt.on<TaskCommentDto>('comment.created').subscribe((c) => {
      if (!c || c.taskId !== this.data.taskId || !('content' in c)) return;
      this.comments.update((list) => (list.some((x) => x.id === c.id) ? list.map((x) => (x.id === c.id ? c : x)) : [...list, c]));
      void this.refreshActivity();
    });
    this.destroyRef.onDestroy(() => {
      sub.unsubscribe();
      void this.flushDescription();
      this.editor?.destroy();
    });
    // Anything that changes the task (here, another tab, the board's room) refreshes the history.
    effect(() => {
      this.task()?.seq;
      untracked(() => void this.refreshActivity());
    });
    effect(() => {
      const el = this.desc()?.nativeElement;
      const t = this.task();
      if (!el || !t) return;
      untracked(() => this.mountEditor(el, t));
    });
  }

  private async loadDetail(): Promise<void> {
    if (!this.online.isOnline()) return;
    try {
      const d = await this.store.taskDetail(this.data.taskId);
      this.detail.set(d);
      this.comments.set(d.comments);
      this.attachments.set(d.attachments);
      this.activity.set(d.activity);
      void this.loadUrls(d.attachments);
    } catch {
      /* offline or no longer visible: the cached task is shown */
    }
  }

  private refreshing = false;
  private async refreshActivity(): Promise<void> {
    if (this.refreshing || !this.online.isOnline() || !this.detail()) return;
    this.refreshing = true;
    try {
      const d = await this.store.taskDetail(this.data.taskId);
      this.activity.set(d.activity);
      this.attachments.set(d.attachments);
      void this.loadUrls(d.attachments);
    } catch {
      /* the next change tries again */
    } finally {
      this.refreshing = false;
    }
  }

  private async loadUrls(list: TaskAttachmentDto[]): Promise<void> {
    for (const a of list) {
      if (a.kind !== 'image' || this.urls()[a.mediaId]) continue;
      const url = await this.media.urlFor(a.mediaId, 'image');
      if (url) this.urls.update((u) => ({ ...u, [a.mediaId]: url }));
    }
  }

  // ------------------------------------------------------------------ fields

  protected async patch(change: Parameters<BoardStore['updateTask']>[1]): Promise<void> {
    try {
      await this.store.updateTask(this.data.taskId, change);
    } catch (e) {
      this.notify.error(failKey(e));
    }
  }

  protected setTitle(value: string): void {
    const title = value.trim();
    if (title && title !== this.task()?.title) void this.patch({ title });
  }

  protected async setColumn(columnId: string): Promise<void> {
    const t = this.task();
    if (!t || columnId === t.columnId) return;
    try {
      await this.store.moveTask(t.id, columnId, this.store.positionAt(t.boardId, columnId, Number.MAX_SAFE_INTEGER, null, t.id));
    } catch (e) {
      this.notify.error(failKey(e));
    }
  }

  protected setDate(which: 'startAt' | 'dueAt', value: string): void {
    const t = this.task();
    if (!t) return;
    void this.patch({ [which]: fromInput(value, t.allDay) });
  }

  protected name(userId: string): string {
    return this.store.nameOf(this.board(), userId) || '?';
  }

  protected assign(userId: string): void {
    const t = this.task();
    if (t && !t.assigneeIds.includes(userId)) void this.patch({ assigneeIds: [...t.assigneeIds, userId] });
  }
  protected unassign(userId: string): void {
    const t = this.task();
    if (t) void this.patch({ assigneeIds: t.assigneeIds.filter((u) => u !== userId) });
  }
  protected toggleAssignee(userId: string): void {
    if (this.task()?.assigneeIds.includes(userId)) this.unassign(userId);
    else this.assign(userId);
  }
  protected toggleLabel(id: string): void {
    const t = this.task();
    if (t) void this.patch({ labelIds: t.labelIds.includes(id) ? t.labelIds.filter((l) => l !== id) : [...t.labelIds, id] });
  }

  // ------------------------------------------------------------------ description

  private mountEditor(el: HTMLElement, t: TaskDto): void {
    if (this.editor) {
      // somebody else changed it and this person is not typing: show the new text
      const incoming = JSON.stringify(t.description ?? null);
      if (incoming !== this.lastSaved && !this.editor.isFocused) {
        this.editor.commands.setContent((t.description as never) ?? '', { emitUpdate: false });
        this.lastSaved = incoming;
      }
      this.editor.setEditable(this.editOwn());
      return;
    }
    this.lastSaved = JSON.stringify(t.description ?? null);
    this.editor = new Editor({
      element: el,
      editable: this.editOwn(),
      content: (t.description as never) ?? '',
      extensions: [
        // only what a task description may hold (see validateTaskDescription)
        StarterKit.configure({ heading: false, blockquote: false, codeBlock: false, horizontalRule: false, underline: false, link: { openOnClick: false, autolink: true } }),
      ],
      editorProps: { attributes: { 'aria-label': this.lang.t('task.description'), role: 'textbox', 'aria-multiline': 'true' } },
      onBlur: () => void this.flushDescription(),
    });
  }

  protected cmd(name: 'bold' | 'italic' | 'bulletList' | 'orderedList'): void {
    const chain = this.editor?.chain().focus();
    if (!chain) return;
    if (name === 'bold') chain.toggleBold().run();
    else if (name === 'italic') chain.toggleItalic().run();
    else if (name === 'bulletList') chain.toggleBulletList().run();
    else chain.toggleOrderedList().run();
  }

  protected async link(): Promise<void> {
    if (!this.editor) return;
    const answer = await this.dialogs.prompt({ titleKey: 'task.link', labelKey: 'task.linkUrl', value: this.editor.getAttributes('link')['href'] ?? 'https://', secondaryKey: 'task.removeLink', confirmKey: 'common.ok' });
    if (!answer) return;
    if (answer.action === 'secondary') this.editor.chain().focus().extendMarkRange('link').unsetLink().run();
    else if (answer.value.trim()) this.editor.chain().focus().extendMarkRange('link').setLink({ href: answer.value.trim() }).run();
    void this.flushDescription();
  }

  private async flushDescription(): Promise<void> {
    if (!this.editor || !this.editOwn()) return;
    const json = this.editor.getJSON();
    const empty = !this.editor.getText().trim() && !(json.content ?? []).some((n) => n.type === 'bulletList' || n.type === 'orderedList');
    const doc = (empty ? null : json) as TaskDocDto | null;
    const text = JSON.stringify(doc);
    if (text === this.lastSaved) return;
    const check = validateTaskDescription(doc);
    if (!check.ok) return void this.notify.error('task.descriptionInvalid');
    this.lastSaved = text;
    await this.patch({ description: check.doc });
  }

  // ------------------------------------------------------------------ checklist and subtasks

  protected doneCount(t: TaskDto): number {
    return t.checklist.filter((c) => c.done).length;
  }
  private list(): TaskDto['checklist'] {
    return [...(this.task()?.checklist ?? [])];
  }
  protected addItem(): void {
    const text = this.newItem.trim();
    if (!text) return;
    const list = this.list();
    this.newItem = '';
    void this.patch({ checklist: [...list, { id: uuidv7(), text, done: false, position: positionBetween(list.at(-1)?.position ?? null, null) }] });
  }
  protected toggleItem(id: string, done: boolean): void {
    void this.patch({ checklist: this.list().map((c) => (c.id === id ? { ...c, done } : c)) });
  }
  protected editItem(id: string, text: string): void {
    if (text.trim()) void this.patch({ checklist: this.list().map((c) => (c.id === id ? { ...c, text: text.trim() } : c)) });
  }
  protected removeItem(id: string): void {
    void this.patch({ checklist: this.list().filter((c) => c.id !== id) });
  }

  protected async addSub(): Promise<void> {
    const title = this.newSub.trim();
    const t = this.task();
    const b = this.board();
    if (!title || !t || !b) return;
    this.newSub = '';
    try {
      await this.store.createTask(b, t.columnId, title, { parentTaskId: t.id });
    } catch (e) {
      this.notify.error(failKey(e));
    }
  }
  protected toggleSub(id: string, completed: boolean): void {
    void this.store.updateTask(id, { completed });
  }

  // ------------------------------------------------------------------ files

  protected canEditFiles(a: TaskAttachmentDto): boolean {
    return this.editAny() || (this.editOwn() && !!a);
  }

  protected async upload(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const form = new FormData();
    form.append('id', uuidv7());
    form.append('name', file.name);
    form.append('file', file, file.name);
    try {
      const a = await firstValueFrom(this.http.post<TaskAttachmentDto>(`/api/tasks/${this.data.taskId}/attachments`, form));
      this.attachments.update((l) => [...l, a]);
      void this.loadUrls([a]);
    } catch (e) {
      const p = toProblem(e);
      this.notify.error(p.code === 'quota_exceeded' ? 'quota.full' : errKey(p.code));
    }
  }

  protected async removeFile(a: TaskAttachmentDto): Promise<void> {
    try {
      await firstValueFrom(this.http.delete(`/api/tasks/${this.data.taskId}/attachments/${a.id}`));
      this.attachments.update((l) => l.filter((x) => x.id !== a.id));
    } catch (e) {
      this.notify.error(errKey(toProblem(e).code));
    }
  }

  // ------------------------------------------------------------------ comments

  protected parts(c: TaskCommentDto) {
    return commentParts(c.content, (id) => this.store.nameOf(this.board(), id));
  }

  protected pick(m: { userId: string; displayName: string }): void {
    const before = this.draft().slice(0, this.caret());
    const after = this.draft().slice(this.caret());
    const start = before.lastIndexOf('@');
    const next = `${before.slice(0, start)}@${m.displayName} ${after}`;
    this.picked.set(m.displayName, m.userId);
    this.draft.set(next);
    this.caret.set(start + m.displayName.length + 2);
  }

  /** The text with each `@Name` the person picked turned into the mention token the server reads. */
  private tokens(text: string): string {
    let out = text;
    for (const [name, id] of [...this.picked].sort((a, b) => b[0].length - a[0].length)) out = out.split(`@${name}`).join(`<@user:${id}>`);
    return out;
  }

  protected async send(): Promise<void> {
    const content = this.tokens(this.draft()).trim();
    if (!content) return;
    this.sending.set(true);
    try {
      const c = await firstValueFrom(this.http.post<TaskCommentDto>(`/api/tasks/${this.data.taskId}/comments`, { id: uuidv7(), content }));
      this.comments.update((l) => (l.some((x) => x.id === c.id) ? l : [...l, c]));
      this.draft.set('');
      this.picked.clear();
      void this.refreshActivity();
    } catch (e) {
      this.notify.error(errKey(toProblem(e).code));
    } finally {
      this.sending.set(false);
    }
  }

  protected startEdit(c: TaskCommentDto): void {
    this.editing.set(c.id);
    this.editText = c.content.replace(/<@user:([0-9a-f-]{36})>/gi, (_m, id: string) => `@${this.store.nameOf(this.board(), id.toLowerCase())}`);
    for (const m of this.members()) this.picked.set(m.displayName, m.userId);
  }

  protected async saveComment(c: TaskCommentDto): Promise<void> {
    try {
      const updated = await firstValueFrom(this.http.patch<TaskCommentDto>(`/api/comments/${c.id}`, { content: this.tokens(this.editText).trim() }));
      this.comments.update((l) => l.map((x) => (x.id === c.id ? updated : x)));
      this.editing.set(null);
    } catch (e) {
      this.notify.error(errKey(toProblem(e).code));
    }
  }

  protected async deleteComment(c: TaskCommentDto): Promise<void> {
    if (!(await this.dialogs.confirm({ titleKey: 'task.deleteComment', messageKey: 'task.deleteCommentMessage', confirmKey: 'common.delete', danger: true }))) return;
    try {
      await firstValueFrom(this.http.delete(`/api/comments/${c.id}`));
      this.comments.update((l) => l.filter((x) => x.id !== c.id));
    } catch (e) {
      this.notify.error(errKey(toProblem(e).code));
    }
  }

  // ------------------------------------------------------------------ history

  protected activityText(a: TaskDetailDto['activity'][number]): string {
    const d = a.data as Record<string, string | boolean | null | undefined>;
    const dates = a.kind === 'dates' ? { due: d['dueAt'] ? formatDue(String(d['dueAt']), !!d['allDay'], this.lang.current) : '—', start: d['startAt'] ? formatDue(String(d['startAt']), !!d['allDay'], this.lang.current) : '—' } : {};
    const priority = a.kind === 'priority' ? { from: this.lang.t(`task.priority.${d['from']}`), to: this.lang.t(`task.priority.${d['to']}`) } : {};
    return this.lang.t(`activity.${a.kind}`, { ...d, ...dates, ...priority });
  }

  // ------------------------------------------------------------------ the rest

  protected async copyLink(): Promise<void> {
    const t = this.task();
    if (!t) return;
    const url = `${location.origin}/app/b/${t.boardId}?task=${t.id}`;
    try {
      await navigator.clipboard.writeText(url);
      this.notify.info('task.linkCopied');
    } catch {
      await this.dialogs.prompt({ titleKey: 'task.copyLink', labelKey: 'task.linkUrl', value: url });
    }
  }

  protected async duplicate(): Promise<void> {
    const t = this.task();
    const b = this.board();
    if (!t || !b) return;
    try {
      await this.store.createTask(b, t.columnId, `${t.title} ${this.lang.t('task.copySuffix')}`.slice(0, 200), {
        description: t.description,
        priority: t.priority,
        startAt: t.startAt,
        dueAt: t.dueAt,
        allDay: t.allDay,
        labelIds: t.labelIds,
        checklist: t.checklist.map((c) => ({ ...c, id: uuidv7(), done: false })),
      });
      this.notify.info('task.duplicated');
    } catch (e) {
      this.notify.error(failKey(e));
    }
  }

  protected async remove(): Promise<void> {
    const t = this.task();
    if (!t) return;
    if (!(await this.dialogs.confirm({ titleKey: 'task.deleteTitle', messageKey: 'task.deleteMessage', params: { title: t.title }, confirmKey: 'common.delete', danger: true }))) return;
    await this.store.deleteTask(t.id);
    this.ref.close();
  }
}
