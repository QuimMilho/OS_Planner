import { HttpClient } from '@angular/common/http';
import {
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { TranslocoPipe } from '@jsverse/transloco';
import { Subject, debounceTime, firstValueFrom } from 'rxjs';
import { Permission, hasPermission, permissionsFromString } from '@os-planner/shared/lite';
import { extractMentions } from '@os-planner/shared/chat';
import type {
  AttachmentDto,
  ChannelUpdatedEvent,
  DmDto,
  MessageDeletedEvent,
  MessageDto,
  MessagePageDto,
  ReactionEvent,
  ThreadEvent,
} from '@os-planner/shared';
import { apiUrl } from '../../core/api-config';
import { AuthStore, isUnreachable, toProblem } from '../../core/auth-store';
import { Language } from '../../core/i18n';
import { uuidv7 } from '../../core/ids';
import { Notify } from '../../core/notify';
import { Online } from '../../core/online';
import { RealtimeService } from '../../core/realtime';
import { ChatActions, chatErrorKey } from '../../data/chat-actions';
import { CACHE_PER_CHANNEL, ChatSender } from '../../data/chat-sender';
import { ChatStore } from '../../data/chat-store';
import { Db } from '../../data/db';
import { liveSignal } from '../../data/live';
import { DmStore } from '../../data/dm-store';
import { MediaStore } from '../../data/media-store';
import { MentionDirectory } from '../../data/mention-directory';
import { PresenceStore } from '../../data/presence-store';
import { openNotifyDialog } from '../notifications/notify-dialog';
import {
  applyReaction,
  pendingMessage,
  sameDay,
  tombstone,
  toViews,
  upsert,
  upsertMany,
  withThread,
} from '../../data/message-state';
import { Dialogs } from '../../shared/dialogs';
import { NotFoundPage } from '../shell/not-found';
import { ChatComposer, type SendEvent } from './chat-composer';
import { ChatMessage, type MessageAction, type MessageView } from './chat-message';
import { Lightbox } from './lightbox';
import { ThreadPanel } from './thread-panel';

type Panel = { kind: 'pins' } | { kind: 'search' } | { kind: 'thread'; id: string } | null;

interface Row {
  view: MessageView;
  /** Set on the first message of a day: the separator drawn above it. */
  day: string | null;
}

const NEAR_BOTTOM = 80;

/**
 * A text channel: the messages (newest at the bottom, older ones on demand), a box to write in, and side panels for threads,
 * pinned messages and search. It opens from what this device already has and then asks the server; while it is open it is in
 * the channel's room, so what others do appears at once, and after a lost connection it asks for what it missed.
 */
@Component({
  selector: 'app-channel-page',
  imports: [
    FormsModule,
    RouterLink,
    MatIconModule,
    MatMenuModule,
    TranslocoPipe,
    NotFoundPage,
    ChatMessage,
    ChatComposer,
    ThreadPanel,
    Lightbox,
  ],
  template: `
    @switch (view()) {
      @case ('missing') {
        <app-not-found />
      }
      @case ('ready') {
        @if (channel(); as ch) {
          <div class="chat" data-channel-page [attr.data-channel]="ch.name">
            <section class="main">
              <header class="top">
                @if (dm(); as d) {
                  <span class="av" aria-hidden="true">
                    {{ peerName().charAt(0).toUpperCase() }}
                    @if (d.peer) { <i class="presence" [class]="'presence ' + presence.statusOf(d.peer.id)" [attr.data-status]="presence.statusOf(d.peer.id)"></i> }
                  </span>
                  <h1 data-channel-name data-dm-name>{{ peerName() }}</h1>
                  @if (d.blocked) { <span class="topic" data-dm-blocked>{{ 'dm.blockedByYou' | transloco }}</span> }
                } @else {
                  <mat-icon aria-hidden="true">tag</mat-icon>
                  <h1 data-channel-name>{{ ch.name }}</h1>
                  @if (ch.topic) {
                    <span class="topic" [title]="ch.topic">{{ ch.topic }}</span>
                  }
                }
                <span class="grow"></span>
                <button
                  type="button"
                  class="ic"
                  (click)="notifySettings(ch.id)"
                  [attr.aria-label]="'notif.open' | transloco"
                  [title]="'notif.open' | transloco"
                  data-action="notifications"
                >
                  <mat-icon>notifications</mat-icon>
                </button>
                @if (dm(); as d) {
                  <button type="button" class="ic" [matMenuTriggerFor]="dmMenu" [attr.aria-label]="'dm.menu' | transloco" data-action="dm-menu"><mat-icon>more_vert</mat-icon></button>
                  <mat-menu #dmMenu="matMenu">
                    <button mat-menu-item type="button" (click)="closeDm(d)" data-action="dm-close"><mat-icon>visibility_off</mat-icon>{{ 'dm.close' | transloco }}</button>
                    @if (d.peer) {
                      <button mat-menu-item type="button" (click)="toggleBlock(d)" data-action="dm-block"><mat-icon>{{ d.blocked ? 'how_to_reg' : 'block' }}</mat-icon>{{ (d.blocked ? 'dm.unblock' : 'dm.block') | transloco }}</button>
                    }
                    <button mat-menu-item type="button" (click)="sharedTeams(d)" data-action="dm-shared"><mat-icon>groups</mat-icon>{{ 'dm.sharedTeams' | transloco }}</button>
                  </mat-menu>
                }
                <button
                  type="button"
                  class="ic"
                  [class.on]="panel()?.kind === 'search'"
                  (click)="toggle({ kind: 'search' })"
                  [attr.aria-label]="'chat.search' | transloco"
                  [title]="'chat.search' | transloco"
                  data-action="search"
                >
                  <mat-icon>search</mat-icon>
                </button>
                <button
                  type="button"
                  class="ic"
                  [class.on]="panel()?.kind === 'pins'"
                  (click)="toggle({ kind: 'pins' })"
                  [attr.aria-label]="'pins.title' | transloco"
                  [title]="'pins.title' | transloco"
                  data-action="pins"
                >
                  <mat-icon>push_pin</mat-icon>
                </button>
                @if (canManage()) {
                  <a
                    class="ic"
                    [routerLink]="['/app/c', ch.id, 'settings']"
                    [attr.aria-label]="'channel.settings' | transloco"
                    [title]="'channel.settings' | transloco"
                    data-action="channel-settings"
                    ><mat-icon>settings</mat-icon></a
                  >
                }
              </header>

              @if (!online.isOnline()) {
                <p class="banner" data-offline-banner>
                  <mat-icon>cloud_off</mat-icon>{{ 'chat.offlineRead' | transloco }}
                </p>
              }
              @if (unreadFrom(); as u) {
                <p class="banner unread" data-unread-banner>
                  <mat-icon>mark_chat_unread</mat-icon
                  >{{ 'chat.unread' | transloco: { n: unreadCount() } }}
                  <button type="button" (click)="jumpToUnread()" data-action="jump-unread">
                    {{ 'chat.jumpUnread' | transloco }}
                  </button>
                  <button
                    type="button"
                    (click)="unreadFrom.set(null)"
                    [attr.aria-label]="'common.close' | transloco"
                  >
                    <mat-icon>close</mat-icon>
                  </button>
                </p>
              }

              <div
                class="scroller"
                #scroller
                (scroll)="onScroll()"
                data-message-list
                tabindex="0"
                [attr.aria-label]="'chat.messages' | transloco"
              >
                @if (hasOlder()) {
                  <button
                    type="button"
                    class="older"
                    (click)="loadOlder()"
                    data-action="load-older"
                  >
                    {{ 'chat.loadOlder' | transloco }}
                  </button>
                }
                @for (row of rows(); track row.view.message.id) {
                  @if (row.day) {
                    <div class="day" role="separator">
                      <span>{{ row.day }}</span>
                    </div>
                  }
                  <app-chat-message
                    [view]="row.view"
                    [permissions]="ch.permissions"
                    [dm]="!!dm()"
                    [token]="token()"
                    [highlight]="row.view.message.id === highlighted()"
                    (act)="onAct(row.view.message, $event)"
                    (open)="lightbox.set($event)"
                  />
                }
                @if (loaded() && !rows().length) {
                  <p class="empty" data-empty>{{ 'chat.empty' | transloco }}</p>
                }
              </div>
              @if (newBelow() > 0) {
                <button
                  type="button"
                  class="below"
                  (click)="scrollToBottom(true)"
                  data-action="jump-latest"
                >
                  <mat-icon>arrow_downward</mat-icon
                  >{{ 'chat.newBelow' | transloco: { n: newBelow() } }}
                </button>
              }

              @if (ch.archived) {
                <p class="notice" data-archived>{{ 'chat.archivedNotice' | transloco }}</p>
              } @else if (!canSend()) {
                <p class="notice">{{ 'chat.noSend' | transloco }}</p>
              } @else {
                <app-chat-composer
                  [channelId]="ch.id"
                  [mentionable]="!dm()"
                  [canMentionEveryone]="canMentionEveryone()"
                  [placeholder]="dm() ? ('dm.placeholder' | transloco: { name: peerName() }) : ('chat.placeholder' | transloco: { name: ch.name })"
                  [replyTo]="replyTo()"
                  [editing]="editing()"
                  [lastOwn]="lastOwn()"
                  [canAttach]="canAttach() && online.isOnline()"
                  (send)="send($event)"
                  (save)="saveEdit($event)"
                  (cancel)="cancelCompose()"
                  (editLast)="editing.set($event); replyTo.set(null)"
                />
              }
            </section>

            @if (panel(); as p) {
              <aside class="panel" data-side-panel [attr.data-panel]="p.kind">
                @switch (p.kind) {
                  @case ('thread') {
                    <app-thread-panel
                      [threadId]="p.id"
                      [channelId]="ch.id"
                      [permissions]="ch.permissions"
                      [token]="token()"
                      (closed)="closePanel()"
                      (open)="lightbox.set($event)"
                    />
                  }
                  @case ('pins') {
                    <header class="phead">
                      <h2>{{ 'pins.title' | transloco }}</h2>
                      <button
                        type="button"
                        class="ic"
                        (click)="closePanel()"
                        [attr.aria-label]="'common.close' | transloco"
                      >
                        <mat-icon>close</mat-icon>
                      </button>
                    </header>
                    <div class="plist">
                      @for (m of pins(); track m.id) {
                        <app-chat-message
                          [view]="{ message: m, pending: null, compact: false }"
                          [permissions]="ch.permissions"
                          [dm]="!!dm()"
                          [token]="token()"
                          [actions]="false"
                          (open)="lightbox.set($event)"
                          (click)="goTo(m.id)"
                        />
                      } @empty {
                        <p class="muted pad" data-no-pins>{{ 'pins.empty' | transloco }}</p>
                      }
                    </div>
                  }
                  @case ('search') {
                    <header class="phead">
                      <h2>{{ 'chat.search' | transloco }}</h2>
                      <button
                        type="button"
                        class="ic"
                        (click)="closePanel()"
                        [attr.aria-label]="'common.close' | transloco"
                      >
                        <mat-icon>close</mat-icon>
                      </button>
                    </header>
                    <input
                      class="q"
                      type="search"
                      name="q"
                      [(ngModel)]="query"
                      (ngModelChange)="search$.next($event)"
                      [placeholder]="'chat.searchPlaceholder' | transloco"
                      autocomplete="off"
                      data-search-input
                    />
                    <div class="plist">
                      @for (m of results(); track m.id) {
                        <app-chat-message
                          [view]="{ message: m, pending: null, compact: false }"
                          [permissions]="ch.permissions"
                          [token]="token()"
                          [actions]="false"
                          (click)="goTo(m.id)"
                        />
                      } @empty {
                        @if (query.trim()) {
                          <p class="muted pad">{{ 'chat.noResults' | transloco }}</p>
                        }
                      }
                    </div>
                  }
                }
              </aside>
            }
          </div>
          @if (lightbox(); as a) {
            <app-lightbox [attachment]="a" [src]="mediaUrl(a)" (closed)="lightbox.set(null)" />
          }
        }
      }
    }
  `,
  styles: `
    :host {
      display: block;
      height: 100%;
    }
    .chat {
      display: flex;
      height: 100%;
      min-height: 0;
    }
    .main {
      position: relative;
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
    }
    .top {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      border-bottom: 1px solid var(--border);
    }
    h1 {
      margin: 0;
      font-size: 17px;
    }
    .topic {
      color: var(--text-dim);
      font-size: 13px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 40%;
      border-left: 1px solid var(--border);
      padding-left: 10px;
    }
    .grow {
      flex: 1;
    }
    .ic {
      border: 0;
      background: none;
      cursor: pointer;
      color: var(--text-dim);
      border-radius: 8px;
      display: grid;
      place-items: center;
      padding: 5px;
      text-decoration: none;
    }
    .ic:hover,
    .ic.on {
      background: var(--surface-3);
      color: var(--text);
    }
    .banner {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0;
      padding: 6px 14px;
      font-size: 13px;
      background: var(--surface-3);
      color: var(--text-dim);
    }
    .banner.unread {
      color: var(--text);
      background: color-mix(in srgb, var(--accent) 16%, var(--surface));
    }
    .banner button {
      border: 0;
      background: none;
      color: var(--accent);
      cursor: pointer;
      display: inline-flex;
      padding: 0;
    }
    .banner mat-icon {
      font-size: 18px;
      width: 18px;
      height: 18px;
    }
    .scroller {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 8px 0 12px;
      outline: none;
    }
    .older {
      display: block;
      margin: 4px auto 8px;
      border: 0;
      background: none;
      color: var(--accent);
      cursor: pointer;
    }
    .day {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 14px 16px 4px;
      color: var(--text-dim);
      font-size: 12px;
    }
    .day::before,
    .day::after {
      content: '';
      flex: 1;
      border-top: 1px solid var(--border);
    }
    .empty {
      text-align: center;
      color: var(--text-dim);
      padding: 48px 16px;
    }
    .below {
      position: absolute;
      right: 24px;
      bottom: 120px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 6px 12px;
      border-radius: 16px;
      border: 0;
      background: var(--accent);
      color: var(--mat-sys-on-primary);
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    }
    .notice {
      margin: 0;
      padding: 12px 16px;
      font-size: 13px;
      color: var(--text-dim);
      border-top: 1px solid var(--border);
    }
    .panel {
      width: min(380px, 42vw);
      flex: none;
      border-left: 1px solid var(--border);
      background: var(--surface);
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    .phead {
      display: flex;
      align-items: center;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
    }
    .phead h2 {
      margin: 0;
      flex: 1;
      font-size: 16px;
    }
    .plist {
      flex: 1;
      overflow: auto;
      padding: 8px 0;
    }
    .pad {
      padding: 12px 16px;
    }
    .q {
      margin: 8px 12px;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      color: var(--text);
      font: inherit;
    }
    @media (max-width: 860px) {
      .panel {
        position: absolute;
        inset: 0;
        width: auto;
        z-index: 20;
      }
    }
  `,
})
export class ChannelPage {
  readonly channelId = input.required<string>();
  /** Set when the channel is a direct-message conversation: the header shows the other person, and a few actions change. */
  readonly dm = input<DmDto | null>(null);
  /** `?m=<id>`: a message to scroll to (a copied link). */
  readonly m = input<string | undefined>(undefined);

  protected readonly chat = inject(ChatStore);
  protected readonly online = inject(Online);
  private readonly rt = inject(RealtimeService);
  private readonly http = inject(HttpClient);
  private readonly dbs = inject(Db);
  private readonly auth = inject(AuthStore);
  private readonly sender = inject(ChatSender);
  private readonly actions = inject(ChatActions);
  private readonly notify = inject(Notify);
  private readonly dialogs = inject(Dialogs);
  private readonly media = inject(MediaStore);
  private readonly lang = inject(Language);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  protected readonly view = signal<'loading' | 'ready' | 'missing'>('loading');
  protected readonly channel = computed(
    () => this.chat.channelById().get(this.channelId()) ?? null,
  );
  private readonly messages = signal<MessageDto[]>([]);
  protected readonly hasOlder = signal(false);
  protected readonly loaded = signal(false);
  protected readonly panel = signal<Panel>(null);
  protected readonly replyTo = signal<MessageDto | null>(null);
  protected readonly editing = signal<MessageDto | null>(null);
  protected readonly lightbox = signal<AttachmentDto | null>(null);
  protected readonly token = signal<string | null>(null);
  protected readonly newBelow = signal(0);
  protected readonly highlighted = signal<string | null>(null);
  protected readonly unreadFrom = signal<string | null>(null);
  protected readonly unreadCount = signal(0);
  protected readonly pins = signal<MessageDto[]>([]);
  protected readonly results = signal<MessageDto[]>([]);
  protected query = '';
  protected readonly search$ = new Subject<string>();

  /** A person who was mentioned but cannot see this channel is not told: the author is warned. */
  private warnMissed(m: MessageDto): void {
    if (this.dm() || m.authorId !== this.auth.userId()) return;
    const missed = extractMentions(m.content).users.filter((id) => !m.mentions.users.includes(id));
    if (missed.length)
      this.notify.info('mentions.cannotSee', {
        names: missed.map((id) => this.directory.userName(id) ?? this.lang.t('mentions.someone')).join(', '),
      });
  }

  private release: (() => void) | null = null;
  private lastSeq = 0n;
  private atBottom = true;
  private readTimer: ReturnType<typeof setTimeout> | undefined;
  private tokenTimer: ReturnType<typeof setInterval> | undefined;
  private flashTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly outbox = liveSignal(this.dbs, (d) => d.chatOutbox.toArray(), []);
  private readonly held = computed(
    () => permissionsFromString(this.channel()?.permissions ?? '0') ?? 0n,
  );
  protected readonly canSend = computed(() => hasPermission(this.held(), Permission.SEND_MESSAGES));
  protected readonly canAttach = computed(() =>
    hasPermission(this.held(), Permission.ATTACH_FILES),
  );
  protected readonly canManage = computed(() =>
    hasPermission(this.held(), Permission.MANAGE_CHANNELS),
  );
  protected readonly canMentionEveryone = computed(() =>
    hasPermission(this.held(), Permission.MENTION_EVERYONE),
  );
  protected readonly presence = inject(PresenceStore);
  private readonly dms = inject(DmStore);
  private readonly dialog = inject(MatDialog);
  private readonly directory = inject(MentionDirectory);
  protected readonly peerName = computed(() => this.dm()?.peer?.displayName ?? this.lang.t('chat.deletedUser'));

  protected notifySettings(channelId: string): void {
    const d = this.dm();
    openNotifyDialog(this.dialog, {
      scope: d ? { scopeKind: 'dm', scopeId: d.id } : { scopeKind: 'channel', scopeId: channelId },
      title: d ? this.peerName() : `#${this.channel()?.name ?? ''}`,
    });
  }

  protected async closeDm(d: DmDto): Promise<void> {
    try {
      await this.dms.setClosed(d, true);
      await this.router.navigate(['/app/dm']);
    } catch {
      this.notify.error('common.offlineAction');
    }
  }

  protected async toggleBlock(d: DmDto): Promise<void> {
    if (!d.peer) return;
    if (!d.blocked && !(await this.dialogs.confirm({ titleKey: 'dm.blockTitle', messageKey: 'dm.blockConfirm', params: { name: this.peerName() }, confirmKey: 'dm.block', danger: true }))) return;
    try {
      await this.dms.block(d.peer.id, !d.blocked);
    } catch {
      this.notify.error('common.offlineAction');
    }
  }

  protected sharedTeams(d: DmDto): void {
    const names = d.sharedTeams.map((t) => t.name).join(', ');
    this.notify.info('dm.sharedTeamsList', { names: names || '–' });
  }

  /** The messages and what is still waiting to be sent, in order, with a separator at each new day. */
  protected readonly rows = computed<Row[]>(() => {
    const me = this.auth.user();
    const have = new Set(this.messages().map((m) => m.id));
    const waiting = this.outbox().filter(
      (r) => r.channelId === this.channelId() && r.threadId === null && !have.has(r.id),
    );
    const all = [
      ...this.messages(),
      ...waiting.map((r) => pendingMessage(r, { id: me?.id ?? '', name: me?.displayName ?? '' })),
    ];
    all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const views = toViews(all, new Map(waiting.map((r) => [r.id, r])));
    return views.map((v, i) => {
      const prev = views[i - 1]?.message;
      const first = !prev || !sameDay(prev.createdAt, v.message.createdAt);
      return {
        view: first ? { ...v, compact: false } : v,
        day: first ? this.lang.date(v.message.createdAt, 'short') : null,
      };
    });
  });

  /** This person's latest message here, for "↑ edits it". */
  protected readonly lastOwn = computed(
    () =>
      [...this.messages()]
        .reverse()
        .find((m) => m.authorId === this.auth.userId() && !m.deletedAt) ?? null,
  );

  constructor() {
    effect(() => {
      const id = this.channelId();
      untracked(() => void this.open(id));
    });
    // The channel itself (name, permissions) comes from the sidebar's data: when it goes, so does the page.
    effect(() => {
      const known = this.channel();
      // (not tied to the active team: when the channel goes, the address no longer says which team it was in)
      if (this.view() === 'ready' && !known) untracked(() => void this.verify());
    });

    const on = <T>(event: string, fn: (payload: T) => void) =>
      this.rt.on<T>(event).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(fn);
    const mine = (e: { channelId: string }): boolean => e.channelId === this.channelId();
    on<MessageDto>('message.created', (m) => mine(m) && !m.threadId && this.incoming(m, true));
    on<MessageDto>('message.updated', (m) => mine(m) && !m.threadId && this.incoming(m, false));
    on<MessageDto>('message.pinned', (m) => mine(m) && this.incoming(m, false));
    on<MessageDto>('message.unpinned', (m) => mine(m) && this.incoming(m, false));
    on<MessageDeletedEvent>(
      'message.deleted',
      (e) => mine(e) && this.change((l) => tombstone(l, e), e.seq),
    );
    on<ReactionEvent>(
      'reaction.added',
      (e) => mine(e) && this.change((l) => applyReaction(l, e, true), e.seq),
    );
    on<ReactionEvent>(
      'reaction.removed',
      (e) => mine(e) && this.change((l) => applyReaction(l, e, false), e.seq),
    );
    on<ThreadEvent>(
      'thread.created',
      (e) => mine(e) && this.change((l) => withThread(l, e.rootMessageId, e.thread)),
    );
    on<ThreadEvent>(
      'thread.updated',
      (e) => mine(e) && this.change((l) => withThread(l, e.rootMessageId, e.thread)),
    );
    on<ChannelUpdatedEvent>(
      'channel.updated',
      (e) => e.channelId === this.channelId() && e.deleted && this.view.set('missing'),
    );
    this.chat.sent.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((m) => {
      if (m.channelId !== this.channelId()) return;
      this.warnMissed(m);
      if (!m.threadId) this.incoming(m, true);
    });
    // The server need not push about the channel that is on screen and in use.
    const focus = () => this.rt.setFocus(document.visibilityState === 'visible' ? this.channelId() : null);
    document.addEventListener('visibilitychange', focus);
    effect(() => {
      this.channelId();
      untracked(focus);
    });
    this.rt.resumed.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => void this.catchUp());
    this.search$
      .pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef))
      .subscribe((q) => void this.runSearch(q));

    const visible = () => document.visibilityState === 'visible' && this.scheduleRead();
    document.addEventListener('visibilitychange', visible);
    this.destroyRef.onDestroy(() => {
      document.removeEventListener('visibilitychange', visible);
      document.removeEventListener('visibilitychange', focus);
      this.rt.setFocus(null);
      this.release?.();
      clearTimeout(this.readTimer);
      clearInterval(this.tokenTimer);
      clearTimeout(this.flashTimer);
      if (this.chat.openChannel() === this.channelId()) this.chat.openChannel.set(null);
    });
  }

  // ---------------------------------------------------------------- opening

  private async open(id: string): Promise<void> {
    this.release?.();
    this.messages.set([]);
    this.hasOlder.set(false);
    this.loaded.set(false);
    this.panel.set(null);
    this.replyTo.set(null);
    this.editing.set(null);
    this.newBelow.set(0);
    this.unreadFrom.set(null);
    this.lastSeq = 0n;
    this.atBottom = true;
    this.view.set(this.channel() ? 'ready' : 'loading');
    this.chat.openChannel.set(id);
    this.release = this.rt.join('channel', id);
    void this.loadToken();

    if (!this.channel()) await this.verify();
    if (this.view() === 'missing') return;

    const db = this.dbs.current();
    if (db) {
      const cached = (
        await db.chatMessages
          .where('channelId')
          .equals(id)
          .filter((m) => !m.threadId)
          .sortBy('id')
      ).slice(-CACHE_PER_CHANNEL);
      if (id === this.channelId() && cached.length) {
        this.messages.set(cached);
        this.lastSeq = cached.reduce((n, m) => (BigInt(m.seq) > n ? BigInt(m.seq) : n), 0n);
        this.scrollToBottom(false);
      }
    }
    await this.loadLatest(id);
    const target = this.m();
    if (target) void this.goTo(target);
  }

  /** The channel is not in the list we have: ask the server whether it exists for this person. */
  private async verify(): Promise<void> {
    try {
      // (a channel opened by address before the sidebar had it is remembered by the store, which is where the page reads it)
      this.view.set((await this.chat.fetch(this.channelId())) ? 'ready' : 'missing');
    } catch {
      // offline and never seen: nothing to show, nothing to say it is gone
      this.view.set(this.channel() ? 'ready' : 'loading');
    }
  }

  private async loadToken(): Promise<void> {
    this.token.set(await this.media.mediaToken());
    clearInterval(this.tokenTimer);
    this.tokenTimer = setInterval(
      () => void this.media.mediaToken().then((t) => this.token.set(t)),
      20 * 60_000,
    );
  }

  private async loadLatest(id: string): Promise<void> {
    try {
      const page = await firstValueFrom(
        this.http.get<MessagePageDto>(`/api/channels/${id}/messages`),
      );
      if (id !== this.channelId()) return;
      // What arrived by event while the request was out stays; the page wins for everything it covers.
      const floor = page.items[0]?.id ?? '';
      this.messages.update((local) =>
        upsertMany(
          page.items,
          local.filter((m) => m.id > floor),
        ),
      );
      this.hasOlder.set(page.hasMore);
      this.lastSeq = BigInt(page.lastSeq) > this.lastSeq ? BigInt(page.lastSeq) : this.lastSeq;
      this.remember(page.items);
      this.view.set('ready');
    } catch (e) {
      const problem = toProblem(e);
      if (!problem.offline && (problem.status === 404 || problem.status === 403))
        this.view.set('missing');
      else if (this.view() === 'loading') this.view.set(this.channel() ? 'ready' : 'loading');
    } finally {
      this.loaded.set(true);
      if (this.view() === 'ready') {
        this.markUnread();
        this.scrollToBottom(false);
        this.scheduleRead();
      }
    }
  }

  /** The "N new messages" banner: shown once per opening, from the first message the person has not read. */
  private markUnread(): void {
    const state = this.chat.unread().get(this.channelId());
    if (!state?.count) return;
    const me = this.auth.userId();
    const first = this.messages().find(
      (m) =>
        (!state.lastReadMessageId || m.id > state.lastReadMessageId) &&
        m.authorId !== me &&
        !m.deletedAt,
    );
    this.unreadFrom.set(first?.id ?? null);
    this.unreadCount.set(state.count > 99 ? 99 : state.count);
  }

  private remember(items: readonly MessageDto[]): void {
    const db = this.dbs.current();
    if (!db || !items.length) return;
    const id = this.channelId();
    void db.chatMessages.bulkPut([...items]).then(async () => {
      const keys = await db.chatMessages.where('channelId').equals(id).primaryKeys();
      const extra = (keys as string[])
        .sort()
        .slice(0, Math.max(0, keys.length - CACHE_PER_CHANNEL));
      if (extra.length) await db.chatMessages.bulkDelete(extra);
    });
  }

  // ---------------------------------------------------------------- what arrives

  private incoming(m: MessageDto, created: boolean): void {
    const known = this.messages().some((x) => x.id === m.id);
    this.change((l) => upsert(l, m), m.seq);
    this.remember([m]);
    if (created && !known) {
      if (this.atBottom) {
        this.scrollToBottom(false);
        this.scheduleRead();
      } else if (m.authorId !== this.auth.userId()) this.newBelow.update((n) => n + 1);
      else this.scrollToBottom(true);
    }
  }

  private change(fn: (list: MessageDto[]) => MessageDto[], seq?: string): void {
    this.messages.update(fn);
    if (seq && BigInt(seq) > this.lastSeq) this.lastSeq = BigInt(seq);
  }

  /** After a lost connection: everything that changed since the last change we saw, edits and deletions too. */
  private async catchUp(): Promise<void> {
    const id = this.channelId();
    if (this.view() !== 'ready') return;
    try {
      for (let guard = 0; guard < 20; guard++) {
        const page = await firstValueFrom(
          this.http.get<MessagePageDto>(`/api/channels/${id}/messages`, {
            params: { since: this.lastSeq.toString() },
          }),
        );
        if (id !== this.channelId()) return;
        this.messages.update((l) => upsertMany(l, page.items));
        this.remember(page.items);
        const top = page.items.reduce(
          (n, m) => (BigInt(m.seq) > n ? BigInt(m.seq) : n),
          this.lastSeq,
        );
        this.lastSeq = page.hasMore ? top : BigInt(page.lastSeq) > top ? BigInt(page.lastSeq) : top;
        if (!page.hasMore) break;
      }
      if (this.atBottom) this.scrollToBottom(false);
    } catch (e) {
      if (!isUnreachable(e) && toProblem(e).status === 404) this.view.set('missing');
    }
  }

  protected async loadOlder(): Promise<void> {
    const first = this.messages()[0];
    if (!first) return;
    const el = this.scroller()?.nativeElement;
    const before = el?.scrollHeight ?? 0;
    try {
      const page = await firstValueFrom(
        this.http.get<MessagePageDto>(`/api/channels/${this.channelId()}/messages`, {
          params: { before: first.id },
        }),
      );
      this.messages.update((l) => upsertMany(l, page.items));
      this.hasOlder.set(page.hasMore);
      this.remember(page.items);
      // keep what the person was looking at where it was
      setTimeout(() => el && (el.scrollTop += el.scrollHeight - before));
    } catch (e) {
      if (!isUnreachable(e)) this.notify.error(chatErrorKey(toProblem(e).code));
    }
  }

  // ---------------------------------------------------------------- scrolling and reading

  protected onScroll(): void {
    const el = this.scroller()?.nativeElement;
    if (!el) return;
    this.atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
    if (this.atBottom) {
      this.newBelow.set(0);
      this.scheduleRead();
    }
    if (el.scrollTop < 120 && this.hasOlder() && this.loaded()) void this.loadOlder();
  }

  protected scrollToBottom(smooth: boolean): void {
    this.atBottom = true;
    this.newBelow.set(0);
    setTimeout(() => {
      const el = this.scroller()?.nativeElement;
      el?.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    });
  }

  /** Tells the server how far the person has read, a moment after they stopped at the bottom of a visible page. */
  private scheduleRead(): void {
    clearTimeout(this.readTimer);
    this.readTimer = setTimeout(() => {
      if (document.visibilityState !== 'visible' || !this.atBottom || this.view() !== 'ready')
        return;
      const waiting = new Set(this.outbox().map((r) => r.id));
      const last = [...this.messages()].reverse().find((m) => !waiting.has(m.id));
      if (!last) return;
      if (this.chat.unread().get(this.channelId())?.lastReadMessageId === last.id) return;
      void this.chat.markRead(this.channelId(), last.id);
      this.unreadFrom.set(null);
    }, 500);
  }

  protected async jumpToUnread(): Promise<void> {
    const id = this.unreadFrom();
    this.unreadFrom.set(null);
    if (id) await this.goTo(id);
  }

  /** Scrolls to a message and marks it for a moment, loading older messages first if it is further up. */
  protected async goTo(id: string): Promise<void> {
    for (
      let guard = 0;
      guard < 6 && !this.messages().some((m) => m.id === id) && this.hasOlder();
      guard++
    ) {
      await this.loadOlder();
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!this.messages().some((m) => m.id === id)) return;
    this.atBottom = false;
    setTimeout(() => {
      this.scroller()
        ?.nativeElement.querySelector(`[data-msg-id="${id}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      this.highlighted.set(id);
      clearTimeout(this.flashTimer);
      this.flashTimer = setTimeout(() => this.highlighted.set(null), 1800);
    }, 60);
  }

  // ---------------------------------------------------------------- composing

  protected async send(e: SendEvent): Promise<void> {
    await this.sender.enqueue({
      id: uuidv7(),
      channelId: this.channelId(),
      threadId: null,
      content: e.content,
      replyToId: this.replyTo()?.id ?? null,
      attachmentIds: e.attachmentIds,
      createdAt: Date.now(),
      state: 'queued',
    });
    this.replyTo.set(null);
    this.scrollToBottom(true);
  }

  protected async saveEdit(content: string): Promise<void> {
    const target = this.editing();
    if (!target) return;
    const updated = await this.actions.edit(target.id, content);
    if (!updated) return;
    this.incoming(updated, false);
    this.editing.set(null);
  }

  protected cancelCompose(): void {
    this.replyTo.set(null);
    this.editing.set(null);
  }

  // ---------------------------------------------------------------- what a person does with a message

  protected async onAct(m: MessageDto, action: MessageAction): Promise<void> {
    const me = this.auth.userId() ?? '';
    switch (action.kind) {
      case 'reply':
        this.editing.set(null);
        this.replyTo.set(m);
        break;
      case 'open-reply':
        if (m.replyToId) await this.goTo(m.replyToId);
        break;
      case 'react': {
        const mine =
          m.reactions.find((r) => r.emoji === action.emoji)?.userIds.includes(me) ?? false;
        await this.actions.react(m.id, action.emoji, !mine);
        break;
      }
      case 'thread':
        await this.openThread(m);
        break;
      case 'pin': {
        const updated = await this.actions.pin(m.id, !m.pinnedAt);
        if (updated) this.incoming(updated, false);
        if (this.panel()?.kind === 'pins') void this.loadPins();
        break;
      }
      case 'edit':
        this.replyTo.set(null);
        this.editing.set(m);
        break;
      case 'delete':
        if (await this.actions.remove(m.id))
          this.change((l) => tombstone(l, { channelId: m.channelId, messageId: m.id, seq: m.seq }));
        break;
      case 'copy-link': {
        const link = `${location.origin}/app/c/${this.channelId()}?m=${m.id}`;
        try {
          await navigator.clipboard.writeText(link);
          this.notify.info('chat.linkCopied');
        } catch {
          this.notify.info('chat.linkCopied');
        }
        break;
      }
      case 'retry':
        await this.sender.retry(m.id);
        break;
      case 'discard':
        await this.sender.discard(m.id);
        break;
    }
  }

  private async openThread(m: MessageDto): Promise<void> {
    if (m.thread) return void this.panel.set({ kind: 'thread', id: m.thread.id });
    const suggestion =
      m.content.replace(/\s+/g, ' ').trim().slice(0, 40) || this.lang.t('thread.defaultName');
    const answer = await this.dialogs.prompt({
      titleKey: 'thread.new',
      labelKey: 'thread.name',
      value: suggestion,
      confirmKey: 'thread.start',
    });
    if (answer?.action !== 'ok' || !answer.value.trim()) return;
    const thread = await this.actions.startThread(m.id, answer.value.trim());
    if (!thread) return;
    this.change((l) => withThread(l, m.id, thread));
    this.panel.set({ kind: 'thread', id: thread.id });
  }

  // ---------------------------------------------------------------- panels

  protected toggle(p: Panel): void {
    const current = this.panel();
    if (current?.kind === p?.kind) return this.closePanel();
    this.panel.set(p);
    if (p?.kind === 'pins') void this.loadPins();
    if (p?.kind === 'search') {
      this.query = '';
      this.results.set([]);
    }
  }

  protected closePanel(): void {
    this.panel.set(null);
  }

  private async loadPins(): Promise<void> {
    try {
      this.pins.set(
        await firstValueFrom(this.http.get<MessageDto[]>(`/api/channels/${this.channelId()}/pins`)),
      );
    } catch {
      /* offline: the list stays as it was */
    }
  }

  private async runSearch(q: string): Promise<void> {
    if (!q.trim()) return void this.results.set([]);
    try {
      this.results.set(
        await firstValueFrom(
          this.http.get<MessageDto[]>(`/api/channels/${this.channelId()}/search`, {
            params: { q },
          }),
        ),
      );
    } catch (e) {
      if (!isUnreachable(e)) this.results.set([]);
    }
  }

  protected mediaUrl(a: AttachmentDto): string {
    const t = this.token();
    return apiUrl(`/api/media/${a.mediaId}${t ? `?t=${encodeURIComponent(t)}` : ''}`);
  }
}
