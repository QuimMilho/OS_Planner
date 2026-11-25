import { signal } from '@angular/core';
import { Extension, type Editor } from '@tiptap/core';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';

export interface SlashItem {
  id: string;
  icon: string;
  /** Translation key for the label. */
  labelKey: string;
  /** Extra words that should also find this item (already lower-case, accent-free). */
  keywords: string;
  run: (editor: Editor) => void;
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * State of the "/" command menu. The ProseMirror suggestion plugin drives it; the editor page
 * renders it as an Angular popup next to the caret.
 */
export class SlashState {
  readonly open = signal(false);
  readonly items = signal<SlashItem[]>([]);
  readonly index = signal(0);
  readonly position = signal<{ x: number; y: number }>({ x: 0, y: 0 });
  private command: ((item: SlashItem) => void) | null = null;

  constructor(
    private readonly all: () => SlashItem[],
    private readonly label: (key: string) => string,
  ) {}

  /** Items matching the typed text: label matches first (starts-with before contains), then keyword matches. */
  filter(query: string): SlashItem[] {
    const q = fold(query.trim());
    if (!q) return this.all();
    const rank = (i: SlashItem): number => {
      const label = fold(this.label(i.labelKey));
      return label.startsWith(q) ? 0 : label.includes(q) ? 1 : i.keywords.includes(q) ? 2 : 3;
    };
    return this.all()
      .map((item, order) => ({ item, order, rank: rank(item) }))
      .filter((x) => x.rank < 3)
      .sort((a, b) => a.rank - b.rank || a.order - b.order)
      .map((x) => x.item);
  }

  start(props: SuggestionProps<SlashItem, SlashItem>): void {
    this.update(props);
    this.open.set(true);
  }

  update(props: SuggestionProps<SlashItem, SlashItem>): void {
    this.items.set(props.items);
    this.index.set(0);
    this.command = props.command;
    const rect = props.clientRect?.();
    if (rect) this.position.set({ x: rect.left, y: rect.bottom + 6 });
  }

  key({ event }: SuggestionKeyDownProps): boolean {
    const items = this.items();
    if (!items.length) return false;
    if (event.key === 'ArrowDown') return this.index.set((this.index() + 1) % items.length), true;
    if (event.key === 'ArrowUp') return this.index.set((this.index() - 1 + items.length) % items.length), true;
    if (event.key === 'Enter' || event.key === 'Tab') return this.choose(this.index()), true;
    if (event.key === 'Escape') return this.close(), true;
    return false;
  }

  choose(i: number): void {
    const item = this.items()[i];
    if (item) this.command?.(item);
  }

  close(): void {
    this.open.set(false);
  }
}

/** Typing "/" at the start of a block (or after a space) opens the command menu. */
export const SlashCommand = (state: SlashState) =>
  Extension.create({
    name: 'slashCommand',
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashItem, SlashItem>({
          editor: this.editor,
          char: '/',
          // Multi-word commands ("heading 1") need spaces. A "/" in ordinary text ("and/or") does not
          // open the menu because the trigger must follow a space or start a line.
          allowSpaces: true,
          items: ({ query }) => state.filter(query),
          command: ({ editor, range, props }) => {
            editor.chain().focus().deleteRange(range).run();
            props.run(editor);
          },
          render: () => ({
            onStart: (p) => state.start(p),
            onUpdate: (p) => state.update(p),
            onKeyDown: (p) => state.key(p),
            onExit: () => state.close(),
          }),
        }),
      ];
    },
  });
