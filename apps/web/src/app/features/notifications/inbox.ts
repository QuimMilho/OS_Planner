import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import type { NotificationDto } from '@os-planner/shared';
import { Language } from '../../core/i18n';
import { NotificationStore } from '../../data/notification-store';

interface Group {
  label: string;
  items: NotificationDto[];
}

const ICONS: Record<string, string> = {
  mention_user: 'alternate_email',
  mention_role: 'shield',
  mention_everyone: 'campaign',
  mention_here: 'campaign',
  reply: 'reply',
  dm: 'chat',
  task_assigned: 'assignment_ind',
  task_due: 'event',
  task_comment: 'chat_bubble_outline',
  meeting_invite: 'event_available',
  meeting_reminder: 'alarm',
  meeting_updated: 'edit_calendar',
  meeting_cancelled: 'event_busy',
  meeting_response: 'how_to_reg',
  calendar_sync_off: 'sync_problem',
};

/**
 * The bell in the top bar and the inbox it opens: what mentioned you or wrote to you, newest first, grouped by day, with a
 * filter for mentions only and "mark all as read". Opening one goes to the message and marks it read.
 */
@Component({
  selector: 'app-bell',
  imports: [DatePipe, MatIconModule, TranslocoPipe],
  template: `
    <button
      type="button"
      class="bell"
      (click)="toggle()"
      [attr.aria-label]="'inbox.title' | transloco"
      [attr.aria-expanded]="store.panelOpen()"
      data-bell
    >
      <mat-icon>{{ store.count().unread ? 'notifications_active' : 'notifications' }}</mat-icon>
      @if (store.count().unread > 0) {
        <span class="badge" data-bell-badge>{{
          store.count().unread > 99 ? '99+' : store.count().unread
        }}</span>
      }
    </button>
    <span class="sr-only" aria-live="polite" aria-atomic="true" data-live-notifications>{{ announcement() }}</span>
    @if (store.panelOpen()) {
      <div class="backdrop" (click)="store.panelOpen.set(false)"></div>
      <section
        class="panel"
        role="dialog"
        [attr.aria-label]="'inbox.title' | transloco"
        data-inbox
        (keydown.escape)="store.panelOpen.set(false)"
      >
        <header>
          <h2>{{ 'inbox.title' | transloco }}</h2>
          <span class="grow"></span>
          <button
            type="button"
            class="link"
            (click)="store.markRead('all')"
            [disabled]="!store.count().unread"
            data-action="mark-all-read"
          >
            {{ 'inbox.markAll' | transloco }}
          </button>
        </header>
        <div class="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            [attr.aria-selected]="filter() === 'all'"
            [class.on]="filter() === 'all'"
            (click)="setFilter('all')"
            data-inbox-tab="all"
          >
            {{ 'inbox.all' | transloco }}
          </button>
          <button
            type="button"
            role="tab"
            [attr.aria-selected]="filter() === 'mentions'"
            [class.on]="filter() === 'mentions'"
            (click)="setFilter('mentions')"
            data-inbox-tab="mentions"
          >
            {{ 'inbox.mentions' | transloco }}
          </button>
        </div>
        <div class="list">
          @for (g of groups(); track g.label) {
            <h3>{{ g.label }}</h3>
            @for (n of g.items; track n.id) {
              <button
                type="button"
                class="item"
                [class.unread]="!n.read"
                (click)="open(n)"
                [attr.data-notification]="n.kind"
                [attr.data-unread]="!n.read"
              >
                <mat-icon aria-hidden="true">{{ icon(n) }}</mat-icon>
                <span class="body">
                  <span class="line"
                    >{{
                      'notif.kind.' + n.kind
                        | transloco: { name: n.actorName ?? ('chat.deletedUser' | transloco) }
                    }}
                    @if (n.channelName) {
                      <small> · #{{ n.channelName }}</small>
                    }
                  </span>
                  @if (!n.redacted && n.summary) {
                    <span class="summary">{{ n.summary }}</span>
                  }
                </span>
                <time [attr.datetime]="n.createdAt">{{ n.createdAt | date: 'shortTime' }}</time>
              </button>
            }
          } @empty {
            <p class="empty" data-inbox-empty>
              {{ (store.inboxLoaded() ? 'inbox.empty' : 'common.loading') | transloco }}
            </p>
          }
          @if (store.nextCursor()) {
            <button type="button" class="more" (click)="store.load(true, filter() === 'mentions')">
              {{ 'inbox.more' | transloco }}
            </button>
          }
        </div>
      </section>
    }
  `,
  styles: `
    :host {
      position: relative;
      display: inline-flex;
    }
    .bell {
      position: relative;
      display: grid;
      place-items: center;
      width: 40px;
      height: 40px;
      border: 0;
      border-radius: 50%;
      background: transparent;
      color: inherit;
      cursor: pointer;
    }
    .bell:hover {
      background: var(--surface-3);
    }
    .badge {
      position: absolute;
      right: 2px;
      top: 2px;
      min-width: 17px;
      padding: 0 4px;
      border-radius: 9px;
      background: var(--mat-sys-error);
      color: var(--mat-sys-on-error);
      font-size: 11px;
      line-height: 17px;
      text-align: center;
    }
    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 40;
    }
    .panel {
      position: fixed;
      z-index: 41;
      top: 56px;
      right: 12px;
      width: min(420px, calc(100vw - 24px));
      max-height: min(70vh, 640px);
      display: flex;
      flex-direction: column;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--surface-2);
      box-shadow: 0 10px 40px rgb(0 0 0 / 0.3);
    }
    header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px 4px;
    }
    h2 {
      margin: 0;
      font-size: 16px;
    }
    .grow {
      flex: 1;
    }
    .link {
      border: 0;
      background: none;
      color: var(--accent);
      font: inherit;
      cursor: pointer;
    }
    .link:disabled {
      color: var(--text-dim);
      cursor: default;
    }
    .tabs {
      display: flex;
      gap: 4px;
      padding: 4px 12px;
      border-bottom: 1px solid var(--border);
    }
    .tabs button {
      border: 0;
      background: none;
      color: var(--text-dim);
      font: inherit;
      padding: 4px 10px;
      border-radius: 14px;
      cursor: pointer;
    }
    .tabs button.on {
      background: var(--surface-3);
      color: var(--text);
    }
    .list {
      overflow: auto;
      padding: 4px 6px 8px;
    }
    h3 {
      margin: 8px 6px 2px;
      font-size: 12px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .item {
      display: flex;
      align-items: flex-start;
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
    .item:hover,
    .item:focus-visible {
      background: var(--surface-3);
    }
    .item.unread {
      background: color-mix(in srgb, var(--accent) 10%, transparent);
    }
    .item mat-icon {
      flex: none;
      color: var(--accent);
    }
    .body {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
    }
    .line small {
      color: var(--text-dim);
    }
    .summary {
      color: var(--text-dim);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    time {
      color: var(--text-dim);
      font-size: 12px;
      flex: none;
    }
    .empty {
      color: var(--text-dim);
      padding: 16px;
      text-align: center;
    }
    .more {
      display: block;
      margin: 6px auto;
      border: 0;
      background: none;
      color: var(--accent);
      font: inherit;
      cursor: pointer;
    }
  `,
})
export class Bell {
  protected readonly store = inject(NotificationStore);
  private readonly router = inject(Router);
  private readonly lang = inject(Language);
  protected readonly filter = signal<'all' | 'mentions'>('all');
  /** What a screen reader says when notifications arrive (phase 17): politely, and at most every ten seconds. */
  protected readonly announcement = signal('');
  private lastUnread: number | null = null;
  private announceTimer: ReturnType<typeof setTimeout> | undefined;
  private lastAnnounced = 0;

