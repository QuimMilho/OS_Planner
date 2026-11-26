import { Component, ElementRef, Injectable, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { TranslocoPipe } from '@jsverse/transloco';
import { filter, map, startWith } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Permission, type ExportScope } from '@os-planner/shared';
import { Language } from '../../core/i18n';
import { Notify } from '../../core/notify';
import { AccessStore } from '../../data/access-store';
import { Sync } from '../../data/sync';
import { byPosition, TreeStore, type CategoryNode, type NotebookNode } from '../../data/tree-store';
import { ExportDialog } from '../export/export-dialog';
import { NotebookAccessDialog } from '../share/notebook-access-dialog';
import { ShareDialog } from '../share/share-dialog';
import { MoveDialog } from './move-dialog';
import { NotebookMoveDialog } from './notebook-move-dialog';

type Kind = 'notebook' | 'category' | 'page';
const COLLAPSED_KEY = 'os_planner.collapsed';

/** Which row is being renamed, which branches are collapsed, and what the tree can do. Shared by every row. */
@Injectable({ providedIn: 'root' })
export class TreeUi {
  readonly store = inject(TreeStore);
  private readonly router = inject(Router);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);
  private readonly lang = inject(Language);
  private readonly http = inject(HttpClient);
  private readonly sync = inject(Sync);
  readonly access = inject(AccessStore);
  readonly P = Permission;

  /** Whether the person may do something in a notebook (the server decides again). */
  can(notebookId: string, permission: bigint): boolean {
    return this.access.can(notebookId, permission);
  }

  readonly renaming = signal<string | null>(null);
  readonly collapsed = signal<Set<string>>(this.loadCollapsed());
  private readonly url = toSignal(this.router.events.pipe(filter((e) => e instanceof NavigationEnd), map(() => this.router.url), startWith(this.router.url)), { initialValue: '' });
  readonly selectedPage = computed(() => /\/app\/p\/([0-9a-f-]{36})/.exec(this.url())?.[1] ?? null);

  private loadCollapsed(): Set<string> {
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

  open(id: string): void {
    if (this.collapsed().has(id)) this.toggle(id);
  }

  // ---- creating
  async newNotebook(spaceId?: string): Promise<void> {
    const nb = await this.store.createNotebook(this.lang.t('tree.newNotebook'), spaceId);
    this.renaming.set(nb.id);
  }

  // ---- sharing, moving between spaces, who may see it
  share(notebookId: string, name: string): void {
    this.dialog.open(ShareDialog, { data: { notebookId, name }, width: '560px', maxWidth: '96vw' });
  }
  async moveNotebook(notebookId: string): Promise<void> {
    const ref = this.dialog.open(NotebookMoveDialog, { data: { notebookId }, width: '460px', maxWidth: '96vw' });
    const moved = await new Promise<boolean>((res) => ref.afterClosed().subscribe((v) => res(!!v)));
    if (moved) await this.sync.run();
  }
  notebookAccess(notebookId: string, name: string): void {
    this.dialog.open(NotebookAccessDialog, { data: { notebookId, name }, width: '920px', maxWidth: '96vw' });
  }
  /** The person stops having a notebook somebody shared with them. */
  async leave(notebookId: string): Promise<void> {
    await firstValueFrom(this.http.delete(`/api/shared-with-me/${notebookId}`));
    await this.sync.run();
    const open = this.selectedPage();
    if (open && !this.store.pageById().get(open)) await this.router.navigate(['/app']);
  }
  async newCategory(notebookId: string, parentId: string | null): Promise<void> {
    const c = await this.store.createCategory(notebookId, parentId, this.lang.t('tree.newCategory'));
    this.open(notebookId);
    if (parentId) this.open(parentId);
    this.renaming.set(c.id);
  }
  async newPage(categoryId: string): Promise<void> {
    const p = await this.store.createPage(categoryId);
    this.open(categoryId);
    await this.router.navigate(['/app/p', p.id], { queryParams: { focus: 'title' } });
  }

  // ---- renaming
  async commitRename(kind: Kind, id: string, value: string): Promise<void> {
    if (this.renaming() !== id) return;
    this.renaming.set(null);
    const name = value.trim();
    if (kind === 'page') return void (await this.store.renamePage(id, name));
    if (!name) return;
    if (kind === 'notebook') await this.store.updateNotebook(id, { name });
    else await this.store.updateCategory(id, { name });
  }

  // ---- ordering and moving
  async move(kind: Kind, item: { id: string; position: string }, siblings: { id: string; position: string }[], by: -1 | 1): Promise<void> {
    const sorted = [...siblings].sort(byPosition);
    const i = sorted.findIndex((s) => s.id === item.id);
    const other = sorted[i + by];
    if (other) await this.store.swapPositions(kind, item, other);
  }

  async moveTo(kind: 'page' | 'category', id: string): Promise<void> {
    const ref = this.dialog.open(MoveDialog, { data: { kind, id }, width: '420px' });
    const target = (await new Promise<{ categoryId: string | null; notebookId: string } | undefined>((res) => ref.afterClosed().subscribe(res))) ?? null;
    if (!target) return;
    if (kind === 'page') {
      if (target.categoryId) await this.store.movePage(id, target.categoryId);
    } else {
      await this.store.updateCategory(id, { parentId: target.categoryId });
    }
  }

  export(scope: ExportScope, id: string, name: string): void {
    this.dialog.open(ExportDialog, { data: { scope, id, name }, width: '440px' });
  }

  // ---- deleting (always undoable)
  async remove(kind: Kind, id: string, name: string): Promise<void> {
    const redo = () => (kind === 'notebook' ? this.store.restoreNotebook(id) : kind === 'category' ? this.store.restoreCategory(id) : this.store.restorePage(id));
    if (kind === 'notebook') await this.store.deleteNotebook(id);
    else if (kind === 'category') await this.store.deleteCategory(id);
    else await this.store.deletePage(id);
    if (kind === 'page' && this.selectedPage() === id) await this.router.navigate(['/app']);
    this.notify.info('tree.deleted', { name: name || this.lang.t('page.untitled') }, { key: 'common.undo', run: () => void redo() });
  }
}

