import { Component, computed, effect, input, output, signal } from '@angular/core';
import type { Editor } from '@tiptap/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslocoPipe } from '@jsverse/transloco';
import type { SlashItem } from './slash';
import './tiptap-types';

interface MarkButton {
  icon: string;
  mark: string;
  label: string;
  run: (e: Editor) => void;
}

const COLORS = ['#e03131', '#e8590c', '#f08c00', '#2f9e44', '#1098ad', '#3b5bdb', '#ae3ec9', '#868e96', '#000000'];
const HIGHLIGHTS = ['#fff3bf', '#ffd8a8', '#ffc9c9', '#d3f9d8', '#c5f6fa', '#d0ebff', '#e5dbff', '#dee2e6'];

@Component({
  selector: 'app-toolbar',
  imports: [MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule, TranslocoPipe],
  template: `
    <div class="bar" role="toolbar" [attr.aria-label]="'editor.toolbar' | transloco">
      <button mat-icon-button type="button" (click)="editor().chain().focus().undo().run()" [disabled]="!editor().can().undo()" [matTooltip]="'editor.undo' | transloco"><mat-icon>undo</mat-icon></button>
      <button mat-icon-button type="button" (click)="editor().chain().focus().redo().run()" [disabled]="!editor().can().redo()" [matTooltip]="'editor.redo' | transloco"><mat-icon>redo</mat-icon></button>
      <span class="sep"></span>

      <button mat-button type="button" class="blocktype" [matMenuTriggerFor]="blockMenu">{{ blockLabel() | transloco }}<mat-icon iconPositionEnd>arrow_drop_down</mat-icon></button>
      <mat-menu #blockMenu="matMenu">
        @for (i of blockItems(); track i.id) { <button mat-menu-item type="button" (click)="i.run(editor())"><mat-icon>{{ i.icon }}</mat-icon>{{ i.labelKey | transloco }}</button> }
      </mat-menu>

      <button mat-flat-button type="button" class="insert" [matMenuTriggerFor]="insertMenu"><mat-icon>add</mat-icon>{{ 'editor.insert' | transloco }}</button>
      <mat-menu #insertMenu="matMenu">
        @for (i of items(); track i.id) {
          @if (isInsertable(i.id)) { <button mat-menu-item type="button" (click)="i.run(editor())"><mat-icon>{{ i.icon }}</mat-icon>{{ i.labelKey | transloco }}</button> }
        }
      </mat-menu>
      <span class="sep"></span>

      @for (b of marks; track b.mark) {
        <button mat-icon-button type="button" [class.on]="on(b.mark)" (click)="b.run(editor())" [matTooltip]="b.label | transloco" [attr.aria-pressed]="on(b.mark)"><mat-icon>{{ b.icon }}</mat-icon></button>
      }
      <button mat-icon-button type="button" [class.on]="on('link')" (click)="link.emit()" [matTooltip]="'editor.link' | transloco"><mat-icon>link</mat-icon></button>
      <button mat-icon-button type="button" [matMenuTriggerFor]="colorMenu" [matTooltip]="'editor.textColor' | transloco"><mat-icon>format_color_text</mat-icon></button>
      <mat-menu #colorMenu="matMenu" class="swatch-menu">
        <div class="swatches" (click)="$event.stopPropagation()">
          <button type="button" class="swatch none" (click)="editor().chain().focus().unsetColor().run()" [attr.aria-label]="'editor.defaultColor' | transloco">∅</button>
          @for (c of colors; track c) { <button type="button" class="swatch" [style.background]="c" (click)="editor().chain().focus().setColor(c).run()" [attr.aria-label]="c"></button> }
        </div>
      </mat-menu>
      <button mat-icon-button type="button" [class.on]="on('highlight')" [matMenuTriggerFor]="highlightMenu" [matTooltip]="'editor.highlight' | transloco"><mat-icon>border_color</mat-icon></button>
      <mat-menu #highlightMenu="matMenu" class="swatch-menu">
        <div class="swatches" (click)="$event.stopPropagation()">
          <button type="button" class="swatch none" (click)="editor().chain().focus().unsetHighlight().run()" [attr.aria-label]="'editor.noHighlight' | transloco">∅</button>
          @for (c of highlights; track c) { <button type="button" class="swatch" [style.background]="c" (click)="editor().chain().focus().setHighlight({ color: c }).run()" [attr.aria-label]="c"></button> }
        </div>
      </mat-menu>
      <span class="sep"></span>

      @for (b of lists; track b.mark) {
        <button mat-icon-button type="button" [class.on]="on(b.mark)" (click)="b.run(editor())" [matTooltip]="b.label | transloco"><mat-icon>{{ b.icon }}</mat-icon></button>
      }
      <button mat-icon-button type="button" [matMenuTriggerFor]="alignMenu" [matTooltip]="'editor.align' | transloco"><mat-icon>format_align_left</mat-icon></button>
      <mat-menu #alignMenu="matMenu">
        @for (a of aligns; track a.value) { <button mat-menu-item type="button" (click)="editor().chain().focus().setTextAlign(a.value).run()"><mat-icon>{{ a.icon }}</mat-icon>{{ a.label | transloco }}</button> }
      </mat-menu>

      @if (on('table')) {
        <span class="sep"></span>
        <button mat-button type="button" [matMenuTriggerFor]="tableMenu"><mat-icon>table_chart</mat-icon>{{ 'editor.table' | transloco }}</button>
        <mat-menu #tableMenu="matMenu">
          @for (t of tableOps; track t.label) { <button mat-menu-item type="button" (click)="t.run(editor())">{{ t.label | transloco }}</button> }
        </mat-menu>
      }
    </div>
  `,
  styles: `
    /* Wraps onto a second row on narrow screens: every button, Insert especially, must stay reachable. */
    .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; padding: 4px 6px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-2); }
    .bar > * { flex: none; }
    .insert { margin-left: 4px; }
    .sep { width: 1px; height: 22px; background: var(--border); margin: 0 6px; }
    .on { color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
    .blocktype { min-width: 120px; justify-content: space-between; }
    .swatches { display: grid; grid-template-columns: repeat(5, 28px); gap: 6px; padding: 10px; }
    .swatch { width: 28px; height: 28px; border-radius: 50%; border: 2px solid var(--surface); box-shadow: 0 0 0 1px var(--border); cursor: pointer; }
    .swatch.none { background: var(--surface); color: var(--text-dim); }
  `,
})
export class Toolbar {
  readonly editor = input.required<Editor>();
  readonly items = input.required<SlashItem[]>();
  readonly link = output<void>();

