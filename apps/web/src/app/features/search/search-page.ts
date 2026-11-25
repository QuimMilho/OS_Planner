import { HttpClient } from '@angular/common/http';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import type { JSONContent } from '@tiptap/core';
import { extractText } from '@notes/shared/lite';
import type { SearchResultDto } from '@notes/shared';
import { Db } from '../../data/db';
import { TreeStore } from '../../data/tree-store';

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

interface Segment {
  text: string;
  hit: boolean;
}

/** Splits "a [[match]] b" into parts so matches can be highlighted without using innerHTML. */
function segments(snippet: string): Segment[] {
  return snippet.split(/(\[\[.*?\]\])/g).filter(Boolean).map((s) => (s.startsWith('[[') && s.endsWith(']]') ? { text: s.slice(2, -2), hit: true } : { text: s, hit: false }));
}

@Component({
  selector: 'app-search-page',
  imports: [FormsModule, RouterLink, MatIconModule, TranslocoPipe],
  template: `
    <div class="wrap">
      <form class="box" (ngSubmit)="go()">
        <mat-icon>search</mat-icon>
        <input name="q" [(ngModel)]="text" (ngModelChange)="typed($event)" [placeholder]="'nav.search' | transloco" autocomplete="off" autofocus />
      </form>
      @if (local()) { <p class="muted note"><mat-icon>cloud_off</mat-icon>{{ 'search.local' | transloco }}</p> }

      @if (busy()) { <p class="muted">{{ 'common.loading' | transloco }}</p> }
      @else if (q().trim() && results().length === 0) { <p class="muted">{{ 'search.none' | transloco }}</p> }

      <ul>
        @for (r of results(); track r.pageId) {
          <li>
            <a [routerLink]="['/app/p', r.pageId]">
              <span class="t"><mat-icon>description</mat-icon>{{ r.title || ('page.untitled' | transloco) }}</span>
              <span class="crumb muted">{{ r.notebookName }} › {{ r.categoryName }}</span>
              <span class="snip">@for (s of parts(r.snippet); track $index) { @if (s.hit) { <mark>{{ s.text }}</mark> } @else { {{ s.text }} } }</span>
            </a>
          </li>
        }
      </ul>
    </div>
  `,
  styles: `
    .wrap { max-width: 760px; margin: 0 auto; padding: 24px 20px; } .box { display: flex; align-items: center; gap: 10px; padding: 0 16px; height: 48px; border-radius: 24px; background: var(--surface-3); }
    .box input { flex: 1; border: 0; outline: 0; background: none; color: var(--text); font: inherit; font-size: 17px; } .note { display: flex; gap: 6px; align-items: center; font-size: 13px; }
    ul { list-style: none; padding: 0; margin: 16px 0; } li a { display: block; padding: 12px 14px; border-radius: 12px; color: var(--text); text-decoration: none; } li a:hover { background: var(--surface-3); }
    .t { display: flex; align-items: center; gap: 8px; font-weight: 600; } .crumb { display: block; font-size: 12px; margin: 2px 0 4px 32px; } .snip { display: block; margin-left: 32px; color: var(--text-dim); font-size: 14px; }
    mark { background: color-mix(in srgb, #f08c00 35%, transparent); color: inherit; border-radius: 3px; padding: 0 1px; }
  `,
})
export class SearchPage {
  /** From the URL (?q=). */
  readonly q = input('');
  private readonly http = inject(HttpClient);
  private readonly dbs = inject(Db);
  private readonly store = inject(TreeStore);
  private readonly router = inject(Router);

  text = '';
  readonly results = signal<SearchResultDto[]>([]);
  readonly busy = signal(false);
  readonly local = signal(false);
  private timer: ReturnType<typeof setTimeout> | null = null;
  readonly parts = (s: string) => segments(s);
  readonly searchable = computed(() => this.q().trim().length > 0);

  constructor() {
    effect(() => {
      const q = this.q();
      untracked(() => {
        this.text = q;
        void this.run(q);
      });
    });
  }

  /** Searching as you type updates the address, so a search can be bookmarked or shared. */
  typed(value: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.router.navigate([], { queryParams: { q: value.trim() || null }, replaceUrl: true }), 250);
  }

  go(): void {
    void this.router.navigate([], { queryParams: { q: this.text.trim() || null }, replaceUrl: true });
  }

  private async run(q: string): Promise<void> {
    if (!q.trim()) return void (this.results.set([]), this.local.set(false));
    this.busy.set(true);
    try {
      this.results.set(await firstValueFrom(this.http.get<SearchResultDto[]>('/api/search', { params: { q } })));
      this.local.set(false);
    } catch {
      this.results.set(await this.searchLocally(q));
      this.local.set(true);
    } finally {
      this.busy.set(false);
    }
  }

  /** Offline: scan the notes stored on this device (all words must appear; accents and case ignored). */
  private async searchLocally(q: string): Promise<SearchResultDto[]> {
    const words = fold(q).split(/\s+/).filter((w) => w.length > 1);
    if (!words.length) return [];
    const out: SearchResultDto[] = [];
    for (const row of await this.dbs.db.contents.toArray()) {
      const meta = this.store.pageById().get(row.id);
      if (!meta || meta.deletedAt) continue;
      const text = extractText(row.content as JSONContent);
      const haystack = fold(`${meta.title} ${text}`);
      if (!words.every((w) => haystack.includes(w))) continue;
      const cat = this.store.categoryById().get(meta.categoryId);
      const at = Math.max(0, fold(text).indexOf(words[0]!) - 60);
      out.push({
        pageId: meta.id,
        title: meta.title,
        notebookId: meta.notebookId,
        notebookName: this.store.notebookById().get(meta.notebookId)?.name ?? '',
        categoryId: meta.categoryId,
        categoryName: cat?.name ?? '',
        snippet: text.slice(at, at + 160).replace(/\s+/g, ' '),
        score: 0,
        updatedAt: meta.updatedAt,
      });
    }
    return out.slice(0, 30);
  }
}
