import { Component, computed, inject } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { Language } from '../../core/i18n';
import { TreeStore } from '../../data/tree-store';
import { TreeUi } from './tree';

@Component({
  selector: 'app-home',
  imports: [RouterLink, MatButtonModule, MatIconModule, TranslocoPipe],
  template: `
    <div class="home">
      @if (store.tree().length === 0) {
        <section class="hero">
          <img src="favicon.svg" alt="" width="72" height="72" />
          <h1>{{ 'home.welcome' | transloco }}</h1>
          <p class="muted">{{ 'home.welcomeText' | transloco }}</p>
          <button mat-flat-button type="button" (click)="ui.newNotebook()"><mat-icon>add</mat-icon>{{ 'home.createFirst' | transloco }}</button>
        </section>
      } @else {
        <h1>{{ 'home.title' | transloco }}</h1>
        <div class="actions">
          <button mat-flat-button type="button" (click)="newPage()"><mat-icon>note_add</mat-icon>{{ 'tree.newPage' | transloco }}</button>
          <button mat-stroked-button type="button" (click)="ui.newNotebook()"><mat-icon>book</mat-icon>{{ 'tree.newNotebook' | transloco }}</button>
        </div>
        <h2>{{ 'home.recent' | transloco }}</h2>
        <ul class="recent">
          @for (p of recent(); track p.id) {
            <li>
              <a [routerLink]="['/app/p', p.id]">
                <mat-icon>description</mat-icon>
                <span class="t">{{ p.title || ('page.untitled' | transloco) }}</span>
                <span class="where muted">{{ where(p.categoryId) }}</span>
                <span class="when muted">{{ lang.date(p.updatedAt) }}</span>
              </a>
            </li>
          } @empty {
            <li class="muted">{{ 'home.noPages' | transloco }}</li>
          }
        </ul>
      }
    </div>
  `,
  styles: `
    .home { max-width: 760px; margin: 0 auto; padding: 32px 20px; } h1 { margin: 0 0 16px; font-size: 28px; } h2 { font-size: 15px; margin: 32px 0 8px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; }
    .hero { text-align: center; padding: 64px 0; display: flex; flex-direction: column; align-items: center; gap: 12px; } .hero p { max-width: 420px; margin: 0 0 12px; }
    .actions { display: flex; gap: 12px; flex-wrap: wrap; } .recent { list-style: none; padding: 0; margin: 0; } li a { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 10px; color: var(--text); text-decoration: none; }
    li a:hover { background: var(--surface-3); } .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .where, .when { font-size: 13px; white-space: nowrap; } mat-icon { color: var(--text-dim); }
    @media (max-width: 640px) { .where { display: none; } }
  `,
})
export class Home {
  readonly store = inject(TreeStore);
  readonly ui = inject(TreeUi);
  readonly lang = inject(Language);
  private readonly router = inject(Router);

  readonly recent = computed(() =>
    this.store
      .pages()
      .filter((p) => !p.deletedAt && this.store.isPersonal(p))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 12),
  );

  constructor() {
    // The installed app's "New page" shortcut opens /app?new=page.
    if (inject(ActivatedRoute).snapshot.queryParamMap.get('new') === 'page') queueMicrotask(() => void this.newPage());
  }

  where(categoryId: string): string {
    const c = this.store.categoryById().get(categoryId);
    return c ? `${this.store.notebookById().get(c.notebookId)?.name ?? ''} › ${c.name}` : '';
  }

  async newPage(): Promise<void> {
    const first = this.store.tree()[0]?.roots[0];
    if (!first) return this.ui.newNotebook();
    await this.ui.newPage(first.category.id);
  }
}