/** A name that turns into a text box while being renamed. */
@Component({
  selector: 'app-inline-name',
  template: `
    @if (ui.renaming() === id()) {
      <input class="edit" #box [value]="value()" (keydown.enter)="box.blur()" (keydown.escape)="cancel()" (blur)="ui.commitRename(kind(), id(), box.value)" (click)="$event.stopPropagation()" maxlength="120" />
    } @else {
      <span class="label" [class.untitled]="!value()">{{ value() || placeholder() }}</span>
    }
  `,
  styles: `
    :host { display: contents; } .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .untitled { font-style: italic; opacity: 0.7; }
    .edit { flex: 1; min-width: 0; font: inherit; padding: 1px 4px; border: 1px solid var(--accent); border-radius: 4px; background: var(--surface); color: var(--text); outline: none; }
  `,
})
export class InlineName {
  readonly ui = inject(TreeUi);
  readonly kind = input.required<Kind>();
  readonly id = input.required<string>();
  readonly value = input.required<string>();
  readonly placeholder = input('');
  private readonly box = viewChild<ElementRef<HTMLInputElement>>('box');

  constructor() {
    // Focus and select the text as soon as the input appears, so typing replaces the default name.
    effect(() => {
      const el = this.box()?.nativeElement;
      if (el) queueMicrotask(() => (el.focus(), el.select()));
    });
  }

  cancel(): void {
    this.ui.renaming.set(null);
  }
}

// ---------------------------------------------------------------------------------------------

