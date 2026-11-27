import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { Permission, positionBetween } from '@os-planner/shared/lite';
import type { ColumnDto, ColumnKind, TaskDto } from '@os-planner/shared';
import { LABEL_COLORS } from '@os-planner/shared/boards';
import { toProblem } from '../../core/auth-store';
import { Language } from '../../core/i18n';
import { Notify } from '../../core/notify';
import { BoardStore } from '../../data/board-store';
import { Dialogs } from '../../shared/dialogs';
import { chipStyle, errKey } from './board-util';

const KINDS: readonly ColumnKind[] = ['todo', 'doing', 'done', 'custom'];

const DIALOG_STYLES = `
  .row { display: flex; align-items: center; gap: 8px; margin: 6px 0; flex-wrap: wrap; }
  .row input[type='text'], .row input[type='number'], .row select, textarea, .field { font: inherit; color: inherit; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; }
  .row input.grow, .grow { flex: 1; min-width: 120px; }
  .row input[type='number'] { width: 70px; }
  .swatches { display: flex; gap: 6px; flex-wrap: wrap; }
  .swatch { width: 24px; height: 24px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; }
  .swatch.on { border-color: var(--text); }
  h3 { margin: 18px 0 6px; font-size: 14px; }
  .muted { color: var(--text-dim); font-size: 13px; }
  .chip { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 13px; }
  .err { color: var(--mat-sys-error); }
  textarea { width: 100%; box-sizing: border-box; min-height: 56px; }
  button.icon { background: none; border: 0; color: var(--text-dim); cursor: pointer; padding: 4px; border-radius: 6px; display: grid; place-items: center; }
  button.icon:hover { background: var(--surface-3); }
`;

// ---------------------------------------------------------------- board settings

/** A board's name and description, and its columns: names, limits, what a column means, order, adding and removing. */
@Component({
  selector: 'app-board-settings',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatIconModule, TranslocoPipe],
  template: `
    <h2 mat-dialog-title>{{ 'board.settings' | transloco }}</h2>
    <mat-dialog-content>
      @if (board(); as b) {
        <div class="row">
          <input type="text" class="grow" [ngModel]="b.name" (change)="rename($any($event.target).value)" [attr.aria-label]="'board.name' | transloco" maxlength="80" data-board-name />
        </div>
        <div class="row">
          <textarea [ngModel]="b.description" (change)="describe($any($event.target).value)" [attr.aria-label]="'board.description' | transloco" [placeholder]="'board.description' | transloco" maxlength="2000"></textarea>
        </div>
        <h3>{{ 'column.title' | transloco }}</h3>
        @for (c of columns(); track c.id; let i = $index) {
          <div class="row" [attr.data-column-setting]="c.name">
            <button type="button" class="icon" [disabled]="i === 0" (click)="move(c, i, -1)" [attr.aria-label]="'column.moveUp' | transloco"><mat-icon>arrow_upward</mat-icon></button>
            <button type="button" class="icon" [disabled]="i === columns().length - 1" (click)="move(c, i, 1)" [attr.aria-label]="'column.moveDown' | transloco"><mat-icon>arrow_downward</mat-icon></button>
            <input type="text" class="grow" [ngModel]="c.name" (change)="patch(c, { name: $any($event.target).value })" maxlength="80" [attr.aria-label]="'column.name' | transloco" data-column-name />
            <select [ngModel]="c.kind" (change)="patch(c, { kind: $any($event.target).value })" [attr.aria-label]="'column.kindLabel' | transloco">
              @for (k of kinds; track k) {
                <option [value]="k">{{ 'column.kind.' + k | transloco }}</option>
              }
            </select>
            <input type="number" min="1" max="999" [ngModel]="c.wipLimit" (change)="limit(c, $any($event.target).value)" [placeholder]="'column.noLimit' | transloco" [attr.aria-label]="'column.wipLimit' | transloco" data-column-wip />
            <button type="button" class="icon" (click)="remove(c)" [attr.aria-label]="'common.delete' | transloco" data-action="delete-column"><mat-icon>delete</mat-icon></button>
          </div>
        }
        <div class="row">
          <input type="text" class="grow" [(ngModel)]="newName" [placeholder]="'column.newPlaceholder' | transloco" maxlength="80" (keydown.enter)="add()" data-new-column-name />
          <button mat-stroked-button type="button" (click)="add()" data-action="add-column"><mat-icon>add</mat-icon>{{ 'column.add' | transloco }}</button>
        </div>
        @if (error()) {
          <p class="err" role="alert">{{ error() }}</p>
        }
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" mat-dialog-close>{{ 'common.close' | transloco }}</button>
    </mat-dialog-actions>
  `,
  styles: DIALOG_STYLES,
})
export class BoardSettingsDialog {
  private readonly data = inject<{ boardId: string }>(MAT_DIALOG_DATA);
  private readonly store = inject(BoardStore);
  private readonly dialogs = inject(Dialogs);
  private readonly lang = inject(Language);
  private readonly notify = inject(Notify);

