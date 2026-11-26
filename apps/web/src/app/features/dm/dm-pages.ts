import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { debounceTime, Subject } from 'rxjs';
import type { DmDto, DmPersonDto } from '@os-planner/shared';
import { isUnreachable } from '../../core/auth-store';
import { Language } from '../../core/i18n';
import { Notify } from '../../core/notify';
import { NavContext } from '../../core/nav-context';
import { ChatStore } from '../../data/chat-store';
import { DmStore } from '../../data/dm-store';
import { PresenceStore } from '../../data/presence-store';
import { TeamStore } from '../../data/team-store';
import { ChannelPage } from '../chat/channel-page';
import { NotFoundPage } from '../shell/not-found';

/** Somebody to start a conversation with: people from your teams, found by name. */
@Component({
  selector: 'app-dm-picker',
  imports: [FormsModule, MatIconModule, TranslocoPipe],
  template: `
    <div class="picker" data-dm-picker>
      <input
        type="search"
        name="dmq"
        [(ngModel)]="query"
        (ngModelChange)="search$.next($event)"
        [placeholder]="'dm.pickerSearch' | transloco"
        [attr.aria-label]="'dm.pickerSearch' | transloco"
        autocomplete="off"
        data-dm-search
      />
      <ul>
        @for (p of people(); track p.userId) {
          <li>
            <button type="button" (click)="pick(p)" [attr.data-dm-person]="p.displayName">
              <span class="av" aria-hidden="true">{{ p.displayName.charAt(0).toUpperCase() }}</span>
              <span class="who">
                <strong>{{ p.displayName }}</strong>
                <small>{{ p.teams.join(' · ') }}</small>
              </span>
              <mat-icon aria-hidden="true">chat</mat-icon>
            </button>
          </li>
        } @empty {
          <li class="none" data-dm-none>
            {{ (loaded() ? 'dm.pickerNone' : 'common.loading') | transloco }}
          </li>
        }
      </ul>
    </div>
  `,
  styles: `
    .picker {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    input {
      width: 100%;
      box-sizing: border-box;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--surface-1);
      color: var(--text);
      font: inherit;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
      max-height: 50vh;
      overflow: auto;
    }
    li button {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 8px;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    li button:hover,
    li button:focus-visible {
      background: var(--surface-3);
    }
    .av {
      display: grid;
      place-items: center;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: var(--accent);
      color: var(--mat-sys-on-primary);
      font-weight: 700;
      flex: none;
    }
    .who {
      display: flex;
      flex-direction: column;
      min-width: 0;
      flex: 1;
    }
    small {
      color: var(--text-dim);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .none {
      color: var(--text-dim);
      padding: 8px;
    }
  `,
})
export class DmPicker {
  private readonly dms = inject(DmStore);
  private readonly router = inject(Router);
  private readonly notify = inject(Notify);
  protected readonly people = signal<DmPersonDto[]>([]);
  protected readonly loaded = signal(false);
  protected query = '';
  protected readonly search$ = new Subject<string>();

  constructor() {
    this.search$.pipe(debounceTime(200)).subscribe((q) => void this.load(q));
    void this.load('');
  }

  private async load(q: string): Promise<void> {
    try {
      this.people.set(await this.dms.people(q.trim()));
    } catch {
      this.people.set([]);
    }
    this.loaded.set(true);
  }

  protected async pick(p: DmPersonDto): Promise<void> {
    try {
      const dm = await this.dms.start(p.userId);
      await this.router.navigate(['/app/dm', dm.id]);
    } catch (e) {
      // Whatever the reason (a block, a setting, no common team) the answer is the same.
      this.notify.error(isUnreachable(e as never) ? 'common.offlineAction' : 'dm.notAllowed');
    }
  }
}

