import { Component, output } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

/** The emoji people reach for first (one tap on a message). */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '😮', '😢'] as const;

const GROUPS: { id: string; emoji: string[] }[] = [
  {
    id: 'smileys',
    emoji: [
      '😀',
      '😃',
      '😄',
      '😁',
      '😆',
      '😅',
      '🤣',
      '😂',
      '🙂',
      '😉',
      '😊',
      '😇',
      '🥰',
      '😍',
      '🤩',
      '😘',
      '😋',
      '😛',
      '😜',
      '🤪',
      '🤔',
      '🤨',
      '😐',
      '😶',
      '🙄',
      '😏',
      '😴',
      '😌',
      '😔',
      '😢',
      '😭',
      '😤',
      '😡',
      '🤯',
      '😱',
      '😳',
      '🥳',
      '😎',
      '🤓',
      '🤗',
    ],
  },
  {
    id: 'people',
    emoji: [
      '👍',
      '👎',
      '👌',
      '✌️',
      '🤞',
      '🤝',
      '👏',
      '🙌',
      '🙏',
      '💪',
      '👀',
      '🧠',
      '❤️',
      '🧡',
      '💛',
      '💚',
      '💙',
      '💜',
      '🖤',
      '💔',
      '💯',
      '🔥',
      '✨',
      '⭐',
      '⚡',
      '🎉',
      '🎊',
      '🏆',
      '✅',
      '❌',
      '❓',
      '❗',
    ],
  },
  {
    id: 'things',
    emoji: [
      '💻',
      '📱',
      '📌',
      '📎',
      '📝',
      '📅',
      '📊',
      '📈',
      '📦',
      '🔧',
      '🔒',
      '🔑',
      '💡',
      '🚀',
      '🐛',
      '🧪',
      '☕',
      '🍕',
      '🎵',
      '🌍',
      '🌱',
      '☀️',
      '🌧️',
      '🎯',
    ],
  },
];

/** A compact emoji grid: the groups in one scroll, each button inserts its character. */
@Component({
  selector: 'app-emoji-picker',
  imports: [TranslocoPipe],
  template: `
    <div
      class="picker"
      role="dialog"
      [attr.aria-label]="'chat.emoji' | transloco"
      data-emoji-picker
    >
      @for (g of groups; track g.id) {
        <div class="grid">
          @for (e of g.emoji; track e) {
            <button
              type="button"
              class="e"
              [attr.data-emoji]="e"
              [attr.aria-label]="e"
              (click)="picked.emit(e)"
            >
              {{ e }}
            </button>
          }
        </div>
      }
    </div>
  `,
  styles: `
    .picker {
      width: 280px;
      max-height: 220px;
      overflow: auto;
      padding: 6px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(8, 1fr);
      gap: 2px;
      padding-bottom: 6px;
    }
    .e {
      font-size: 20px;
      line-height: 1;
      padding: 5px 0;
      border: 0;
      border-radius: 6px;
      background: none;
      cursor: pointer;
    }
    .e:hover,
    .e:focus-visible {
      background: var(--surface-3);
      outline: none;
    }
  `,
})
export class EmojiPicker {
  readonly groups = GROUPS;
  readonly picked = output<string>();
}