  protected readonly kinds = KINDS;
  protected readonly newName = signal('');
  protected readonly error = signal('');
  protected readonly board = computed(() => this.store.boardById().get(this.data.boardId));
  protected readonly columns = computed(() => this.store.columnsOf(this.data.boardId));

  private async run(fn: () => Promise<unknown>): Promise<void> {
    this.error.set('');
    try {
      await fn();
    } catch (e) {
      this.error.set(this.lang.t(errKey(toProblem(e).code)));
    }
  }

  protected rename(name: string): Promise<void> {
    return name.trim() ? this.run(() => this.store.updateBoard(this.data.boardId, { name: name.trim() })) : Promise.resolve();
  }
  protected describe(description: string): Promise<void> {
    return this.run(() => this.store.updateBoard(this.data.boardId, { description }));
  }
  protected patch(c: ColumnDto, change: { name?: string; kind?: ColumnKind }): Promise<void> {
    if (change.name !== undefined && !change.name.trim()) return Promise.resolve();
    return this.run(() => this.store.updateColumn(c.id, change.name !== undefined ? { name: change.name.trim() } : change));
  }
  protected limit(c: ColumnDto, value: string): Promise<void> {
    const n = Number(value);
    return this.run(() => this.store.updateColumn(c.id, { wipLimit: value.trim() === '' || !(n >= 1) ? null : Math.min(999, Math.floor(n)) }));
  }
  protected async move(c: ColumnDto, index: number, by: -1 | 1): Promise<void> {
    const list = this.columns();
    // between the two columns on the far side of the one it swaps with
    const before = by < 0 ? (list[index - 2]?.position ?? null) : (list[index + 1]?.position ?? null);
    const after = by < 0 ? list[index - 1]!.position : (list[index + 2]?.position ?? null);
    const position = by < 0 ? positionBetween(before, after) : positionBetween(before, after);
    await this.run(() => this.store.updateColumn(c.id, { position }));
  }
  protected async add(): Promise<void> {
    const name = this.newName().trim();
    if (!name) return;
    await this.run(() => this.store.createColumn(this.data.boardId, { name }));
    this.newName.set('');
  }
  protected async remove(c: ColumnDto): Promise<void> {
    const others = this.columns().filter((x) => x.id !== c.id);
    if (!others.length) return void this.error.set(this.lang.t('board.err.last_column'));
    const has = this.store.tasks().some((t) => t.columnId === c.id && !t.deletedAt);
    let moveTo: string | undefined;
    if (has) {
      const answer = await this.dialogs.prompt({
        titleKey: 'column.deleteTitle',
        labelKey: 'column.moveTasksTo',
        value: others[0]!.name,
        validate: (v) => (others.some((o) => o.name === v.trim()) ? null : 'column.moveToUnknown'),
        confirmKey: 'common.delete',
      });
      if (answer?.action !== 'ok') return;
      moveTo = others.find((o) => o.name === answer.value.trim())?.id;
    } else if (!(await this.dialogs.confirm({ titleKey: 'column.deleteTitle', messageKey: 'column.deleteMessage', params: { name: c.name }, confirmKey: 'common.delete', danger: true }))) return;
    await this.run(() => this.store.deleteColumn(c.id, moveTo ? { moveTo } : {}));
    if (!this.error()) this.notify.info('column.deleted', { name: c.name });
  }
}

