import { HttpClient } from '@angular/common/http';
import {
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  DestroyRef,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { Permission, hasPermission, permissionsFromString } from '@os-planner/shared/lite';
import type {
  AttachmentDto,
  MessageDeletedEvent,
  MessageDto,
  ReactionEvent,
  ThreadEvent,
  ThreadPageDto,
  ThreadSummaryDto,
} from '@os-planner/shared';
import { AuthStore, toProblem } from '../../core/auth-store';
import { uuidv7 } from '../../core/ids';
import { Notify } from '../../core/notify';
import { RealtimeService } from '../../core/realtime';
import { ChatActions, chatErrorKey } from '../../data/chat-actions';
import { ChatSender } from '../../data/chat-sender';
import { ChatStore } from '../../data/chat-store';
import { Db } from '../../data/db';
import { liveSignal } from '../../data/live';
import {
  applyReaction,
  pendingMessage,
  tombstone,
  toViews,
  upsert,
  upsertMany,
} from '../../data/message-state';
import { ChatComposer, type SendEvent } from './chat-composer';
import { ChatMessage, type MessageAction } from './chat-message';

/**
 * A thread beside the channel: the message it started from, its replies, and a box to answer. Replies are live (the panel is
 * in the thread's room while it is open) and go through the same outbox as channel messages.
 */
@Component({
  selector: 'app-thread-panel',
  imports: [MatIconModule, TranslocoPipe, ChatMessage, ChatComposer],
  template: `
    <section class="thread" data-thread-panel [attr.data-thread]="threadId()">
      <header>
        <mat-icon>forum</mat-icon>
        <h2>{{ thread()?.name ?? '' }}</h2>
        @if (thread() && canArchive()) {
          <button type="button" (click)="toggleArchive()" data-action="archive-thread">
            {{ (thread()!.archived ? 'thread.unarchive' : 'thread.archive') | transloco }}
          </button>
        }
        <button
          type="button"
          class="x"
          (click)="closed.emit()"
          [attr.aria-label]="'common.close' | transloco"
          data-action="close-panel"
        >
          <mat-icon>close</mat-icon>
        </button>
      </header>
      <div class="list">
        @if (root(); as r) {
          <app-chat-message
            [view]="{ message: r, pending: null, compact: false }"
            [permissions]="permissions()"
            [token]="token()"
            [actions]="false"
            [inThread]="true"
            (open)="open.emit($event)"
          />
          <hr />
        }
        @if (hasOlder()) {
          <button type="button" class="older" (click)="loadOlder()">
            {{ 'chat.loadOlder' | transloco }}
          </button>
        }
        @for (v of views(); track v.message.id) {
          <app-chat-message
            [view]="v"
            [permissions]="permissions()"
            [token]="token()"
            [inThread]="true"
            (act)="onAct(v.message, $event)"
            (open)="open.emit($event)"
          />
        }
        @if (!views().length && ready()) {
          <p class="muted empty">{{ 'thread.empty' | transloco }}</p>
        }
      </div>
      @if (thread()?.archived) {
        <p class="notice" data-thread-archived>{{ 'thread.archivedNotice' | transloco }}</p>
      } @else if (!canSend()) {
        <p class="notice">{{ 'chat.noSend' | transloco }}</p>
      } @else {
        <app-chat-composer
          [channelId]="channelId()"
          [placeholder]="'thread.placeholder' | transloco"
          [canAttach]="false"
          [editing]="editing()"
          (send)="send($event)"
          (save)="saveEdit($event)"
          (cancel)="editing.set(null)"
        />
      }
    </section>
  `,
  styles: `
    :host {
      display: contents;
    }
    .thread {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
    }
    header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
    }
    h2 {
      margin: 0;
      flex: 1;
      font-size: 16px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    header button {
      border: 0;
      background: none;
      cursor: pointer;
      color: var(--accent);
    }
    header .x {
      color: var(--text-dim);
      display: grid;
      place-items: center;
    }
    .list {
      flex: 1;
      overflow: auto;
      padding: 8px 0;
    }
    hr {
      border: 0;
      border-top: 1px solid var(--border);
      margin: 8px 12px;
    }
    .older {
      display: block;
      margin: 4px auto;
      border: 0;
      background: none;
      color: var(--accent);
      cursor: pointer;
    }
    .empty {
      padding: 12px 16px;
      font-size: 13px;
    }
    .notice {
      margin: 0;
      padding: 10px 14px;
      font-size: 13px;
      color: var(--text-dim);
      border-top: 1px solid var(--border);
    }
  `,
})
export class ThreadPanel {
  readonly threadId = input.required<string>();
  readonly channelId = input.required<string>();
  readonly permissions = input<string>('0');
  readonly token = input<string | null>(null);
  readonly closed = output<void>();
  readonly open = output<AttachmentDto>();

  private readonly http = inject(HttpClient);
  private readonly rt = inject(RealtimeService);
  private readonly auth = inject(AuthStore);
  private readonly dbs = inject(Db);
  private readonly sender = inject(ChatSender);
  private readonly store = inject(ChatStore);
  private readonly actions = inject(ChatActions);
  private readonly notify = inject(Notify);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly root = signal<MessageDto | null>(null);
  protected readonly thread = signal<ThreadSummaryDto | null>(null);
  private readonly messages = signal<MessageDto[]>([]);
  protected readonly hasOlder = signal(false);
  protected readonly ready = signal(false);
  protected readonly editing = signal<MessageDto | null>(null);
  private release: (() => void) | null = null;

  private readonly outbox = liveSignal(this.dbs, (d) => d.chatOutbox.toArray(), []);
  private readonly held = computed(() => permissionsFromString(this.permissions()) ?? 0n);
  protected readonly canSend = computed(() =>
    hasPermission(this.held(), Permission.SEND_IN_THREADS),
  );
  protected readonly canArchive = computed(
    () =>
      hasPermission(this.held(), Permission.MANAGE_MESSAGES) ||
      this.root()?.authorId === this.auth.userId(),
  );

  protected readonly views = computed(() => {
    const me = this.auth.user();
    const have = new Set(this.messages().map((m) => m.id));
    const waiting = this.outbox().filter((r) => r.threadId === this.threadId() && !have.has(r.id));
    const all = [
      ...this.messages(),
      ...waiting.map((r) => pendingMessage(r, { id: me?.id ?? '', name: me?.displayName ?? '' })),
    ];
    all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return toViews(all, new Map(waiting.map((r) => [r.id, r])));
  });

  constructor() {
    effect((onCleanup) => {
      const id = this.threadId();
      untracked(() => {
        this.root.set(null);
        this.thread.set(null);
        this.messages.set([]);
        this.ready.set(false);
        this.editing.set(null);
        this.release?.();
        this.release = this.rt.join('thread', id);
        void this.load(id);
      });
      onCleanup(() => this.release?.());
    });

    const on = <T>(event: string, fn: (payload: T) => void) =>
      this.rt.on<T>(event).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(fn);
    on<MessageDto>(
      'message.created',
      (m) => m.threadId === this.threadId() && this.messages.update((l) => upsert(l, m)),
    );
    on<MessageDto>(
      'message.updated',
      (m) => m.threadId === this.threadId() && this.messages.update((l) => upsert(l, m)),
    );
    on<MessageDeletedEvent>('message.deleted', (e) => this.messages.update((l) => tombstone(l, e)));
    on<ReactionEvent>('reaction.added', (e) => this.reacted(e, true));
    on<ReactionEvent>('reaction.removed', (e) => this.reacted(e, false));
    on<ThreadEvent>(
      'thread.updated',
      (e) => e.thread.id === this.threadId() && this.thread.set(e.thread),
    );
    this.store.sent
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(
        (m) => m.threadId === this.threadId() && this.messages.update((l) => upsert(l, m)),
      );
    this.rt.resumed
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => void this.load(this.threadId()));
  }

  private reacted(e: ReactionEvent, added: boolean): void {
    this.messages.update((l) => applyReaction(l, e, added));
    const r = this.root();
    if (r && r.id === e.messageId) this.root.set(applyReaction([r], e, added)[0]!);
  }

  private async load(id: string): Promise<void> {
    try {
      const page = await firstValueFrom(
        this.http.get<ThreadPageDto>(`/api/threads/${id}/messages`),
      );
      if (id !== this.threadId()) return;
      this.root.set(page.root);
      this.thread.set(page.thread);
      this.messages.update((l) =>
        upsertMany(
          page.items,
          l.filter((m) => m.id > (page.items[0]?.id ?? '~')),
        ),
      );
      this.hasOlder.set(page.hasMore);
    } catch (e) {
      const problem = toProblem(e);
      if (!problem.offline) this.closed.emit(); // the thread is gone, or it is no longer ours to see
    } finally {
      this.ready.set(true);
    }
  }

  protected async loadOlder(): Promise<void> {
    const first = this.messages()[0];
    if (!first) return;
    try {
      const page = await firstValueFrom(
        this.http.get<ThreadPageDto>(`/api/threads/${this.threadId()}/messages`, {
          params: { before: first.id },
        }),
      );
      this.messages.update((l) => upsertMany(l, page.items));
      this.hasOlder.set(page.hasMore);
    } catch (e) {
      this.notify.error(chatErrorKey(toProblem(e).code));
    }
  }

  protected async send(e: SendEvent): Promise<void> {
    await this.sender.enqueue({
      id: uuidv7(),
      channelId: this.channelId(),
      threadId: this.threadId(),
      content: e.content,
      replyToId: null,
      attachmentIds: e.attachmentIds,
      createdAt: Date.now(),
      state: 'queued',
    });
  }

  protected async saveEdit(content: string): Promise<void> {
    const target = this.editing();
    if (!target) return;
    const updated = await this.actions.edit(target.id, content);
    if (updated) {
      this.messages.update((l) => upsert(l, updated));
      this.editing.set(null);
    }
  }

  protected async toggleArchive(): Promise<void> {
    const t = this.thread();
    if (!t) return;
    const updated = await this.actions.setThreadArchived(t.id, !t.archived);
    if (updated) this.thread.set(updated);
  }

  protected async onAct(m: MessageDto, action: MessageAction): Promise<void> {
    const me = this.auth.userId() ?? '';
    switch (action.kind) {
      case 'react': {
        const mine =
          m.reactions.find((r) => r.emoji === action.emoji)?.userIds.includes(me) ?? false;
        await this.actions.react(m.id, action.emoji, !mine);
        break;
      }
      case 'edit':
        this.editing.set(m);
        break;
      case 'delete':
        if (await this.actions.remove(m.id))
          this.messages.update((l) =>
            tombstone(l, { channelId: m.channelId, messageId: m.id, seq: m.seq }),
          );
        break;
      case 'retry':
        await this.sender.retry(m.id);
        break;
      case 'discard':
        await this.sender.discard(m.id);
        break;
      default:
        break;
    }
  }
}