@Component({
  selector: 'app-tree-category',
  imports: [MatIconModule, MatButtonModule, MatMenuModule, TranslocoPipe, InlineName, TreeCategory],
  template: `
    @let c = node().category;
    <div class="row" [style.padding-left.px]="8 + depth() * 14" (contextmenu)="$event.preventDefault(); trigger.openMenu()">
      <button class="twisty" type="button" (click)="ui.toggle(c.id)" [attr.aria-label]="'tree.toggle' | transloco" [attr.aria-expanded]="ui.isOpen(c.id)">
        <mat-icon>{{ ui.isOpen(c.id) ? 'expand_more' : 'chevron_right' }}</mat-icon>
      </button>
      <mat-icon class="ic">{{ ui.isOpen(c.id) ? 'folder_open' : 'folder' }}</mat-icon>
      <app-inline-name kind="category" [id]="c.id" [value]="c.name" />
      <span class="actions">
        @if (ui.can(c.notebookId, ui.P.EDIT_PAGES)) {
          <button type="button" (click)="ui.newPage(c.id)" [attr.aria-label]="'tree.newPage' | transloco"><mat-icon>add</mat-icon></button>
        }
        <button type="button" #trigger="matMenuTrigger" [matMenuTriggerFor]="menu" [attr.aria-label]="'common.more' | transloco"><mat-icon>more_horiz</mat-icon></button>
      </span>
    </div>
    <mat-menu #menu="matMenu">
      @if (ui.can(c.notebookId, ui.P.EDIT_PAGES)) {
        <button mat-menu-item type="button" (click)="ui.newPage(c.id)"><mat-icon>note_add</mat-icon>{{ 'tree.newPage' | transloco }}</button>
        <button mat-menu-item type="button" (click)="ui.newCategory(c.notebookId, c.id)"><mat-icon>create_new_folder</mat-icon>{{ 'tree.newSubcategory' | transloco }}</button>
        <button mat-menu-item type="button" (click)="ui.renaming.set(c.id)"><mat-icon>edit</mat-icon>{{ 'common.rename' | transloco }}</button>
        <button mat-menu-item type="button" (click)="ui.moveTo('category', c.id)"><mat-icon>drive_file_move</mat-icon>{{ 'tree.moveTo' | transloco }}</button>
        <button mat-menu-item type="button" (click)="ui.move('category', c, siblings(), -1)"><mat-icon>arrow_upward</mat-icon>{{ 'tree.moveUp' | transloco }}</button>
        <button mat-menu-item type="button" (click)="ui.move('category', c, siblings(), 1)"><mat-icon>arrow_downward</mat-icon>{{ 'tree.moveDown' | transloco }}</button>
      }
      <button mat-menu-item type="button" (click)="ui.export('category', c.id, c.name)"><mat-icon>download</mat-icon>{{ 'export.title' | transloco }}</button>
      @if (ui.can(c.notebookId, ui.P.DELETE_PAGES)) {
        <button mat-menu-item type="button" (click)="ui.remove('category', c.id, c.name)"><mat-icon>delete</mat-icon>{{ 'common.delete' | transloco }}</button>
      }
    </mat-menu>

    @if (ui.isOpen(c.id)) {
      @for (p of node().pages; track p.id) {
        <div class="row page" [class.sel]="ui.selectedPage() === p.id" [style.padding-left.px]="8 + (depth() + 1) * 14 + 22" (contextmenu)="$event.preventDefault(); pt.openMenu()">
          <a class="link" [href]="'/app/p/' + p.id" (click)="open($event, p.id)">
            <mat-icon class="ic">description</mat-icon>
            <app-inline-name kind="page" [id]="p.id" [value]="p.title" [placeholder]="'page.untitled' | transloco" />
          </a>
          <span class="actions">
            <button type="button" #pt="matMenuTrigger" [matMenuTriggerFor]="pmenu" [attr.aria-label]="'common.more' | transloco"><mat-icon>more_horiz</mat-icon></button>
          </span>
        </div>
        <mat-menu #pmenu="matMenu">
          @if (ui.can(p.notebookId, ui.P.EDIT_PAGES)) {
            <button mat-menu-item type="button" (click)="ui.renaming.set(p.id)"><mat-icon>edit</mat-icon>{{ 'common.rename' | transloco }}</button>
            <button mat-menu-item type="button" (click)="ui.moveTo('page', p.id)"><mat-icon>drive_file_move</mat-icon>{{ 'tree.moveTo' | transloco }}</button>
            <button mat-menu-item type="button" (click)="ui.move('page', p, node().pages, -1)"><mat-icon>arrow_upward</mat-icon>{{ 'tree.moveUp' | transloco }}</button>
            <button mat-menu-item type="button" (click)="ui.move('page', p, node().pages, 1)"><mat-icon>arrow_downward</mat-icon>{{ 'tree.moveDown' | transloco }}</button>
          }
          <button mat-menu-item type="button" (click)="ui.export('page', p.id, p.title)"><mat-icon>download</mat-icon>{{ 'export.title' | transloco }}</button>
          @if (ui.can(p.notebookId, ui.P.DELETE_PAGES)) {
            <button mat-menu-item type="button" (click)="ui.remove('page', p.id, p.title)"><mat-icon>delete</mat-icon>{{ 'common.delete' | transloco }}</button>
          }
        </mat-menu>
      }
      @for (child of node().children; track child.category.id) {
        <app-tree-category [node]="child" [depth]="depth() + 1" [siblings]="node().children.map(x => x.category)" />
      }
    }
  `,
  styleUrl: './tree.scss',
})
export class TreeCategory {
  readonly ui = inject(TreeUi);
  private readonly router = inject(Router);
  readonly node = input.required<CategoryNode>();
  readonly depth = input(0);
  readonly siblings = input<{ id: string; position: string }[]>([]);

