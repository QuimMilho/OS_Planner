import { Component, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { AngularNodeViewComponent } from 'ngx-tiptap';
import { LIMITS } from '@notes/shared';
import { ThemeService } from '../../../core/theme';
import { renderMermaid } from '../lazy-libs';

let counter = 0;

@Component({
  selector: 'app-mermaid-view',
  imports: [MatIconModule, TranslocoPipe],
  host: { class: 'node-view' },
  template: `
    <div class="box" [class.selected]="selected()">
      <div class="preview" #preview></div>
      @if (busy()) { <div class="hint">{{ 'editor.rendering' | transloco }}</div> }
      @if (error()) { <pre class="err">{{ error() }}</pre> }
      @if (selected()) {
        <div class="editor" contenteditable="false">
          <label class="lbl"><mat-icon>account_tree</mat-icon> {{ 'editor.mermaidSource' | transloco }}
            <a href="https://mermaid.js.org/intro/" target="_blank" rel="noopener noreferrer">{{ 'editor.syntaxHelp' | transloco }}</a>
          </label>
          <textarea rows="8" spellcheck="false" [maxLength]="max" [value]="code()" (input)="set($any($event.target).value)"></textarea>
        </div>
      }
    </div>
  `,
  styles: `
    :host { display: block; margin: 0.8em 0; }
    .box { border: 1px solid transparent; border-radius: 10px; padding: 8px; text-align: center; }
    .selected { border-color: var(--accent); }
    .preview { overflow-x: auto; min-height: 40px; }
    .hint { color: var(--text-dim); font-size: 13px; }
    .err { text-align: left; white-space: pre-wrap; color: var(--mat-sys-error); background: color-mix(in srgb, var(--mat-sys-error) 8%, var(--surface)); padding: 8px 12px; border-radius: 8px; font-size: 12px; }
    .editor { text-align: left; margin-top: 8px; }
    .lbl { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-dim); margin-bottom: 4px; }
    .lbl a { margin-left: auto; }
    textarea { width: 100%; font: 13px/1.5 'Cascadia Mono', Consolas, monospace; padding: 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); color: var(--text); resize: vertical; }
  `,
})
export class MermaidView extends AngularNodeViewComponent {
  readonly max = LIMITS.mermaidMax;
  readonly code = computed(() => String(this.node().attrs['code'] ?? ''));
  readonly error = signal('');
  readonly busy = signal(false);
  private readonly preview = viewChild<ElementRef<HTMLElement>>('preview');
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly id = `mermaid-${++counter}`;

  private readonly theme = inject(ThemeService);

  constructor() {
    super();
    effect((onCleanup) => {
      const el = this.preview()?.nativeElement;
      const code = this.code();
      this.theme.scheme(); // Mermaid has a light and a dark look: draw again when the scheme changes
      if (!el) return;
      // Typing fires many changes: draw once the text has been still for a moment.
      this.timer = setTimeout(() => void untracked(() => this.draw(el, code)), 250);
      onCleanup(() => this.timer && clearTimeout(this.timer));
    });
  }

  private async draw(el: HTMLElement, code: string): Promise<void> {
    this.busy.set(true);
    try {
      el.innerHTML = await renderMermaid(`${this.id}-${Date.now()}`, code); // 'strict' mode: mermaid sanitises its own output
      // Keep the size mermaid chose (its inline max-width); only make sure it scales down on narrow screens.
      const svg = el.querySelector('svg');
      if (svg) svg.style.height = 'auto';
      this.error.set('');
    } catch (e) {
      console.warn('mermaid render failed', e);
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.set(false);
    }
  }

  set(code: string): void {
    this.updateAttributes()({ code });
  }
}