/** The conversations in the sidebar: who, the last message, unread. */
@Component({
  selector: 'app-dm-sidebar',
  imports: [FormsModule, RouterLink, MatIconModule, TranslocoPipe],
  template: `
    <section class="dms" data-dm-sidebar>
      <header>
        <h2>{{ 'dm.title' | transloco }}</h2>
        <a
          routerLink="/app/dm"
          class="new"
          data-action="new-dm"
          [attr.aria-label]="'dm.new' | transloco"
          [title]="'dm.new' | transloco"
          ><mat-icon>edit_square</mat-icon></a
        >
      </header>
      <input
        type="search"
        name="dmfilter"
        [(ngModel)]="filter"
        [placeholder]="'dm.filter' | transloco"
        [attr.aria-label]="'dm.filter' | transloco"
        autocomplete="off"
        data-dm-filter
      />
      <ul>
        @for (d of shown(); track d.id) {
          <li>
            <a
              [routerLink]="['/app/dm', d.id]"
              [class.on]="nav.url().includes(d.id)"
              [attr.data-dm]="name(d)"
            >
              <span class="av" aria-hidden="true">
                {{ name(d).charAt(0).toUpperCase() }}
                @if (d.peer) {
                  <i
                    class="presence"
                    [class]="'presence ' + presence.statusOf(d.peer.id)"
                    [attr.data-status]="presence.statusOf(d.peer.id)"
                  ></i>
                }
              </span>
              <span class="text">
                <strong [class.unread]="unread(d) > 0">{{ name(d) }}</strong>
                <small>{{ last(d) }}</small>
              </span>
              @if (unread(d) > 0) {
                <span class="badge" data-dm-badge>{{ unread(d) > 99 ? '99+' : unread(d) }}</span>
              }
            </a>
          </li>
        } @empty {
          <li class="none" data-dm-empty>{{ 'dm.empty' | transloco }}</li>
        }
      </ul>
    </section>
  `,
  styles: `
    .dms {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    h2 {
      margin: 0;
      font-size: 15px;
    }
    .new {
      color: inherit;
      display: grid;
      place-items: center;
      width: 32px;
      height: 32px;
      border-radius: 8px;
    }
    .new:hover {
      background: var(--surface-3);
    }
    input {
      width: 100%;
      box-sizing: border-box;
      padding: 7px 10px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--surface-1);
      color: var(--text);
      font: inherit;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    li a {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 7px 8px;
      border-radius: 8px;
      color: inherit;
      text-decoration: none;
    }
    li a:hover,
    li a.on {
      background: var(--surface-3);
    }
    .av {
      position: relative;
      display: grid;
      place-items: center;
      width: 34px;
      height: 34px;
      border-radius: 50%;
      background: var(--accent);
      color: var(--mat-sys-on-primary);
      font-weight: 700;
      flex: none;
    }
    .presence {
      position: absolute;
      right: -1px;
      bottom: -1px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      border: 2px solid var(--surface-2);
      background: var(--text-dim);
    }
    .presence.online {
      background: #2f9e44;
    }
    .presence.idle {
      background: #f08c00;
    }
    .text {
      display: flex;
      flex-direction: column;
      min-width: 0;
      flex: 1;
    }
    strong {
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    strong.unread {
      font-weight: 800;
    }
    small {
      color: var(--text-dim);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .badge {
      min-width: 18px;
      padding: 0 5px;
      border-radius: 9px;
      background: var(--mat-sys-error);
      color: var(--mat-sys-on-error);
      font-size: 11px;
      line-height: 18px;
      text-align: center;
    }
    .none {
      color: var(--text-dim);
      padding: 8px;
    }
  `,
})
export class DmSidebar {
  protected readonly dms = inject(DmStore);
  protected readonly chat = inject(ChatStore);
  protected readonly nav = inject(NavContext);
  protected readonly presence = inject(PresenceStore);
  protected filter = '';
  private readonly teams = inject(TeamStore);
  private readonly lang = inject(Language);

  constructor() {
    // Their presence while the sidebar is showing them (presence is announced per team: watch every team the person is in).
    effect((onCleanup) => {
      const releases = (this.teams.teams() ?? []).map((t) => this.presence.watch(t.id));
      onCleanup(() => releases.forEach((r) => r()));
    });
    untracked(() => void this.dms.refresh());
  }

  protected shown = computed(() => {
    const q = this.filter.trim().toLowerCase();
    return this.dms
      .list()
      .filter((d) => !q || (d.peer?.displayName ?? '').toLowerCase().includes(q));
  });
  protected name(d: DmDto): string {
    return d.peer?.displayName ?? this.lang.t('chat.deletedUser');
  }
  protected unread(d: DmDto): number {
    return this.chat.unreadOf(d.channelId);
  }
  protected last(d: DmDto): string {
    const m = d.lastMessage;
    return !m ? '' : m.deleted ? '' : m.snippet || (m.hasAttachments ? '📎' : '');
  }
}

/** `/app/dm`: nothing chosen yet. Pick somebody to write to. */
@Component({
  selector: 'app-dm-home',
  imports: [TranslocoPipe, DmPicker],
  template: `
    <section class="home" data-dm-home>
      <h1>{{ 'dm.title' | transloco }}</h1>
      <p class="muted">{{ 'dm.homeHint' | transloco }}</p>
      <app-dm-picker />
    </section>
  `,
  styles: `
    .home {
      max-width: 520px;
      margin: 0 auto;
      padding: 24px 16px;
    }
    h1 {
      margin: 0 0 4px;
      font-size: 22px;
    }
    .muted {
      color: var(--text-dim);
      margin: 0 0 16px;
    }
  `,
})
export class DmHome {}

/** `/app/dm/:id`: one conversation. Anyone who is not one of its two people sees the not-found page. */
@Component({
  selector: 'app-dm-page',
  imports: [ChannelPage, NotFoundPage, TranslocoPipe],
  template: `
    @switch (state()) {
      @case ('ready') {
        @if (dm(); as d) {
          <app-channel-page [channelId]="d.channelId" [dm]="d" />
        }
      }
      @case ('missing') {
        <app-not-found />
      }
      @default {
        <p class="loading" role="status">{{ 'common.loading' | transloco }}</p>
      }
    }
  `,
  styles: `
    .loading {
      padding: 24px;
      color: var(--text-dim);
    }
  `,
})
export class DmPage {
  readonly id = input.required<string>();
  private readonly dms = inject(DmStore);
  protected readonly state = signal<'loading' | 'ready' | 'missing'>('loading');
  protected readonly dm = computed(() => this.dms.byId().get(this.id()) ?? null);

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.open(id));
    });
    // A conversation that went away (closed here or on another device) closes the page's content too.
    effect(() => {
      if (this.state() === 'ready' && !this.dm()) untracked(() => void this.open(this.id()));
    });
  }

  private async open(id: string): Promise<void> {
    if (this.dm()) return void this.state.set('ready');
    this.state.set('loading');
    try {
      const found = await this.dms.fetch(id);
      this.state.set(found ? 'ready' : 'missing');
    } catch {
      this.state.set(this.dm() ? 'ready' : 'loading'); // offline: what is cached, or keep waiting
    }
  }
}
