import {
  Component,
  DestroyRef,
  Injector,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Meta, Title } from '@angular/platform-browser';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Editor } from '@tiptap/core';
import { TiptapEditorDirective } from 'ngx-tiptap';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import type { JSONContent } from '@tiptap/core';
import type {
  LinkViewDto,
  PublicCategoryDto,
  PublicPageContentDto,
  PublicPageDto,
  PublicSearchHitDto,
} from '@os-planner/shared';
import { apiUrl } from '../../core/api-config';
import { AuthStore } from '../../core/auth-store';
import { MediaStore } from '../../data/media-store';
import { buildReaderExtensions } from '../editor/editor-extensions';

type State = 'loading' | 'password' | 'invalid' | 'throttled' | 'ready';

interface Row {
  kind: 'category' | 'page';
  id: string;
  label: string;
  depth: number;
}

const byPosition = <T extends { position: string }>(a: T, b: T): number =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : 0;

/**
 * The page behind a share link (`/s/:token`): the notebook, read-only, for anybody who holds the address. It does not use
 * the app shell, the local database or the signed-in session: every request is a plain fetch to the link endpoints, without
 * cookies, and a person is only asked who they are when they ask to edit (an edit link).
 */
@Component({
  selector: 'app-public-reader',
  imports: [
    FormsModule,
    RouterLink,
    TiptapEditorDirective,
    MatButtonModule,
    MatIconModule,
    TranslocoPipe,
  ],
  template: `
    @switch (state()) {
      @case ('loading') {
        <main class="center">
          <p class="muted">{{ 'common.loading' | transloco }}</p>
        </main>
      }
      @case ('invalid') {
        <main class="center" data-link-invalid>
          <mat-icon class="big">link_off</mat-icon>
          <h1>{{ 'errors.linkInvalid' | transloco }}</h1>
          <a mat-stroked-button routerLink="/">OS_Planner</a>
        </main>
      }
      @case ('throttled') {
        <main class="center" data-link-throttled>
          <mat-icon class="big">hourglass_top</mat-icon>
          <h1>{{ 'publicView.tooMany' | transloco }}</h1>
        </main>
      }
      @case ('password') {
        <main class="center" data-link-password>
          <mat-icon class="big">lock</mat-icon>
          <h1>{{ 'publicView.passwordTitle' | transloco }}</h1>
          <form class="pw" (ngSubmit)="submitPassword()">
            <input
              type="password"
              name="password"
              [(ngModel)]="password"
              [attr.aria-label]="'share.password' | transloco"
              autocomplete="off"
              autofocus
              data-field="reader-password"
            />
            <button mat-flat-button type="submit" [disabled]="!password">
              {{ 'publicView.open' | transloco }}
            </button>
          </form>
          @if (wrongPassword()) {
            <p class="err" role="alert" data-wrong-password>
              {{ 'publicView.wrongPassword' | transloco }}
            </p>
          }
        </main>
      }
      @case ('ready') {
        @let v = view()!;
        <div class="reader" data-public-reader>
          <header class="bar">
            <mat-icon [style.color]="v.notebook.color">{{ v.notebook.icon || 'book' }}</mat-icon>
            <h1 class="nb">{{ v.notebook.name }}</h1>
            @if (v.ownerName) {
              <span class="by">{{ 'publicView.sharedBy' | transloco: { name: v.ownerName } }}</span>
            }
            <span class="grow"></span>
            <form class="search" role="search" (ngSubmit)="search()">
              <mat-icon>search</mat-icon>
              <input
                name="q"
                [(ngModel)]="query"
                (ngModelChange)="onQuery()"
                [placeholder]="'publicView.search' | transloco"
                [attr.aria-label]="'publicView.search' | transloco"
                autocomplete="off"
                data-field="reader-search"
              />
            </form>
            <button
              mat-icon-button
              type="button"
              (click)="print()"
              [attr.aria-label]="'publicView.print' | transloco"
              data-action="print"
            >
              <mat-icon>print</mat-icon>
            </button>
            @if (v.access === 'edit') {
              <button
                mat-flat-button
                type="button"
                (click)="edit()"
                [disabled]="joining()"
                data-action="edit-link"
              >
                {{ 'publicView.edit' | transloco }}
              </button>
            }
          </header>
          @if (editMessage(); as m) {
            <p class="notice" role="status" data-edit-message>{{ m | transloco }}</p>
          }
          <div class="cols">
            <nav class="tree" [attr.aria-label]="v.notebook.name">
              @if (hits(); as h) {
                <p class="hint">{{ 'publicView.results' | transloco: { n: h.length } }}</p>
                @for (hit of h; track hit.pageId) {
                  <button
                    type="button"
                    class="hit"
                    (click)="open(hit.pageId); clearSearch()"
                    [attr.data-hit]="hit.title"
                  >
                    <strong>{{ hit.title || ('page.untitled' | transloco) }}</strong>
                    <small>{{ hit.categoryName }}</small>
                    <span class="snip">{{ plain(hit.snippet) }}</span>
                  </button>
                }
              } @else {
                @for (r of rows(); track r.kind + r.id) {
                  @if (r.kind === 'category') {
                    <div class="cat" [style.padding-left.px]="8 + r.depth * 14">
                      <mat-icon>folder</mat-icon>{{ r.label }}
                    </div>
                  } @else {
                    <button
                      type="button"
                      class="page"
                      [class.sel]="r.id === pageId()"
                      [style.padding-left.px]="8 + r.depth * 14 + 22"
                      (click)="open(r.id)"
                      [attr.data-page]="r.label"
                    >
                      <mat-icon>description</mat-icon>{{ r.label || ('page.untitled' | transloco) }}
                    </button>
                  }
                } @empty {
                  <p class="hint">{{ 'publicView.empty' | transloco }}</p>
                }
              }
            </nav>
            <article class="paper">
              @if (page(); as p) {
                <h2 class="title" data-reader-title>
                  {{ p.title || ('page.untitled' | transloco) }}
                </h2>
                @if (editor(); as ed) {
                  <div tiptap [editor]="ed" class="content"></div>
                }
              } @else {
                <p class="muted">{{ 'publicView.pickPage' | transloco }}</p>
              }
            </article>
          </div>
        </div>
      }
    }
  `,
  styles: `
    :host {
      display: block;
      min-height: 100dvh;
      background: var(--bg);
      color: var(--text);
    }
    .center {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      min-height: 80dvh;
      padding: 24px;
      text-align: center;
    }
    .big {
      font-size: 56px;
      width: 56px;
      height: 56px;
      color: var(--text-dim);
    }
    .pw {
      display: flex;
      gap: 8px;
    }
    .pw input,
    .search input {
      font: inherit;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      color: var(--text);
    }
    .err {
      color: var(--mat-sys-error);
    }
    .reader {
      display: flex;
      flex-direction: column;
      min-height: 100dvh;
    }
    .bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
      position: sticky;
      top: 0;
      z-index: 2;
      flex-wrap: wrap;
    }
    .bar .grow {
      flex: 1;
    }
    .nb {
      font-size: 18px;
      margin: 0;
    }
    .by {
      color: var(--text-dim);
      font-size: 13px;
    }
    .search {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .search mat-icon {
      color: var(--text-dim);
    }
    .notice {
      margin: 0;
      padding: 8px 16px;
      background: var(--surface-3);
      font-size: 13px;
    }
    .cols {
      display: flex;
      flex: 1;
      min-height: 0;
    }
    .tree {
      width: 280px;
      flex: none;
      border-right: 1px solid var(--border);
      padding: 8px 0;
      overflow: auto;
      background: var(--surface);
    }
    .cat,
    .page {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      font-size: 14px;
    }
    .cat {
      color: var(--text-dim);
      font-weight: 600;
    }
    .page {
      width: 100%;
      border: 0;
      background: none;
      color: var(--text);
      text-align: left;
      cursor: pointer;
      font: inherit;
      font-size: 14px;
      border-radius: 6px;
    }
    .page:hover {
      background: var(--surface-3);
    }
    .page.sel {
      background: color-mix(in srgb, var(--accent) 16%, transparent);
      font-weight: 600;
    }
    mat-icon {
      font-size: 20px;
      width: 20px;
      height: 20px;
      flex: none;
    }
    .hint {
      margin: 8px 16px;
      color: var(--text-dim);
      font-size: 13px;
    }
    .hit {
      display: flex;
      flex-direction: column;
      gap: 2px;
      width: 100%;
      border: 0;
      background: none;
      color: var(--text);
      text-align: left;
      padding: 8px 16px;
      cursor: pointer;
      font: inherit;
    }
    .hit:hover {
      background: var(--surface-3);
    }
    .hit small {
      color: var(--text-dim);
    }
    .snip {
      font-size: 12px;
      color: var(--text-dim);
    }
    .paper {
      flex: 1;
      min-width: 0;
      padding: 24px clamp(16px, 5vw, 64px);
      max-width: 920px;
    }
    .title {
      font-size: 28px;
      margin: 0 0 16px;
    }
    .muted {
      color: var(--text-dim);
    }
    @media (max-width: 760px) {
      .cols {
        flex-direction: column;
      }
      .tree {
        width: auto;
        border-right: 0;
        border-bottom: 1px solid var(--border);
        max-height: 36dvh;
      }
    }
    @media print {
      .bar,
      .tree,
      .notice {
        display: none !important;
      }
      :host {
        background: #fff;
        color: #000;
      }
      .paper {
        max-width: none;
        padding: 0;
      }
    }
  `,
})
export class PublicReader {
  /** From the address: /s/:token. */
  readonly token = input.required<string>();