  private readonly tick = signal(0);
  readonly colors = COLORS;
  readonly highlights = HIGHLIGHTS;

  readonly marks: MarkButton[] = [
    { icon: 'format_bold', mark: 'bold', label: 'editor.bold', run: (e) => e.chain().focus().toggleBold().run() },
    { icon: 'format_italic', mark: 'italic', label: 'editor.italic', run: (e) => e.chain().focus().toggleItalic().run() },
    { icon: 'format_underlined', mark: 'underline', label: 'editor.underline', run: (e) => e.chain().focus().toggleUnderline().run() },
    { icon: 'strikethrough_s', mark: 'strike', label: 'editor.strike', run: (e) => e.chain().focus().toggleStrike().run() },
    { icon: 'code', mark: 'code', label: 'editor.inlineCode', run: (e) => e.chain().focus().toggleCode().run() },
    { icon: 'subscript', mark: 'subscript', label: 'editor.subscript', run: (e) => e.chain().focus().toggleSubscript().run() },
    { icon: 'superscript', mark: 'superscript', label: 'editor.superscript', run: (e) => e.chain().focus().toggleSuperscript().run() },
  ];
  readonly lists: MarkButton[] = [
    { icon: 'format_list_bulleted', mark: 'bulletList', label: 'editor.cmd.bulletList', run: (e) => e.chain().focus().toggleBulletList().run() },
    { icon: 'format_list_numbered', mark: 'orderedList', label: 'editor.cmd.orderedList', run: (e) => e.chain().focus().toggleOrderedList().run() },
    { icon: 'checklist', mark: 'taskList', label: 'editor.cmd.taskList', run: (e) => e.chain().focus().toggleTaskList().run() },
    { icon: 'format_quote', mark: 'blockquote', label: 'editor.cmd.blockquote', run: (e) => e.chain().focus().toggleBlockquote().run() },
  ];
  readonly aligns = [
    { value: 'left', icon: 'format_align_left', label: 'editor.alignLeft' },
    { value: 'center', icon: 'format_align_center', label: 'editor.alignCenter' },
    { value: 'right', icon: 'format_align_right', label: 'editor.alignRight' },
    { value: 'justify', icon: 'format_align_justify', label: 'editor.alignJustify' },
  ];
  readonly tableOps = [
    { label: 'editor.tableOps.addRowBefore', run: (e: Editor) => e.chain().focus().addRowBefore().run() },
    { label: 'editor.tableOps.addRowAfter', run: (e: Editor) => e.chain().focus().addRowAfter().run() },
    { label: 'editor.tableOps.deleteRow', run: (e: Editor) => e.chain().focus().deleteRow().run() },
    { label: 'editor.tableOps.addColumnBefore', run: (e: Editor) => e.chain().focus().addColumnBefore().run() },
    { label: 'editor.tableOps.addColumnAfter', run: (e: Editor) => e.chain().focus().addColumnAfter().run() },
    { label: 'editor.tableOps.deleteColumn', run: (e: Editor) => e.chain().focus().deleteColumn().run() },
    { label: 'editor.tableOps.toggleHeader', run: (e: Editor) => e.chain().focus().toggleHeaderRow().run() },
    { label: 'editor.tableOps.mergeSplit', run: (e: Editor) => e.chain().focus().mergeOrSplit().run() },
    { label: 'editor.tableOps.deleteTable', run: (e: Editor) => e.chain().focus().deleteTable().run() },
  ];

  /** Turning the current block into a paragraph or heading, shown in the drop-down. */
  readonly blockItems = computed(() => this.items().filter((i) => ['paragraph', 'h1', 'h2', 'h3', 'codeBlock'].includes(i.id)));
  private static readonly INSERT_ONLY = new Set(['paragraph', 'h1', 'h2', 'h3', 'bulletList', 'orderedList', 'taskList', 'blockquote']);

  constructor() {
    effect((onCleanup) => {
      const ed = this.editor();
      const bump = () => this.tick.update((n) => n + 1);
      ed.on('transaction', bump);
      onCleanup(() => ed.off('transaction', bump));
    });
  }

  /** Reading `tick` makes templates re-evaluate whenever the selection or document changes. */
  on(name: string): boolean {
    this.tick();
    return this.editor().isActive(name);
  }

  isInsertable(id: string): boolean {
    return !Toolbar.INSERT_ONLY.has(id);
  }

  blockLabel(): string {
    this.tick();
    const e = this.editor();
    if (e.isActive('heading', { level: 1 })) return 'editor.cmd.h1';
    if (e.isActive('heading', { level: 2 })) return 'editor.cmd.h2';
    if (e.isActive('heading', { level: 3 })) return 'editor.cmd.h3';
    if (e.isActive('codeBlock')) return 'editor.cmd.codeBlock';
    return 'editor.cmd.paragraph';
  }
}