// ---------------------------------------------------------------- labels

/** The labels a board can use: the ones of its space (changed here by whoever manages labels) and the ones it inherits. */
@Component({
  selector: 'app-labels-dialog',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatIconModule, TranslocoPipe],
  template: `
    <h2 mat-dialog-title>{{ 'label.title' | transloco }}</h2>
    <mat-dialog-content>
      @for (l of labels(); track l.id) {
        <div class="row" [attr.data-label-row]="l.name">
          <span class="chip" [style]="chip(l.color)">{{ l.name }}</span>
          @if (l.spaceId !== data.spaceId) {
            <span class="muted">{{ 'label.inherited' | transloco }}</span>
          } @else if (canManage()) {
            <input type="text" class="grow" [ngModel]="l.name" (change)="rename(l.id, $any($event.target).value)" maxlength="40" [attr.aria-label]="'label.name' | transloco" />
            <span class="swatches">
              @for (c of colors; track c) {
                <button type="button" class="swatch" [class.on]="c === l.color" [style.background]="c" (click)="recolor(l.id, c)" [attr.aria-label]="c"></button>
              }
            </span>
            @if (!personal()) {
              <label class="muted"><input type="checkbox" [ngModel]="l.inheritable" (change)="inherit(l.id, $any($event.target).checked)" /> {{ 'label.inheritable' | transloco }}</label>
            }
            <button type="button" class="icon" (click)="remove(l.id, l.name)" [attr.aria-label]="'common.delete' | transloco" data-action="delete-label"><mat-icon>delete</mat-icon></button>
          }
        </div>
      } @empty {
        <p class="muted">{{ 'label.none' | transloco }}</p>
      }
      @if (canManage()) {
        <h3>{{ 'label.new' | transloco }}</h3>
        <div class="row">
          <input type="text" class="grow" [(ngModel)]="name" [placeholder]="'label.name' | transloco" maxlength="40" (keydown.enter)="create()" data-new-label-name />
          <span class="swatches">
            @for (c of colors; track c) {
              <button type="button" class="swatch" [class.on]="c === color()" [style.background]="c" (click)="color.set(c)" [attr.aria-label]="c"></button>
            }
          </span>
          @if (!personal()) {
            <label class="muted"><input type="checkbox" [(ngModel)]="inheritable" /> {{ 'label.inheritable' | transloco }}</label>
          }
          <button mat-stroked-button type="button" (click)="create()" data-action="add-label"><mat-icon>add</mat-icon>{{ 'label.add' | transloco }}</button>
        </div>
      }
      @if (error()) {
        <p class="err" role="alert">{{ error() }}</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" mat-dialog-close>{{ 'common.close' | transloco }}</button>
    </mat-dialog-actions>
  `,
  styles: DIALOG_STYLES,
})
export class LabelsDialog {
  protected readonly data = inject<{ spaceId: string }>(MAT_DIALOG_DATA);
  private readonly store = inject(BoardStore);
  private readonly dialogs = inject(Dialogs);
  private readonly lang = inject(Language);

  protected readonly colors = LABEL_COLORS;
  protected readonly name = signal('');
  protected readonly color = signal<string>(LABEL_COLORS[5]);
  protected inheritable = true;
  protected readonly error = signal('');
  protected readonly labels = computed(() => this.store.labelsFor(this.data.spaceId));
  protected readonly canManage = computed(() => this.store.canIn(this.data.spaceId, Permission.MANAGE_LABELS));
  protected readonly personal = computed(() => this.store.isPersonalSpace(this.data.spaceId));
  protected chip = chipStyle;