  open(event: MouseEvent, id: string): void {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return; // let the browser open a new tab
    event.preventDefault();
    void this.router.navigate(['/app/p', id]);
  }
}

@Component({
  selector: 'app-tree',
  imports: [MatIconModule, MatButtonModule, MatMenuModule, TranslocoPipe, InlineName, TreeCategory],
  template: `
    @if (!spaceId()) {
      <div class="head" [attr.data-section]="shared() ? 'shared' : 'own'">
        <span class="title">{{ (shared() ? 'sharedWithMe.title' : 'tree.notebooks') | transloco }}</span>
        @if (!shared()) {
          <button mat-icon-button type="button" (click)="ui.newNotebook()" [attr.aria-label]="'tree.newNotebook' | transloco"><mat-icon>add</mat-icon></button>
        }
      </div>
    } @else if (canCreate()) {
      <div class="head sub">
        <button mat-button type="button" (click)="ui.newNotebook(spaceId()!)" data-action="new-notebook"><mat-icon>add</mat-icon>{{ 'tree.newNotebook' | transloco }}</button>
      </div>
    }
    @for (nb of nodes(); track nb.notebook.id) {
      @let n = nb.notebook;
      <div class="row nb" [attr.data-notebook]="n.name" (contextmenu)="$event.preventDefault(); trigger.openMenu()">
        <button class="twisty" type="button" (click)="ui.toggle(n.id)" [attr.aria-label]="'tree.toggle' | transloco" [attr.aria-expanded]="ui.isOpen(n.id)">
          <mat-icon>{{ ui.isOpen(n.id) ? 'expand_more' : 'chevron_right' }}</mat-icon>
        </button>
        <mat-icon class="ic" [style.color]="n.color">{{ n.icon || 'book' }}</mat-icon>
        <app-inline-name kind="notebook" [id]="n.id" [value]="n.name" />
        @if (shared() && accessOf(n.id); as a) {
          <span class="badge" [attr.data-access]="a">{{ 'share.access.' + a | transloco }}</span>
        }
        <span class="count">{{ nb.pageCount }}</span>
        <span class="actions">
          @if (ui.can(n.id, ui.P.EDIT_PAGES)) {
            <button type="button" (click)="ui.newCategory(n.id, null)" [attr.aria-label]="'tree.newCategory' | transloco"><mat-icon>create_new_folder</mat-icon></button>
          }
          <button type="button" #trigger="matMenuTrigger" [matMenuTriggerFor]="menu" [attr.aria-label]="'common.more' | transloco" data-notebook-menu><mat-icon>more_horiz</mat-icon></button>
        </span>
      </div>
      <mat-menu #menu="matMenu">
        @if (ui.can(n.id, ui.P.EDIT_PAGES)) {
          <button mat-menu-item type="button" (click)="ui.newCategory(n.id, null)"><mat-icon>create_new_folder</mat-icon>{{ 'tree.newCategory' | transloco }}</button>
        }
        @if (ui.can(n.id, ui.P.MANAGE_NOTEBOOKS)) {
          <button mat-menu-item type="button" (click)="ui.renaming.set(n.id)"><mat-icon>edit</mat-icon>{{ 'common.rename' | transloco }}</button>
          <button mat-menu-item type="button" (click)="ui.move('notebook', n, notebooks(), -1)"><mat-icon>arrow_upward</mat-icon>{{ 'tree.moveUp' | transloco }}</button>
          <button mat-menu-item type="button" (click)="ui.move('notebook', n, notebooks(), 1)"><mat-icon>arrow_downward</mat-icon>{{ 'tree.moveDown' | transloco }}</button>
          @if (!shared()) {
            <button mat-menu-item type="button" (click)="ui.moveNotebook(n.id)" data-action="move-notebook"><mat-icon>drive_file_move</mat-icon>{{ 'notebook.move.action' | transloco }}</button>
          }
        }
        @if (!shared() && ui.can(n.id, ui.P.SHARE_NOTEBOOKS)) {
          <button mat-menu-item type="button" (click)="ui.share(n.id, n.name)" data-action="share"><mat-icon>share</mat-icon>{{ 'share.action' | transloco }}</button>
        }
        @if (spaceId() && ui.can(n.id, ui.P.MANAGE_NOTEBOOKS)) {
          <button mat-menu-item type="button" (click)="ui.notebookAccess(n.id, n.name)" data-action="notebook-access"><mat-icon>lock_person</mat-icon>{{ 'notebook.access.action' | transloco }}</button>
        }
        <button mat-menu-item type="button" (click)="ui.export('notebook', n.id, n.name)"><mat-icon>download</mat-icon>{{ 'export.title' | transloco }}</button>
        @if (shared()) {
          <button mat-menu-item type="button" (click)="ui.leave(n.id)" data-action="leave"><mat-icon>logout</mat-icon>{{ 'sharedWithMe.leave' | transloco }}</button>
        } @else if (ui.can(n.id, ui.P.MANAGE_NOTEBOOKS)) {
          <button mat-menu-item type="button" (click)="ui.remove('notebook', n.id, n.name)"><mat-icon>delete</mat-icon>{{ 'common.delete' | transloco }}</button>
        }
      </mat-menu>
      @if (ui.isOpen(n.id)) {
        @for (c of nb.roots; track c.category.id) {
          <app-tree-category [node]="c" [depth]="1" [siblings]="siblingsOf(nb)" />
        }
      }
    } @empty {
      @if (!spaceId() && !shared()) {
        <p class="empty muted">{{ 'tree.empty' | transloco }}</p>
      }
    }
  `,
  styleUrl: './tree.scss',
})
export class Tree {
  readonly ui = inject(TreeUi);
  /** Show the notebooks of this team or project space instead of the person's own. */
  readonly spaceId = input<string | null>(null);
  /** Show the notebooks other people shared with the person. */
  readonly shared = input(false);
  readonly nodes = computed(() => {
    const space = this.spaceId();
    return this.shared() ? this.ui.store.sharedTree() : space ? this.ui.store.treeOfSpace(space) : this.ui.store.tree();
  });
  readonly notebooks = computed(() => this.nodes().map((n) => n.notebook));
  readonly canCreate = computed(() => {
    const space = this.spaceId();
    return !!space && this.ui.access.canCreateIn(space);
  });
  accessOf(notebookId: string): 'read' | 'edit' | null {
    return this.ui.store.sharedRows().find((s) => s.notebookId === notebookId)?.access ?? null;
  }
  siblingsOf(nb: NotebookNode) {
    return nb.roots.map((r) => r.category);
  }
}
