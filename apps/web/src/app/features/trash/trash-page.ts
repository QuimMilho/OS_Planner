import { Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { Permission } from '@os-planner/shared/lite';
import { Language } from '../../core/i18n';
import { AccessStore } from '../../data/access-store';
import { TreeStore, type TrashItem } from '../../data/tree-store';

@Component({
  selector: 'app-trash-page',
  imports: [MatButtonModule, MatIconModule, TranslocoPipe],
  template: `
    <div class="wrap">
      <h1>{{ 'trash.title' | transloco }}</h1>
      <p class="muted">{{ 'trash.info' | transloco }}</p>
      <ul>
        @for (t of items(); track t.item.id) {
          <li [attr.data-trash]="name(t)">
            <mat-icon>{{ icon(t) }}</mat-icon>
            <span class="name">{{ name(t) }}@if (where(t); as w) { <small class="muted"> · {{ w }}</small> }</span>
            <span class="muted when">{{ 'trash.kind.' + t.kind | transloco }} · {{ lang.date(t.item.deletedAt!) }}</span>
            <button mat-stroked-button type="button" (click)="restore(t)"><mat-icon>restore</mat-icon>{{ 'common.restore' | transloco }}</button>
          </li>
        } @empty {
          <li class="muted empty"><mat-icon>delete_outline</mat-icon>{{ 'trash.empty' | transloco }}</li>
        }
      </ul>
    </div>
  `,
  styles: `
    .wrap { max-width: 760px; margin: 0 auto; padding: 24px 20px; } h1 { margin: 0 0 4px; } ul { list-style: none; padding: 0; margin: 16px 0; }
    li { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-bottom: 1px solid var(--border); } .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .when { font-size: 13px; white-space: nowrap; }
    .empty { justify-content: center; padding: 40px; border: 0; } mat-icon { color: var(--text-dim); } @media (max-width: 640px) { .when { display: none; } }
  `,
})
export class TrashPage {
  readonly store = inject(TreeStore);
  readonly lang = inject(Language);
  private readonly access = inject(AccessStore);

  /** What the person may bring back: in their own notebooks everything, elsewhere what their rights there allow. */
  readonly items = computed(() =>
    this.store.trash().filter((t) => this.access.can(t.kind === 'notebook' ? t.item.id : t.item.notebookId, t.kind === 'notebook' ? Permission.MANAGE_NOTEBOOKS : Permission.DELETE_PAGES)),
  );

  /** For something in somebody else's notebook (or a team's): which notebook. */
  where(t: TrashItem): string | null {
    if (t.kind === 'notebook') return null;
    const nb = this.store.notebookById().get(t.item.notebookId);
    return nb && !this.access.isOwn(nb) ? nb.name : null;
  }

  icon(t: TrashItem): string {
    return t.kind === 'notebook' ? 'book' : t.kind === 'category' ? 'folder' : 'description';
  }

  name(t: TrashItem): string {
    const n = t.kind === 'page' ? t.item.title : t.item.name;
    return n || this.lang.t('page.untitled');
  }

  async restore(t: TrashItem): Promise<void> {
    if (t.kind === 'notebook') await this.store.restoreNotebook(t.item.id);
    else if (t.kind === 'category') await this.store.restoreCategory(t.item.id);
    else await this.store.restorePage(t.item.id);
  }
}
