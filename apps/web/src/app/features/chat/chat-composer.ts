import { HttpClient } from '@angular/common/http';
import {
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { type AttachmentDto, type MessageDto } from '@os-planner/shared';
import { CHAT_LIMITS } from '@os-planner/shared/chat';
import { toProblem } from '../../core/auth-store';
import { Notify } from '../../core/notify';
import { Online } from '../../core/online';
import { chatErrorKey } from '../../data/chat-actions';
import { MentionDirectory, type MentionSuggestion } from '../../data/mention-directory';
import { EmojiPicker } from './emoji-picker';

const CTRL_KEY = 'os_planner.sendWithCtrl';

/** Whether Enter only adds a line (and Ctrl+Enter sends): a per-device choice. */
export const sendWithCtrl = signal(read());
function read(): boolean {
  try {
    return localStorage.getItem(CTRL_KEY) === '1';
  } catch {
    return false;
  }
}
export function setSendWithCtrl(on: boolean): void {
  sendWithCtrl.set(on);
  try {
    localStorage.setItem(CTRL_KEY, on ? '1' : '0');
  } catch {
    /* storage unavailable: the choice lasts until the page is closed */
  }
}

interface Upload {
  key: string;
  name: string;
  state: 'uploading' | 'done' | 'failed';
  attachment?: AttachmentDto;
}

export interface SendEvent {
  content: string;
  attachmentIds: string[];
}

/**
 * The box a message is written in: Markdown with a small toolbar, emoji, files (by button, drag and drop or paste), a banner
 * for the message being replied to or edited, Enter to send (or Ctrl+Enter, a setting), Esc to cancel and ↑ to edit the last
 * message. Files are uploaded as soon as they are chosen; sending the message then claims them.
 */
@Component({
  selector: 'app-chat-composer',
  imports: [FormsModule, MatIconModule, TranslocoPipe, EmojiPicker],
  template: `
    <form
      class="composer"
      (ngSubmit)="submit()"
      (dragover)="onDragOver($event)"
      (drop)="onDrop($event)"
      [class.over]="dragging()"
      data-composer
    >
      @if (replyTo(); as r) {
        <div class="banner" data-reply-banner>
          <mat-icon>reply</mat-icon>
          <span>{{
            'chat.replyingTo'
              | transloco: { name: r.authorName ?? ('chat.deletedUser' | transloco) }
          }}</span>
          <button
            type="button"
            class="x"
            (click)="cancel.emit()"
            [attr.aria-label]="'chat.cancel' | transloco"
          >
            <mat-icon>close</mat-icon>
          </button>
        </div>
      }
      @if (editing()) {
        <div class="banner" data-edit-banner>
          <mat-icon>edit</mat-icon>
          <span>{{ 'chat.editing' | transloco }}</span>
          <button
            type="button"
            class="x"
            (click)="cancel.emit()"
            [attr.aria-label]="'chat.cancel' | transloco"
          >
            <mat-icon>close</mat-icon>
          </button>
        </div>
      }
      @if (uploads().length) {
        <div class="uploads">
          @for (u of uploads(); track u.key) {
            <span class="up" [class.failed]="u.state === 'failed'" [attr.data-upload]="u.state">
              <mat-icon>{{ u.state === 'failed' ? 'error' : 'attach_file' }}</mat-icon>{{ u.name }}
              @if (u.state === 'uploading') {
                <span class="muted">…</span>
              }
              <button
                type="button"
                class="x"
                (click)="removeUpload(u)"
                [attr.aria-label]="'chat.remove' | transloco"
              >
                <mat-icon>close</mat-icon>
              </button>
            </span>
          }
        </div>
      }
      <div class="tools" role="toolbar" [attr.aria-label]="'chat.formatting' | transloco">
        <button
          type="button"
          (click)="wrap('**')"
          [attr.aria-label]="'chat.bold' | transloco"
          [title]="'chat.bold' | transloco"
        >
          <mat-icon>format_bold</mat-icon>
        </button>
        <button
          type="button"
          (click)="wrap('*')"
          [attr.aria-label]="'chat.italic' | transloco"
          [title]="'chat.italic' | transloco"
        >
          <mat-icon>format_italic</mat-icon>
        </button>
        <button
          type="button"
          (click)="wrap('~~')"
          [attr.aria-label]="'chat.strike' | transloco"
          [title]="'chat.strike' | transloco"
        >
          <mat-icon>strikethrough_s</mat-icon>
        </button>
        <button
          type="button"
          (click)="wrap('\`')"
          [attr.aria-label]="'chat.code' | transloco"
          [title]="'chat.code' | transloco"
        >
          <mat-icon>code</mat-icon>
        </button>
        <button
          type="button"
          (click)="link()"
          [attr.aria-label]="'chat.link' | transloco"
          [title]="'chat.link' | transloco"
        >
          <mat-icon>link</mat-icon>
        </button>
        <button
          type="button"
          (click)="prefix('> ')"
          [attr.aria-label]="'chat.quote' | transloco"
          [title]="'chat.quote' | transloco"
        >
          <mat-icon>format_quote</mat-icon>
        </button>
        <button
          type="button"
          (click)="prefix('- ')"
          [attr.aria-label]="'chat.list' | transloco"
          [title]="'chat.list' | transloco"
        >
          <mat-icon>format_list_bulleted</mat-icon>
        </button>
      </div>
      <div class="row">
        @if (suggest(); as s) {
          <ul class="mentions" role="listbox" [attr.aria-label]="'mentions.list' | transloco" data-mention-list>
            @for (item of s.items; track item.token; let i = $index) {
              <li role="option" [attr.aria-selected]="i === s.active">
                <button type="button" [class.on]="i === s.active" (mousedown)="$event.preventDefault()" (click)="choose(item)" [attr.data-mention-option]="item.label">
                  @if (item.kind === 'user') {
                    <i class="dot" [class]="'dot ' + item.status"></i>
                  } @else {
                    <mat-icon [style.color]="item.color">{{ item.kind === 'role' ? 'shield' : 'campaign' }}</mat-icon>
                  }
                  <span [style.color]="item.color">{{ item.label }}</span>
                  @if (item.kind === 'everyone' || item.kind === 'here') {
                    <small>{{ 'mentions.' + item.kind | transloco }}</small>
                  }
                </button>
              </li>
            }
          </ul>
        }
        <textarea
          #box
          name="message"
          rows="1"
          [(ngModel)]="text"
          [disabled]="disabled()"
          [placeholder]="placeholder()"
          [attr.aria-label]="placeholder()"
          [attr.maxlength]="max"
          (keydown)="onKey($event)"
          (input)="grow(); detect()"
          (click)="detect()"
          (blur)="closeSuggest()"
          (paste)="onPaste($event)"
          data-composer-input
        ></textarea>
        @if (!editing()) {
          <button
            type="button"
            class="ic"
            (click)="files.click()"
            [disabled]="!canAttach() || disabled()"
            [attr.aria-label]="'attachment.add' | transloco"
            [title]="(online.isOnline() ? 'attachment.add' : 'attachment.offline') | transloco"
            data-action="attach"
          >
            <mat-icon>attach_file</mat-icon>
          </button>
          <input #files type="file" hidden multiple (change)="pick($event)" data-file-input />
        }
        <button
          type="button"
          class="ic"
          (click)="emoji.set(!emoji())"
          [attr.aria-label]="'chat.emoji' | transloco"
          data-action="emoji"
        >
          <mat-icon>mood</mat-icon>
        </button>
        <button
          type="submit"
          class="send"
          [disabled]="!canSend()"
          [attr.aria-label]="(editing() ? 'chat.save' : 'chat.send') | transloco"
          data-action="send"
        >
          <mat-icon>{{ editing() ? 'check' : 'send' }}</mat-icon>
        </button>
        @if (emoji()) {
          <div class="pop"><app-emoji-picker (picked)="insert($event)" /></div>
        }
      </div>
      @if (text.length > max - 200) {
        <p class="count" [class.over]="text.length >= max">{{ text.length }} / {{ max }}</p>
      }
    </form>
  `,
  styles: `
    .mentions {
      position: absolute;
      left: 8px;
      bottom: calc(100% + 4px);
      z-index: 5;
      margin: 0;
      padding: 4px;
      min-width: 220px;
      max-height: 260px;
      overflow: auto;
      list-style: none;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--surface-2);
      box-shadow: 0 6px 24px rgb(0 0 0 / 0.25);
    }
    .mentions button {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 6px 8px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .mentions button.on,
    .mentions button:hover {
      background: var(--surface-3);
    }
    .mentions small {
      margin-left: auto;
      color: var(--text-dim);
    }
    .mentions mat-icon {
      width: 18px;
      height: 18px;
      font-size: 18px;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--text-dim);
      flex: none;
    }
    .dot.online {
      background: #2f9e44;
    }
    .dot.idle {
      background: #f08c00;
    }
    .composer {
      position: relative;
      margin: 0 12px 12px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--surface);
    }
    .composer.over {
      outline: 2px dashed var(--accent);
    }
    .banner {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      font-size: 13px;
      color: var(--text-dim);
      border-bottom: 1px solid var(--border);
    }
    .banner span {
      flex: 1;
    }
    .x {
      border: 0;
      background: none;
      cursor: pointer;
      color: var(--text-dim);
      display: grid;
      place-items: center;
      padding: 0;
    }
    .x mat-icon {
      font-size: 16px;
      width: 16px;
      height: 16px;
    }
    .uploads {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 6px 8px 0;
    }
    .up {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 8px;
      background: var(--surface-3);
      font-size: 12.5px;
    }
    .up.failed {
      color: var(--mat-sys-error);
    }
    .up mat-icon {
      font-size: 16px;
      width: 16px;
      height: 16px;
    }
    .tools {
      display: flex;
      gap: 2px;
      padding: 4px 6px 0;
    }
    .tools button,
    .ic {
      border: 0;
      background: none;
      cursor: pointer;
      color: var(--text-dim);
      border-radius: 6px;
      display: grid;
      place-items: center;
      padding: 3px;
    }
    .tools button:hover,
    .ic:hover:not(:disabled) {
      background: var(--surface-3);
      color: var(--text);
    }
    .tools mat-icon,
    .ic mat-icon {
      font-size: 20px;
      width: 20px;
      height: 20px;
    }
    .row {
      position: relative;
      display: flex;
      align-items: flex-end;
      gap: 4px;
      padding: 4px 8px 8px;
    }
    textarea {
      flex: 1;
      resize: none;
      border: 0;
      outline: 0;
      background: transparent;
      color: var(--text);
      font: inherit;
      font-size: 14.5px;
      line-height: 1.4;
      max-height: 200px;
      padding: 6px 4px;
    }
    .ic:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .send {
      border: 0;
      border-radius: 8px;
      padding: 6px 8px;
      background: var(--accent);
      color: var(--mat-sys-on-primary);
      cursor: pointer;
      display: grid;
      place-items: center;
    }
    .send:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .send mat-icon {
      font-size: 20px;
      width: 20px;
      height: 20px;
    }
    .pop {
      position: absolute;
      right: 0;
      bottom: 48px;
      z-index: 5;
    }
    .count {
      margin: 0;
      padding: 0 12px 6px;
      text-align: right;
      font-size: 12px;
      color: var(--text-dim);
    }
    .count.over {
      color: var(--mat-sys-error);
    }
    .muted {
      color: var(--text-dim);
    }
  `,
})
export class ChatComposer {
  readonly channelId = input.required<string>();
  readonly placeholder = input('');
  readonly replyTo = input<MessageDto | null>(null);
  /** The message whose text is being changed: the box holds its text, and sending saves it. */
  readonly editing = input<MessageDto | null>(null);
  readonly canAttach = input(true);
  readonly disabled = input(false);
  /** The last message of this person here, for "↑ to edit". */
  readonly lastOwn = input<MessageDto | null>(null);
  /** Mentions are offered in a team's channels, not in conversations. */
  readonly mentionable = input(true);
  /** The person may use @everyone, @here and any role. */
  readonly canMentionEveryone = input(false);

  readonly send = output<SendEvent>();
  readonly save = output<string>();
  readonly cancel = output<void>();
  readonly editLast = output<MessageDto>();

  protected readonly max = CHAT_LIMITS.messageMax;
  protected text = '';
  protected readonly uploads = signal<Upload[]>([]);
  protected readonly emoji = signal(false);
  protected readonly dragging = signal(false);
  protected readonly online = inject(Online);
  private readonly http = inject(HttpClient);
  private readonly notify = inject(Notify);
  private readonly box = viewChild.required<ElementRef<HTMLTextAreaElement>>('box');
  private readonly directory = inject(MentionDirectory);
  private readonly i18n = inject(TranslocoService);
  /** What the person picked from the list: the label in the box, and the token it becomes when the message is sent. */
  private readonly picked = new Map<string, string>();
  protected readonly suggest = signal<{ from: number; items: MentionSuggestion[]; active: number } | null>(null);

  private readonly ready = computed(() => this.uploads().every((u) => u.state !== 'uploading'));
  protected readonly canSend = computed(() => {
    const hasFiles = this.uploads().some((u) => u.state === 'done');
    return this.ready() && !this.disabled() && (this.hasText() || hasFiles);
  });
  private readonly typed = signal('');
  private hasText(): boolean {
    return this.typed().trim().length > 0;
  }

  constructor() {
    // Editing loads the message's text into the box; stopping puts the box back.
    effect(() => {
      const e = this.editing();
      untracked(() => {
        if (e) this.setText(this.decode(e.content));
        else if (this.wasEditing) this.setText('');
        this.wasEditing = e !== null;
        if (e) queueMicrotask(() => this.focus());
      });
    });
    effect(() => {
      // a reply: ready to type
      if (this.replyTo()) untracked(() => queueMicrotask(() => this.focus()));
    });
    effect(() => {
      this.channelId();
      untracked(() => {
        this.uploads.set([]);
        this.picked.clear();
        this.suggest.set(null);
        this.setText('');
      });
    });
  }
  private wasEditing = false;

  focus(): void {
    this.box().nativeElement.focus();
  }

  private setText(value: string): void {
    this.text = value;
    this.typed.set(value);
    queueMicrotask(() => this.grow());
  }

  protected grow(): void {
    const el = this.box().nativeElement;
    this.typed.set(this.text);
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }

  // ---------------------------------------------------------------- keys

  protected onKey(event: KeyboardEvent): void {
    const s = this.suggest();
    if (s) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const n = s.items.length;
        this.suggest.set({ ...s, active: (s.active + (event.key === 'ArrowDown' ? 1 : n - 1)) % n });
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        this.choose(s.items[s.active]!);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        this.suggest.set(null);
        return;
      }
    }
    if (event.key === 'Escape') {
      if (this.emoji()) return void this.emoji.set(false);
      if (this.replyTo() || this.editing() || this.text) {
        event.preventDefault();
        if (this.replyTo() || this.editing()) this.cancel.emit();
        return;
      }
    }
    if (event.key === 'Enter' && !event.isComposing) {
      const wantsSend = sendWithCtrl() ? event.ctrlKey || event.metaKey : !event.shiftKey;
      if (wantsSend) {
        event.preventDefault();
        void this.submit();
      }
      return;
    }
    if (event.key === 'ArrowUp' && !this.text && !this.editing()) {
      const last = this.lastOwn();
      if (last && !last.deletedAt) {
        event.preventDefault();
        this.editLast.emit(last);
      }
    }
  }

  // ---------------------------------------------------------------- mentions

  /** Looks at the word before the caret: an `@` that starts a word opens the list of people, roles and @everyone. */
  protected detect(): void {
    if (!this.mentionable() || this.editing() === undefined) return void this.suggest.set(null);
    const el = this.box().nativeElement;
    const before = this.text.slice(0, el.selectionStart);
    const m = /(?:^|[\s(])@([\p{L}\p{N}_.' -]{0,30})$/u.exec(before);
    if (!m) return void this.suggest.set(null);
    const items = this.directory.suggestions(m[1]!, this.canMentionEveryone());
    if (!items.length) return void this.suggest.set(null);
    const prev = this.suggest();
    this.suggest.set({ from: before.length - m[1]!.length - 1, items, active: Math.min(prev?.active ?? 0, items.length - 1) });
  }

  protected closeSuggest(): void {
    this.suggest.set(null);
  }

  protected choose(item: MentionSuggestion): void {
    const s = this.suggest();
    if (!s) return;
    const el = this.box().nativeElement;
    const caret = el.selectionStart;
    this.picked.set(item.label, item.token);
    const insert = `${item.label} `;
    this.suggest.set(null);
    this.replaceRange(s.from, caret, insert, s.from + insert.length);
  }

  /** The text as it is sent: the names that were picked become tokens (ids, so a rename does not break them). */
  private encode(text: string): string {
    let out = text;
    for (const label of [...this.picked.keys()].sort((a, b) => b.length - a.length)) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`${escaped}(?![\\p{L}\\p{N}_])`, 'gu'), () => this.picked.get(label)!);
    }
    return out;
  }

  /** The text of a message being edited: its tokens read as names again. */
  private decode(content: string): string {
    return content.replace(/<@(user|role):([0-9a-f-]{36})>|<@(everyone|here)>/gi, (token, kind: string, id: string) => {
      const label = this.directory.label(
        (kind ?? token.slice(2, -1)).toLowerCase() as 'user' | 'role' | 'everyone' | 'here',
        id ? id.toLowerCase() : null,
        { user: this.i18n.translate('mentions.someone'), role: this.i18n.translate('mentions.aRole') },
      );
      this.picked.set(label, token.toLowerCase());
      return label;
    });
  }

  // ---------------------------------------------------------------- formatting

  protected wrap(mark: string): void {
    const el = this.box().nativeElement;
    const [a, b] = [el.selectionStart, el.selectionEnd];
    const selected = this.text.slice(a, b) || '';
    this.replaceRange(
      a,
      b,
      `${mark}${selected}${mark}`,
      selected ? a + mark.length + selected.length + mark.length : a + mark.length,
    );
  }

  protected prefix(mark: string): void {
    const el = this.box().nativeElement;
    const start = this.text.lastIndexOf('\n', el.selectionStart - 1) + 1;
    this.replaceRange(start, start, mark, el.selectionStart + mark.length);
  }

  protected link(): void {
    const el = this.box().nativeElement;
    const [a, b] = [el.selectionStart, el.selectionEnd];
    const selected = this.text.slice(a, b) || 'text';
    this.replaceRange(a, b, `[${selected}](https://)`, a + selected.length + 3);
  }

  protected insert(emoji: string): void {
    const el = this.box().nativeElement;
    this.replaceRange(el.selectionStart, el.selectionEnd, emoji, el.selectionStart + emoji.length);
    this.emoji.set(false);
  }

  private replaceRange(from: number, to: number, value: string, caret: number): void {
    this.setText(this.text.slice(0, from) + value + this.text.slice(to));
    queueMicrotask(() => {
      const el = this.box().nativeElement;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }

  // ---------------------------------------------------------------- files

  protected pick(event: Event): void {
    const input = event.target as HTMLInputElement;
    for (const file of Array.from(input.files ?? [])) void this.upload(file);
    input.value = '';
  }

  protected onPaste(event: ClipboardEvent): void {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!files.length || !this.canAttach() || this.editing()) return;
    event.preventDefault();
    for (const file of files) void this.upload(file);
  }

  protected onDragOver(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes('Files') || !this.canAttach() || this.editing()) return;
    event.preventDefault();
    this.dragging.set(true);
  }

  protected onDrop(event: DragEvent): void {
    this.dragging.set(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!files.length || !this.canAttach() || this.editing()) return;
    event.preventDefault();
    for (const file of files) void this.upload(file);
  }

  private async upload(file: File): Promise<void> {
    if (!this.online.isOnline()) return void this.notify.error('attachment.offline');
    if (this.uploads().length >= CHAT_LIMITS.attachmentsPerMessage)
      return void this.notify.error('attachment.tooMany');
    const key = crypto.randomUUID();
    const entry: Upload = { key, name: file.name || 'file', state: 'uploading' };
    this.uploads.update((l) => [...l, entry]);
    const form = new FormData();
    form.append('id', key);
    form.append('name', entry.name);
    form.append('file', file, entry.name);
    try {
      const attachment = await firstValueFrom(
        this.http.post<AttachmentDto>(`/api/channels/${this.channelId()}/attachments`, form),
      );
      this.uploads.update((l) =>
        l.map((u) => (u.key === key ? { ...u, state: 'done', attachment } : u)),
      );
    } catch (e) {
      const problem = toProblem(e);
      this.notify.error(chatErrorKey(problem.code, problem.status));
      this.uploads.update((l) => l.filter((u) => u.key !== key));
    }
  }

  protected removeUpload(u: Upload): void {
    // A file that was uploaded stays on the server until the nightly cleanup: it was never attached to a message.
    this.uploads.update((l) => l.filter((x) => x.key !== u.key));
  }

  // ---------------------------------------------------------------- sending

  protected async submit(): Promise<void> {
    if (!this.canSend()) return;
    if (this.editing()) {
      this.save.emit(this.encode(this.text));
      return;
    }
    const attachmentIds = this.uploads()
      .filter((u) => u.attachment)
      .map((u) => u.attachment!.id);
    this.send.emit({ content: this.encode(this.text), attachmentIds });
    this.uploads.set([]);
    this.picked.clear();
    this.setText('');
    this.emoji.set(false);
  }
}
