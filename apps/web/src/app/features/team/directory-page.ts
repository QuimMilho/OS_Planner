import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import type { DirectoryTeamDto } from '@os-planner/shared';
import { toProblem } from '../../core/auth-store';
import { Notify } from '../../core/notify';
import { MembershipStore } from '../../data/membership-store';
import { Dialogs } from '../../shared/dialogs';
import { AuthStore } from '../../core/auth-store';

/** Public teams anyone signed in may find and join (at once, or by asking). Private teams never show up here. */
@Component({
  selector: 'app-directory-page',
  imports: [FormsModule, MatButtonModule, MatIconModule, TranslocoPipe],
  template: `
    <div class="page" data-directory>
      <h1>{{ 'directory.title' | transloco }}</h1>
      <p class="muted">{{ 'directory.hint' | transloco }}</p>

      <form class="search" (ngSubmit)="search()">
        <input
          name="q"
          [(ngModel)]="q"
          [placeholder]="'directory.search' | transloco"
          [attr.aria-label]="'directory.search' | transloco"
          data-field="directory-search"
        />
        <button mat-flat-button type="submit" data-action="directory-search">
          {{ 'directory.searchButton' | transloco }}
        </button>
      </form>
      @if (tag()) {
        <p class="filter">
          {{ 'directory.tag' | transloco }}: <strong>{{ tag() }}</strong>
          <button type="button" class="link" (click)="setTag('')" data-action="clear-tag">
            {{ 'directory.clearTag' | transloco }}
          </button>
        </p>
      }

      @if (!verified()) {
        <p class="notice" data-directory-verify>{{ 'directory.verifyFirst' | transloco }}</p>
      }

      @if (loaded() && !items().length) {
        <p class="muted" data-directory-empty>{{ 'directory.empty' | transloco }}</p>
      }

      <div class="cards">
        @for (t of items(); track t.id) {
          <article class="card" [attr.data-directory-team]="t.name">
            <header>
              <span class="icon" [style.background]="t.color">{{
                t.name.charAt(0).toUpperCase()
              }}</span>
              <div>
                <h2>{{ t.name }}</h2>
                <span class="muted small">{{
                  'invite.members' | transloco: { count: t.memberCount }
                }}</span>
              </div>
            </header>
            @if (t.blurb || t.description) {
              <p class="blurb">{{ t.blurb || t.description }}</p>
            }
            @if (t.tags.length) {
              <p class="tags">
                @for (tg of t.tags; track tg) {
                  <button type="button" class="tag" (click)="setTag(tg)" [attr.data-tag]="tg">
                    {{ tg }}
                  </button>
                }
              </p>
            }
            <footer>
              @switch (t.mine) {
                @case ('member') {
                  <button
                    mat-stroked-button
                    type="button"
                    (click)="open(t)"
                    data-action="open-team"
                  >
                    {{ 'common.open' | transloco }}
                  </button>
                }
                @case ('requested') {
                  <span class="muted" data-requested>{{ 'join.requested' | transloco }}</span>
                  <button mat-button type="button" (click)="withdraw(t)" data-action="withdraw">
                    {{ 'join.withdraw' | transloco }}
                  </button>
                }
                @default {
                  <button
                    mat-flat-button
                    type="button"
                    [disabled]="!verified() || busy() === t.id"
                    (click)="join(t)"
                    [attr.data-action]="t.joinPolicy === 'open' ? 'join' : 'request-join'"
                  >
                    {{ (t.joinPolicy === 'open' ? 'join.open' : 'join.request') | transloco }}
                  </button>
                }
              }
            </footer>
          </article>
        }
      </div>

      @if (next()) {
        <button mat-stroked-button type="button" (click)="more()" data-action="directory-more">
          {{ 'audit.more' | transloco }}
        </button>
      }
    </div>
  `,
  styles: `
    .page {
      max-width: 1040px;
      margin: 0 auto;
      padding: 24px 20px 64px;
    }
    h1 {
      margin: 0 0 4px;
      font-size: 26px;
    }
    .search {
      display: flex;
      gap: 8px;
      margin: 16px 0;
    }
    .search input {
      flex: 1;
      font: inherit;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface-2);
      color: var(--text);
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 14px;
      margin-bottom: 20px;
    }
    .card {
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      background: var(--surface-2);
    }
    .card header {
      display: flex;
      gap: 12px;
      align-items: center;
    }
    .card h2 {
      margin: 0;
      font-size: 17px;
      overflow-wrap: anywhere;
    }
    .icon {
      display: grid;
      place-items: center;
      width: 44px;
      height: 44px;
      border-radius: 12px;
      background: var(--accent);
      color: #fff;
      font-weight: 700;
      font-size: 19px;
      flex: none;
    }
    .blurb {
      margin: 0;
      overflow-wrap: anywhere;
    }
    .tags {
      margin: 0;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .tag {
      border: 0;
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      padding: 1px 9px;
      border-radius: 10px;
      background: var(--surface-3);
      color: var(--text-dim);
    }
    .card footer {
      margin-top: auto;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .small {
      font-size: 12px;
    }
    .filter {
      margin: 0 0 12px;
    }
    .link {
      border: 0;
      background: none;
      color: var(--accent);
      cursor: pointer;
      font: inherit;
      margin-left: 8px;
    }
    .notice {
      padding: 10px 14px;
      border-radius: 8px;
      background: var(--surface-3);
      color: var(--text-dim);
    }
  `,
})
export class DirectoryPage implements OnInit {
  private readonly store = inject(MembershipStore);
  private readonly notify = inject(Notify);
  private readonly router = inject(Router);
  private readonly dialogs = inject(Dialogs);
  private readonly auth = inject(AuthStore);