  protected readonly groups = computed<Group[]>(() => {
    const out: Group[] = [];
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86_400_000).toDateString();
    const items = this.store
      .items()
      .filter(
        (n) => this.filter() === 'all' || n.kind.startsWith('mention_') || n.kind === 'reply',
      );
    for (const n of items) {
      const day = new Date(n.createdAt).toDateString();
      const label =
        day === today
          ? this.lang.t('inbox.today')
          : day === yesterday
            ? this.lang.t('inbox.yesterday')
            : new Date(n.createdAt).toLocaleDateString();
      const last = out.at(-1);
      if (last?.label === label) last.items.push(n);
      else out.push({ label, items: [n] });
    }
    return out;
  });

  constructor() {
    effect(() => {
      const unread = this.store.count().unread;
      untracked(() => this.announceNew(unread));
    });
    // Opening the panel loads the inbox; so does a change of filter.
    effect(() => {
      if (this.store.panelOpen())
        untracked(() => void this.store.load(false, this.filter() === 'mentions'));
    });
  }

  protected toggle(): void {
    this.store.panelOpen.set(!this.store.panelOpen());
  }

  private announceNew(unread: number): void {
    const before = this.lastUnread;
    this.lastUnread = unread;
    if (before === null || unread <= before) return; // the first count, or notifications read: nothing to say
    clearTimeout(this.announceTimer);
    const wait = Math.max(0, this.lastAnnounced + 10_000 - Date.now());
    this.announceTimer = setTimeout(() => {
      this.lastAnnounced = Date.now();
      this.announcement.set(this.lang.t('inbox.announce', { n: this.lastUnread ?? unread }));
    }, wait);
  }

  protected setFilter(f: 'all' | 'mentions'): void {
    this.filter.set(f);
    void this.store.load(false, f === 'mentions');
  }

  protected icon(n: NotificationDto): string {
    return ICONS[n.kind] ?? 'notifications';
  }

  protected async open(n: NotificationDto): Promise<void> {
    this.store.panelOpen.set(false);
    void this.store.markRead([n.id]);
    if (n.targetKind === 'task' && n.targetId) await this.router.navigate(['/app/task', n.targetId]);
    else if (n.targetKind === 'event' && n.targetId) await this.router.navigate(['/app/calendar'], { queryParams: { event: n.targetId } });
    else if (n.targetKind === 'ext_calendar') await this.router.navigate(['/app/settings'], { fragment: 'calendar-sync' });
    else if (n.targetKind === 'dm' && n.targetId) await this.router.navigate(['/app/dm', n.targetId]);
    else if (n.channelId)
      await this.router.navigate(['/app/c', n.channelId], {
        queryParams: n.messageId ? { m: n.messageId } : {},
      });
  }
}