  private async run(fn: () => Promise<unknown>): Promise<void> {
    this.error.set('');
    try {
      await fn();
    } catch (e) {
      this.error.set(this.lang.t(errKey(toProblem(e).code)));
    }
  }

  protected async create(): Promise<void> {
    const name = this.name().trim();
    if (!name) return;
    await this.run(() => this.store.createLabel(this.data.spaceId, { name, color: this.color(), inheritable: this.inheritable }));
    if (!this.error()) this.name.set('');
  }
  protected rename(id: string, name: string): Promise<void> {
    return name.trim() ? this.run(() => this.store.updateLabel(id, { name: name.trim() })) : Promise.resolve();
  }
  protected recolor(id: string, color: string): Promise<void> {
    return this.run(() => this.store.updateLabel(id, { color }));
  }
  protected inherit(id: string, inheritable: boolean): Promise<void> {
    return this.run(() => this.store.updateLabel(id, { inheritable }));
  }
  protected async remove(id: string, name: string): Promise<void> {
    if (!(await this.dialogs.confirm({ titleKey: 'label.deleteTitle', messageKey: 'label.deleteMessage', params: { name }, confirmKey: 'common.delete', danger: true }))) return;
    await this.run(() => this.store.deleteLabel(id));
  }
}

// ---------------------------------------------------------------- trash

/** Tasks that were deleted from the board: bring one back, or delete it for good (which gives its storage back). */
@Component({
  selector: 'app-board-trash',
  imports: [MatDialogModule, MatButtonModule, MatIconModule, TranslocoPipe],
  template: `
    <h2 mat-dialog-title>{{ 'board.trash' | transloco }}</h2>
    <mat-dialog-content>
      @if (loading()) {
        <p class="muted">{{ 'common.loading' | transloco }}</p>
      }
      @for (t of items(); track t.id) {
        <div class="row" [attr.data-trash-row]="t.title">
          <span class="grow">{{ t.title }}</span>
          <span class="muted">{{ t.deletedAt ? lang.date(t.deletedAt) : '' }}</span>
          <button mat-button type="button" (click)="restore(t)" data-action="restore-task">{{ 'board.restore' | transloco }}</button>
          <button mat-button type="button" (click)="purge(t)" data-action="purge-task">{{ 'board.deleteForever' | transloco }}</button>
        </div>
      } @empty {
        @if (!loading()) {
          <p class="muted">{{ error() || ('board.trashEmpty' | transloco) }}</p>
        }
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" mat-dialog-close>{{ 'common.close' | transloco }}</button>
    </mat-dialog-actions>
  `,
  styles: DIALOG_STYLES,
})
export class BoardTrashDialog {
  private readonly data = inject<{ boardId: string }>(MAT_DIALOG_DATA);
  private readonly store = inject(BoardStore);
  private readonly dialogs = inject(Dialogs);
  protected readonly lang = inject(Language);

  protected readonly items = signal<TaskDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');

  constructor() {
    this.store.trash(this.data.boardId).then(
      (rows) => {
        this.items.set(rows);
        this.loading.set(false);
      },
      (e) => {
        this.error.set(this.lang.t(errKey(toProblem(e).code)));
        this.loading.set(false);
      },
    );
  }

  protected async restore(t: TaskDto): Promise<void> {
    await this.store.restoreTask(t.id);
    this.items.update((l) => l.filter((x) => x.id !== t.id));
  }

  protected async purge(t: TaskDto): Promise<void> {
    if (!(await this.dialogs.confirm({ titleKey: 'board.deleteForever', messageKey: 'board.deleteForeverMessage', params: { title: t.title }, confirmKey: 'common.delete', danger: true }))) return;
    try {
      await this.store.purgeTask(t.id);
      this.items.update((l) => l.filter((x) => x.id !== t.id));
    } catch (e) {
      this.error.set(this.lang.t(errKey(toProblem(e).code)));
    }
  }
}