  private readonly injector = inject(Injector);
  private readonly auth = inject(AuthStore);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly meta = inject(Meta);
  private readonly titleService = inject(Title);

  readonly state = signal<State>('loading');
  readonly view = signal<LinkViewDto | null>(null);
  readonly page = signal<PublicPageContentDto | null>(null);
  readonly pageId = signal<string | null>(null);
  readonly editor = signal<Editor | null>(null);
  readonly wrongPassword = signal(false);
  readonly hits = signal<PublicSearchHitDto[] | null>(null);
  readonly joining = signal(false);
  readonly editMessage = signal<string | null>(null);
  password = '';
  query = '';
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  /** The tree as one list: a category, its pages, then its subcategories. */
  readonly rows = computed<Row[]>(() => {
    const v = this.view();
    if (!v) return [];
    const children = new Map<string | null, PublicCategoryDto[]>();
    for (const c of v.categories)
      (children.get(c.parentId) ?? children.set(c.parentId, []).get(c.parentId)!).push(c);
    const pagesIn = new Map<string, PublicPageDto[]>();
    for (const p of v.pages)
      (pagesIn.get(p.categoryId) ?? pagesIn.set(p.categoryId, []).get(p.categoryId)!).push(p);
    const out: Row[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const c of (children.get(parent) ?? []).sort(byPosition)) {
        out.push({ kind: 'category', id: c.id, label: c.name, depth });
        for (const p of (pagesIn.get(c.id) ?? []).sort(byPosition))
          out.push({ kind: 'page', id: p.id, label: p.title, depth: depth + 1 });
        walk(c.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  });

  constructor() {
    // Nothing about a shared notebook belongs in a search engine or in a Referer header.
    this.meta.addTag({ name: 'robots', content: 'noindex, nofollow' }, true);
    this.meta.addTag({ name: 'referrer', content: 'no-referrer' }, true);
    inject(DestroyRef).onDestroy(() => {
      this.meta.removeTag('name="robots"');
      this.meta.removeTag('name="referrer"');
      this.editor()?.destroy();
    });
    effect(() => {
      const token = this.token();
      untracked(() => void this.resolve(token));
    });
  }

  // ------------------------------------------------------------------ talking to the link endpoints (no cookies, no sign-in)

  private async call<T>(
    path: string,
    init?: RequestInit,
  ): Promise<{ status: number; body: T | null }> {
    try {
      const res = await fetch(apiUrl(path), {
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        ...init,
      });
      const body = res.headers.get('content-type')?.includes('json')
        ? ((await res.json()) as T)
        : null;
      return { status: res.status, body };
    } catch {
      return { status: 0, body: null };
    }
  }

  private async resolve(token: string, password?: string): Promise<void> {
    this.state.set(this.view() ? this.state() : 'loading');
    const res = await this.call<LinkViewDto & { message?: string }>('/api/links/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, ...(password !== undefined ? { password } : {}) }),
    });
    if (res.status === 200 && res.body) {
      this.view.set(res.body);
      this.state.set('ready');
      this.titleService.setTitle(`${res.body.notebook.name} · OS_Planner`);
      const first = this.rows().find((r) => r.kind === 'page');
      if (first && !this.pageId()) await this.open(first.id);
      // Coming back from signing in to use an edit link: finish what was asked.
      if (res.body.access === 'edit' && this.route.snapshot.queryParamMap.get('edit') === '1')
        void this.edit();
    } else if (res.status === 401) {
      this.state.set('password');
    } else if (res.status === 403) {
      this.wrongPassword.set(true);
      this.state.set('password');
    } else if (res.status === 429) {
      this.state.set('throttled');
    } else {
      this.state.set('invalid');
    }
  }

  async submitPassword(): Promise<void> {
    this.wrongPassword.set(false);
    const typed = this.password;
    this.password = '';
    this.typedPassword = typed;
    await this.resolve(this.token(), typed);
  }
  /** Kept in memory only, to join an edit link that has a password. */
  private typedPassword: string | undefined;

  // ------------------------------------------------------------------ reading

  private session(): string {
    return this.view()?.session ?? '';
  }

  async open(pageId: string): Promise<void> {
    this.pageId.set(pageId);
    const res = await this.call<PublicPageContentDto>(
      `/api/links/${this.token()}/pages/${pageId}?s=${encodeURIComponent(this.session())}`,
    );
    if (this.pageId() !== pageId) return;
    if (res.status !== 200 || !res.body) {
      this.page.set(null);
      this.state.set(res.status === 401 ? 'password' : 'invalid');
      return;
    }
    this.page.set(res.body);
    this.show(res.body.content);
  }

  private show(content: JSONContent): void {
    const existing = this.editor();
    if (existing) return void existing.commands.setContent(content, { emitUpdate: false });
    const token = this.token();
    // The node views ask the media store for a picture's address: here it is a link address, no sign-in involved.
    const reader = Injector.create({
      parent: this.injector,
      providers: [
        {
          provide: MediaStore,
          useValue: {
            urlFor: async (id: string) =>
              apiUrl(`/api/links/${token}/media/${id}?s=${encodeURIComponent(this.session())}`),
          },
        },
      ],
    });
    this.editor.set(
      new Editor({
        extensions: buildReaderExtensions(reader),
        content,
        editable: false,
        editorProps: { attributes: { class: 'doc', spellcheck: 'false' } },
      }),
    );
  }

  // ------------------------------------------------------------------ searching inside the notebook

  onQuery(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    if (!this.query.trim()) return void this.hits.set(null);
    this.searchTimer = setTimeout(() => void this.search(), 300);
  }

  async search(): Promise<void> {
    const q = this.query.trim();
    if (!q) return void this.hits.set(null);
    const res = await this.call<PublicSearchHitDto[]>(
      `/api/links/${this.token()}/search?q=${encodeURIComponent(q)}&s=${encodeURIComponent(this.session())}`,
    );
    this.hits.set(res.status === 200 && res.body ? res.body : []);
  }

  clearSearch(): void {
    this.query = '';
    this.hits.set(null);
  }

  /** Search snippets mark matches with [[ ]]; shown as plain text here. */
  plain(snippet: string): string {
    return snippet.replaceAll('[[', '').replaceAll(']]', '');
  }

  print(): void {
    window.print();
  }

  // ------------------------------------------------------------------ editing needs a person

  /** An edit link: sign in if needed, then the notebook becomes the person's (an edit share bound to the link). */
  async edit(): Promise<void> {
    this.joining.set(true);
    this.editMessage.set(null);
    try {
      if (!(await this.auth.resume())) {
        await this.router.navigate(['/login'], {
          queryParams: { returnUrl: `/s/${this.token()}?edit=1` },
        });
        return;
      }
      const joined = await firstValueFrom(
        this.http.post<{ notebookId: string }>('/api/links/join', {
          token: this.token(),
          ...(this.typedPassword ? { password: this.typedPassword } : {}),
        }),
      );
      const page = this.pageId();
      await this.router.navigate(page ? ['/app/p', page] : ['/app'], {
        queryParams: { notebook: joined.notebookId },
      });
    } catch {
      this.editMessage.set('publicView.editFailed');
    } finally {
      this.joining.set(false);
    }
  }
}