  protected q = '';
  protected readonly tag = signal('');
  protected readonly items = signal<DirectoryTeamDto[]>([]);
  protected readonly next = signal<string | null>(null);
  protected readonly loaded = signal(false);
  protected readonly busy = signal('');
  protected readonly verified = () => this.auth.user()?.emailVerified === true;

  ngOnInit(): void {
    void this.load(false);
  }

  protected search(): void {
    void this.load(false);
  }

  protected setTag(tag: string): void {
    this.tag.set(tag);
    void this.load(false);
  }

  protected more(): void {
    void this.load(true);
  }

  private async load(append: boolean): Promise<void> {
    try {
      const page = await this.store.directory({
        q: this.q.trim(),
        tag: this.tag(),
        cursor: append ? (this.next() ?? '') : '',
      });
      this.items.set(append ? [...this.items(), ...page.items] : page.items);
      this.next.set(page.nextCursor);
      this.loaded.set(true);
    } catch (e) {
      this.notify.error(toProblem(e).offline ? 'errors.offline' : 'errors.generic');
    }
  }

  private patch(t: DirectoryTeamDto, change: Partial<DirectoryTeamDto>): void {
    this.items.update((list) => list.map((x) => (x.id === t.id ? { ...x, ...change } : x)));
  }

  protected async join(t: DirectoryTeamDto): Promise<void> {
    let message = '';
    if (t.joinPolicy === 'request') {
      const answer = await this.dialogs.prompt({
        titleKey: 'join.requestTitle',
        labelKey: 'join.messageLabel',
        confirmKey: 'join.request',
      });
      if (answer?.action !== 'ok') return;
      message = answer.value;
    }
    this.busy.set(t.id);
    try {
      const res = await this.store.join(t.id, message);
      if (res.status === 'joined') {
        this.patch(t, { mine: 'member', memberCount: t.memberCount + 1 });
        await this.router.navigate(['/app/t', t.id]);
      } else {
        this.patch(t, { mine: 'requested' });
        this.notify.info('join.sent', { team: t.name });
      }
    } catch (e) {
      const code = toProblem(e).code;
      this.notify.error(
        code === 'banned'
          ? 'join.err.banned'
          : code === 'quota_exceeded'
            ? 'join.err.full'
            : code === 'email_not_verified'
              ? 'directory.verifyFirst'
              : 'errors.generic',
      );
    } finally {
      this.busy.set('');
    }
  }

  protected async withdraw(t: DirectoryTeamDto): Promise<void> {
    try {
      await this.store.withdraw(t.id);
      this.patch(t, { mine: 'none' });
    } catch {
      this.notify.error('errors.generic');
    }
  }

  protected open(t: DirectoryTeamDto): void {
    void this.router.navigate(['/app/t', t.id]);
  }
}
