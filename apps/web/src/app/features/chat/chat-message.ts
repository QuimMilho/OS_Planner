import { DatePipe } from '@angular/common';
import { Component, computed, inject, input, output, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { TranslocoPipe } from '@jsverse/transloco';
import { Permission, hasPermission, permissionsFromString } from '@os-planner/shared/lite';
import type { AttachmentDto, MessageDto } from '@os-planner/shared';
import { apiUrl } from '../../core/api-config';
import { AuthStore } from '../../core/auth-store';
import { Language } from '../../core/i18n';
import { ChatMarkdown } from './chat-markdown';
import { EmojiPicker, QUICK_REACTIONS } from './emoji-picker';
import { MentionDirectory } from '../../data/mention-directory';

/** What the list knows about a message beyond the message itself. */
export interface MessageView {
  message: MessageDto;
  /** Waiting in the outbox (`sending`) or refused by the server (`failed`). */
  pending: 'sending' | 'failed' | null;
  error?: string;
  /** The same person wrote the one above a few minutes ago: no name, no avatar. */
  compact: boolean;
}

export type MessageAction =
  | { kind: 'reply' }
  | { kind: 'react'; emoji: string }
  | { kind: 'thread' }
  | { kind: 'pin' }
  | { kind: 'edit' }
  | { kind: 'delete' }
  | { kind: 'copy-link' }
  | { kind: 'open-reply' }
  | { kind: 'retry' }
  | { kind: 'discard' };

/**
 * One message as it is shown: who and when, the text, the pictures and files, the reactions and the thread under it, and the
 * actions that appear when the pointer is over it. It only reports what was asked (`act`); the page does it.
 */
@Component({
  selector: 'app-chat-message',
  imports: [DatePipe, MatIconModule, MatMenuModule, TranslocoPipe, ChatMarkdown, EmojiPicker],
  template: `
    @let m = view().message;
    <article
      class="msg"
      [class.compact]="view().compact"
      [class.mine]="mine()"
      [class.pending]="!!view().pending"
      [class.failed]="view().pending === 'failed'"
      [class.flash]="highlight()"
      [class.mentioned]="mentionsMe()"
      [attr.data-mentioned]="mentionsMe() ? '' : null"
      [attr.data-msg-id]="m.id"
      [attr.data-state]="view().pending ?? 'sent'"
    >
      @if (!view().compact) {
        <span class="avatar" aria-hidden="true">{{ initial() }}</span>
      } @else {
        <span class="gutter" [title]="m.createdAt | date: 'medium'">{{
          m.createdAt | date: 'shortTime'
        }}</span>
      }

      <div class="body">
        @if (!view().compact) {
          <header>
            <strong class="author" data-author>{{
              m.authorName ?? ('chat.deletedUser' | transloco)
            }}</strong>
            <time [attr.datetime]="m.createdAt" [title]="m.createdAt | date: 'medium'">{{
              m.createdAt | date: 'shortTime'
            }}</time>
            @if (m.pinnedAt) {
              <mat-icon class="pin" [attr.title]="'chat.pinned' | transloco">push_pin</mat-icon>
            }
          </header>
        }

        @if (m.replyTo; as r) {
          <button
            type="button"
            class="reply"
            (click)="act.emit({ kind: 'open-reply' })"
            data-reply-preview
          >
            <mat-icon>subdirectory_arrow_right</mat-icon>
            @if (r.deleted) {
              <em>{{ 'chat.deleted' | transloco }}</em>
            } @else {
              <strong>{{ r.authorName ?? ('chat.deletedUser' | transloco) }}</strong>
              <span>{{ r.snippet }}</span>
            }
          </button>
        }

        @if (m.deletedAt) {
          <p class="tomb" data-deleted>{{ 'chat.deleted' | transloco }}</p>
        } @else {
          @if (m.content) {
            <div class="text" data-text>
              <app-chat-markdown [text]="m.content" [mentions]="m.mentions" />
              @if (m.editedAt) {
                <span class="edited" [title]="m.editedAt | date: 'medium'">{{
                  'chat.edited' | transloco
                }}</span>
              }
            </div>
          }
          @if (m.attachments.length) {
            <div class="files">
              @for (a of m.attachments; track a.id) {
                @if (a.kind === 'image') {
                  <button
                    type="button"
                    class="pic"
                    [attr.data-attachment]="a.name"
                    (click)="open.emit(a)"
                    [attr.aria-label]="a.name"
                  >
                    <img
                      [src]="url(a)"
                      [alt]="a.name"
                      [attr.width]="a.width"
                      [attr.height]="a.height"
                      loading="lazy"
                    />
                  </button>
                } @else {
                  <a
                    class="chip"
                    [href]="url(a)"
                    target="_blank"
                    rel="noopener noreferrer"
                    [attr.download]="a.name"
                    [attr.data-attachment]="a.name"
                  >
                    <mat-icon>{{ 'attach_file' }}</mat-icon>{{ a.name
                    }}<span class="size">{{ size(a.size) }}</span>
                  </a>
                }
              }
            </div>
          }
          @if (m.reactions.length) {
            <div class="reactions">
              @for (r of m.reactions; track r.emoji) {
                <button
                  type="button"
                  class="rx"
                  [class.on]="r.userIds.includes(me())"
                  [attr.data-reaction]="r.emoji"
                  (click)="act.emit({ kind: 'react', emoji: r.emoji })"
                  [attr.aria-pressed]="r.userIds.includes(me())"
                >
                  <span>{{ r.emoji }}</span><span class="n">{{ r.count }}</span>
                </button>
              }
            </div>
          }
          @if (m.thread; as t) {
            <button
              type="button"
              class="thread"
              (click)="act.emit({ kind: 'thread' })"
              data-thread-chip
            >
              <mat-icon>forum</mat-icon><strong>{{ t.name }}</strong>
              <span>{{ 'thread.replies' | transloco: { n: t.replyCount } }}</span>
              @if (t.archived) {
                <em>{{ 'thread.archived' | transloco }}</em>
              }
            </button>
          }
        }

        @if (view().pending === 'sending') {
          <p class="state" data-sending>{{ 'chat.sending' | transloco }}</p>
        } @else if (view().pending === 'failed') {
          <p class="state err" data-failed>
            {{ 'chat.failed' | transloco }}
            @if (view().error === 'dm_not_allowed') {
              <span data-failed-reason>{{ 'dm.notAllowed' | transloco }}</span>
            }
            <button type="button" (click)="act.emit({ kind: 'retry' })">
              {{ 'chat.retry' | transloco }}
            </button>
            <button type="button" (click)="act.emit({ kind: 'discard' })">
              {{ 'chat.discard' | transloco }}
            </button>
          </p>
        }
      </div>

      @if (!view().pending && !m.deletedAt && actions()) {
        <div class="bar" role="toolbar" [attr.aria-label]="'chat.actions' | transloco">
          @if (canReact()) {
            @for (e of quick; track e) {
              <button
                type="button"
                class="q"
                [attr.aria-label]="e"
                (click)="act.emit({ kind: 'react', emoji: e })"
              >
                {{ e }}
              </button>
            }
            <button
              type="button"
              class="ic"
              [attr.aria-label]="'chat.react' | transloco"
              (click)="picker.set(!picker())"
              data-action="react"
            >
              <mat-icon>add_reaction</mat-icon>
            </button>
          }
          <button
            type="button"
            class="ic"
            [attr.aria-label]="'chat.reply' | transloco"
            (click)="act.emit({ kind: 'reply' })"
            data-action="reply"
          >
            <mat-icon>reply</mat-icon>
          </button>
          @if (canThread()) {
            <button
              type="button"
              class="ic"
              [attr.aria-label]="'chat.thread' | transloco"
              (click)="act.emit({ kind: 'thread' })"
              data-action="thread"
            >
              <mat-icon>forum</mat-icon>
            </button>
          }
          <button
            type="button"
            class="ic"
            [attr.aria-label]="'chat.more' | transloco"
            [matMenuTriggerFor]="menu"
            data-action="more"
          >
            <mat-icon>more_horiz</mat-icon>
          </button>
          <mat-menu #menu="matMenu">
            @if (canPin()) {
              <button
                mat-menu-item
                type="button"
                (click)="act.emit({ kind: 'pin' })"
                data-action="pin"
              >
                <mat-icon>push_pin</mat-icon
                >{{ (m.pinnedAt ? 'chat.unpin' : 'chat.pin') | transloco }}
              </button>
            }
            <button
              mat-menu-item
              type="button"
              (click)="act.emit({ kind: 'copy-link' })"
              data-action="copy-link"
            >
              <mat-icon>link</mat-icon>{{ 'chat.copyLink' | transloco }}
            </button>
            @if (mine()) {
              <button
                mat-menu-item
                type="button"
                (click)="act.emit({ kind: 'edit' })"
                data-action="edit"
              >
                <mat-icon>edit</mat-icon>{{ 'chat.edit' | transloco }}
              </button>
            }
            @if (mine() || canModerate()) {
              <button
                mat-menu-item
                type="button"
                (click)="act.emit({ kind: 'delete' })"
                data-action="delete"
              >
                <mat-icon>delete</mat-icon>{{ 'common.delete' | transloco }}
              </button>
            }
          </mat-menu>
          @if (picker()) {
            <div class="pop">
              <app-emoji-picker
                (picked)="picker.set(false); act.emit({ kind: 'react', emoji: $event })"
              />
            </div>
          }
        </div>
      }
    </article>
  `,
  styles: `
    :host {
      display: block;
    }
    .msg {
      position: relative;
      display: flex;
      gap: 10px;
      padding: 3px 16px 3px 12px;
    }
    .msg:hover,
    .msg:focus-within {
      background: color-mix(in srgb, var(--surface-3) 60%, transparent);
    }
    .msg:not(.compact) {
      margin-top: 10px;
    }
    .msg.mentioned {
      background: color-mix(in srgb, var(--accent) 10%, transparent);
      box-shadow: inset 3px 0 0 var(--accent);
    }
    .msg.flash {
      animation: flash 1.6s ease-out;
    }
    .msg.pending {
      opacity: 0.7;
    }
    .msg.failed {
      opacity: 1;
    }
    @keyframes flash {
      from {
        background: color-mix(in srgb, var(--accent) 30%, transparent);
      }
    }
    .avatar {
      flex: none;
      display: grid;
      place-items: center;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: var(--accent);
      color: var(--mat-sys-on-primary);
      font-weight: 600;
      margin-top: 2px;
    }
    .gutter {
      flex: none;
      width: 36px;
      text-align: right;
      font-size: 11px;
      color: var(--text-dim);
      opacity: 0;
      padding-top: 4px;
    }
    .msg:hover .gutter {
      opacity: 1;
    }
    .body {
      flex: 1;
      min-width: 0;
    }
    header {
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    .author {
      font-size: 14px;
    }
    time {
      font-size: 12px;
      color: var(--text-dim);
    }
    .pin {
      font-size: 14px;
      width: 14px;
      height: 14px;
      color: var(--accent);
      align-self: center;
    }
    .text {
      font-size: 14.5px;
    }
    .edited {
      font-size: 11px;
      color: var(--text-dim);
      margin-left: 4px;
    }
    .tomb {
      margin: 0;
      color: var(--text-dim);
      font-style: italic;
      font-size: 14px;
    }
    .reply {
      display: flex;
      align-items: center;
      gap: 6px;
      max-width: 100%;
      border: 0;
      background: none;
      padding: 0 0 2px;
      color: var(--text-dim);
      font-size: 12.5px;
      cursor: pointer;
      text-align: left;
      overflow: hidden;
      white-space: nowrap;
    }
    .reply span {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .reply mat-icon {
      font-size: 16px;
      width: 16px;
      height: 16px;
      transform: scaleY(-1);
    }
    .files {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 4px;
    }
    .pic {
      padding: 0;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--surface-3);
      cursor: zoom-in;
      overflow: hidden;
      max-width: min(420px, 100%);
    }
    .pic img {
      display: block;
      max-width: 100%;
      max-height: 320px;
      width: auto;
      height: auto;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border: 1px solid var(--border);
      border-radius: 10px;
      color: var(--text);
      text-decoration: none;
      font-size: 13px;
    }
    .chip mat-icon {
      font-size: 18px;
      width: 18px;
      height: 18px;
    }
    .size {
      color: var(--text-dim);
      font-size: 12px;
    }
    .reactions {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 4px;
    }
    .rx {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 1px 8px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: var(--surface-3);
      cursor: pointer;
      font-size: 13px;
      color: var(--text);
    }
    .rx.on {
      border-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 18%, transparent);
    }
    .n {
      font-size: 12px;
    }
    .thread {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-top: 4px;
      padding: 3px 10px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: none;
      color: var(--accent);
      cursor: pointer;
      font-size: 13px;
    }
    .thread mat-icon {
      font-size: 16px;
      width: 16px;
      height: 16px;
    }
    .thread span {
      color: var(--text-dim);
    }
    .state {
      margin: 2px 0 0;
      font-size: 12px;
      color: var(--text-dim);
    }
    .state.err {
      color: var(--mat-sys-error);
    }
    .state button {
      border: 0;
      background: none;
      color: var(--accent);
      cursor: pointer;
      text-decoration: underline;
      padding: 0 4px;
    }
    .bar {
      position: absolute;
      right: 12px;
      top: -14px;
      display: none;
      align-items: center;
      gap: 1px;
      padding: 2px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      z-index: 2;
    }
    .msg:hover .bar,
    .msg:focus-within .bar {
      display: flex;
    }
    .bar button {
      border: 0;
      background: none;
      cursor: pointer;
      border-radius: 6px;
      color: var(--text);
      display: grid;
      place-items: center;
      padding: 3px 4px;
    }
    .bar button:hover {
      background: var(--surface-3);
    }
    .bar .q {
      font-size: 16px;
    }
    .bar mat-icon {
      font-size: 20px;
      width: 20px;
      height: 20px;
    }
    .pop {
      position: absolute;
      right: 0;
      top: 36px;
      z-index: 5;
    }
    @media (hover: none) {
      .bar {
        display: flex;
        position: static;
        box-shadow: none;
        border: 0;
        margin-left: auto;
      }
    }
  `,
})
export class ChatMessage {
  readonly view = input.required<MessageView>();
  /** What the person may do in the channel (decimal string of the permission bit field). */
  readonly permissions = input<string>('0');
  /** False in places where actions make no sense (search results). */
  readonly actions = input(true);
  readonly highlight = input(false);
  /** The message is itself a thread's first message, or inside one: no thread button. */
  readonly inThread = input(false);
  /** A direct message: either person pins, and nobody deletes what the other said. */
  readonly dm = input(false);

  readonly act = output<MessageAction>();
  readonly open = output<AttachmentDto>();
  /** A short-lived token for the files (they are plain `<img>`/links, which cannot send a header). */
  readonly token = input<string | null>(null);

  protected readonly quick = QUICK_REACTIONS;
  protected readonly picker = signal(false);
  private readonly auth = inject(AuthStore);
  private readonly lang = inject(Language);

  protected readonly me = computed(() => this.auth.userId() ?? '');
  protected readonly mine = computed(() => this.view().message.authorId === this.me());
  protected readonly initial = computed(() =>
    (this.view().message.authorName ?? '?').trim().charAt(0).toUpperCase(),
  );
  private readonly held = computed(() => permissionsFromString(this.permissions()) ?? 0n);
  protected readonly canReact = computed(() =>
    hasPermission(this.held(), Permission.ADD_REACTIONS),
  );
  protected readonly canThread = computed(
    () =>
      !this.inThread() &&
      !this.view().message.thread &&
      hasPermission(this.held(), Permission.CREATE_THREADS),
  );
  protected readonly canPin = computed(
    () => this.dm() || hasPermission(this.held(), Permission.MANAGE_MESSAGES),
  );
  protected readonly canModerate = computed(
    () => !this.dm() && hasPermission(this.held(), Permission.MANAGE_MESSAGES),
  );
  private readonly directory = inject(MentionDirectory);
  /** The message is about this person: their name, a role they hold, or everybody (never their own message). */
  protected readonly mentionsMe = computed(() => {
    const m = this.view().message;
    if (m.deletedAt || this.mine()) return false;
    return (
      m.mentions.everyone ||
      m.mentions.here ||
      m.mentions.users.includes(this.me()) ||
      m.mentions.roles.some((r) => this.directory.inRole(r))
    );
  });

  protected url(a: AttachmentDto): string {
    const t = this.token();
    return apiUrl(`/api/media/${a.mediaId}${t ? `?t=${encodeURIComponent(t)}` : ''}`);
  }

  protected size(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  /** Kept so the language service is created with the component (dates follow the active language). */
  protected readonly language = this.lang;
}
